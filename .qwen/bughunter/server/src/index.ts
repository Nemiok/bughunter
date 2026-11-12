import { resolve } from 'node:path';

import { cliInstallHint } from './cli-host.ts';

const missingDependenciesMessage = `Зависимости Bughunter не установлены. Выполните: ${cliInstallHint()}`;

function supportsCurrentRuntime(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 18);
}

class ToolError extends Error {}

function errorCode(error: unknown): { code: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ToolError) return { code: error.message.split(':')[0] ?? 'TOOL_FAILED', message };
  if (message.startsWith('CONFIG_INVALID:') || message.startsWith('CONFIG_NOT_FOUND:')) {
    return { code: 'CONFIG_INVALID', message };
  }
  if (message === 'LIMIT_REACHED') return { code: 'LIMIT_REACHED', message };
  if (message === 'FORBIDDEN_ACTION' || message === 'FORM_SUBMISSION_BLOCKED') {
    return { code: 'FORBIDDEN_ACTION', message };
  }
  if (message.startsWith('CANDIDATE_UNREPRODUCED:')) return { code: 'CANDIDATE_UNREPRODUCED', message };
  if (message.startsWith('RUN_INCOMPLETE:')) return { code: 'RUN_INCOMPLETE', message };
  if (/^LEASE_(REQUIRED|UNKNOWN|MISMATCH):/.test(message)) return { code: message.split(':')[0] ?? 'LEASE_UNKNOWN', message };
  if (/^(POINT_TARGET_UNRESOLVED|DRAG_TARGET_REQUIRED|SCROLL_INVALID|UPLOAD_FILE_NOT_FOUND)\b/.test(message)) {
    return { code: message.split(':')[0] ?? 'TOOL_FAILED', message };
  }
  if (message.includes('NOT_FOUND:')) return { code: 'NOT_FOUND', message };
  if (message === 'NAVIGATION_NOT_ALLOWED' || message.startsWith('NAVIGATION_NOT_ALLOWED:') || message === 'FORBIDDEN_ORIGIN') {
    return { code: 'FORBIDDEN_ORIGIN', message };
  }
  return { code: 'TOOL_FAILED', message };
}

async function main(): Promise<void> {
  if (!supportsCurrentRuntime()) {
    throw new Error(`Для Bughunter требуется Node.js ≥22.18. Текущая версия: ${process.version}`);
  }

  let sdk: typeof import('@modelcontextprotocol/sdk/server/mcp.js');
  let stdio: typeof import('@modelcontextprotocol/sdk/server/stdio.js');
  let zod: typeof import('zod');
  try {
    [sdk, stdio, zod] = await Promise.all([
      import('@modelcontextprotocol/sdk/server/mcp.js'),
      import('@modelcontextprotocol/sdk/server/stdio.js'),
      import('zod'),
    ]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') {
      console.error(missingDependenciesMessage);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const { ensureConfig, loadConfig } = await import('./config.ts');
  const { findProjectRoot } = await import('./project.ts');
  const {
    completeExplorationLease, createRun, finishRun, leaseNextExploration, readRun, reclaimExplorationLeases,
    recordCandidateTest, recordRouteExploration, recordRunStage, releaseExplorationLease, resumeRun, triageCandidate,
    validateExplorationLease,
  } = await import('./run-store.ts');
  const { reproduceCandidate } = await import('./reproduce.ts');
  const { exportE2e } = await import('./export/playwright.ts');
  const { detectTests } = await import('./tests/detect.ts');
  const { verifyRed } = await import('./tests/verify-red.ts');
  const { SessionManager } = await import('./browser/session.ts');
  const { loadProfile } = await import('./profile/load.ts');
  const { z } = zod;
  const stateDir = process.env.BUGHUNTER_STATE_DIR
    ? resolve(process.env.BUGHUNTER_STATE_DIR)
    : resolve(import.meta.dirname, '../../state');
  let managerPromise: Promise<InstanceType<typeof SessionManager>> | undefined;
  const explorations = new Map<string, { runId: string; route: string; leaseId?: string }>();
  const activeExplorerRuns = new Set<string>();
  const explorationQueueLocks = new Map<string, Promise<unknown>>();

  // Серилизация read-modify-write очереди исследования внутри одного серверного процесса.
  async function withExplorationQueueLock<T>(id: string, callback: () => Promise<T>): Promise<T> {
    const previous = explorationQueueLocks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    explorationQueueLocks.set(id, tail);
    await previous;
    try {
      return await callback();
    } finally {
      release();
      if (explorationQueueLocks.get(id) === tail) explorationQueueLocks.delete(id);
    }
  }

  // Lease, за которыми стоят живые сессии этого процесса: reclaim их не трогает.
  function liveLeaseIds(id: string): Set<string> {
    const leases = new Set<string>();
    for (const exploration of explorations.values()) {
      if (exploration.runId === id && exploration.leaseId !== undefined) leases.add(exploration.leaseId);
    }
    return leases;
  }

  async function manager(): Promise<InstanceType<typeof SessionManager>> {
    managerPromise ??= loadConfig(stateDir).then(async (config) => new SessionManager(
      config,
      stateDir,
      config.profile === undefined ? null : await loadProfile(stateDir, config.profile),
    ));
    try {
      return await managerPromise;
    } catch (error) {
      managerPromise = undefined;
      throw error;
    }
  }

  function result(value: unknown) {
    return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
  }

  function failure(error: unknown) {
    const value = errorCode(error);
    return { ...result(value), isError: true };
  }

  async function invoke(callback: () => Promise<unknown>) {
    try {
      return result(await callback());
    } catch (error) {
      return failure(error);
    }
  }

  function compactState(value: Awaited<ReturnType<InstanceType<typeof SessionManager>['state']>>) {
    return {
      ...value,
      elements: value.elements.map(({ locator: _locator, ...element }) => element),
    };
  }

  async function runOperation<T>(
    id: string,
    stage: Parameters<typeof recordRunStage>[1],
    callback: () => Promise<T>,
  ): Promise<T> {
    await recordRunStage(id, stage, 'running', stateDir);
    try {
      const value = await callback();
      await recordRunStage(id, stage, 'done', stateDir);
      return value;
    } catch (error) {
      await recordRunStage(id, stage, 'failed', stateDir);
      throw error;
    }
  }

  const server = new sdk.McpServer({ name: 'bughunter', version: '0.1.0' });
  const runId = z.string().min(1);
  const sessionId = z.string().min(1);
  const signalIds = z.array(z.string().min(1));

  server.registerTool('bh_start_run', {
    description: 'Создать прогон проверки приложения',
    inputSchema: z.strictObject({
      scope: z.enum(['diff', 'full', 'route']),
      route: z.string().startsWith('/').optional(),
    }),
  }, async ({ scope, route }) => invoke(async () => {
    const ensured = await ensureConfig(stateDir);
    if (ensured.createdPath) throw new ToolError(`CONFIG_CREATED: ${ensured.createdPath}`);
    const projectRoot = await findProjectRoot();
    const run = await createRun(scope, route, { config: ensured.config!, projectRoot, stateDir });
    return { runId: run.id, routes: run.routes };
  }));

  server.registerTool('bh_resume_run', {
    description: 'Прочитать состояние существующего прогона',
    inputSchema: z.strictObject({ runId }),
  }, async ({ runId: id }) => invoke(async () => {
    // Прерванные исследователи не вызывают bh_close: их lease возвращается в очередь здесь.
    await withExplorationQueueLock(id, () => reclaimExplorationLeases(id, stateDir, liveLeaseIds(id)));
    const { run, pendingCandidates } = await resumeRun(id, stateDir);
    return {
      runId: run.id,
      stages: run.stages,
      candidates: pendingCandidates.map((candidate) => ({
        candidateId: candidate.id, title: candidate.title, status: candidate.status,
      })),
    };
  }));

  server.registerTool('bh_explore_next', {
    description: 'Получить следующую задачу исследования: маршрут, персону и lease для bh_open',
    inputSchema: z.strictObject({ runId, route: z.string().min(1).optional() }),
  }, async ({ runId: id, route }) => invoke(() => withExplorationQueueLock(id, () =>
    leaseNextExploration(id, { ...(route === undefined ? {} : { route }), keepLeaseIds: liveLeaseIds(id) }, stateDir),
  )));

  server.registerTool('bh_finish_run', {
    description: 'Записать отчёт и завершить существующий прогон',
    inputSchema: z.strictObject({ runId }),
  }, async ({ runId: id }) => invoke(() => finishRun(id, stateDir)));

  server.registerTool('bh_open', {
    description: 'Открыть маршрут в новой браузерной сессии',
    inputSchema: z.strictObject({
      runId, route: z.string().min(1), persona: z.string().min(1), leaseId: z.string().min(1).optional(),
    }),
  }, async ({ runId: id, route, persona, leaseId }) => invoke(async () => {
    if (activeExplorerRuns.has(id)) throw new ToolError(`EXPLORER_BUSY: ${id}`);
    activeExplorerRuns.add(id);
    let validatedLease: string | undefined;
    try {
      const run = await readRun(id, stateDir);
      if (run.exploreQueue) {
        if (leaseId === undefined) throw new ToolError(`LEASE_REQUIRED: ${id}`);
        await validateExplorationLease(id, leaseId, route, persona, stateDir);
        validatedLease = leaseId;
      }
      const opened = await (await manager()).open(id, route, persona);
      try {
        await recordRouteExploration(id, route, 'exploring', stateDir);
        explorations.set(opened.sessionId, { runId: id, route, ...(validatedLease === undefined ? {} : { leaseId: validatedLease }) });
        return opened;
      } catch (error) {
        await (await manager()).close(opened.sessionId).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      // Открытие не состоялось — задача возвращается в очередь для повторной выдачи.
      if (validatedLease !== undefined) {
        const leaseToRelease = validatedLease;
        await withExplorationQueueLock(id, () => releaseExplorationLease(id, leaseToRelease, stateDir)).catch(() => undefined);
      }
      activeExplorerRuns.delete(id);
      throw error;
    }
  }));

  server.registerTool('bh_state', {
    description: 'Получить элементы страницы (отранжированы, отдаются страницами по cursor), структуру экрана по экстракторам профиля и новые сигналы',
    inputSchema: z.strictObject({
      sessionId,
      cursor: z.number().int().nonnegative().optional(),
      limit: z.number().int().positive().max(2000).optional(),
    }),
  }, async ({ sessionId: id, cursor, limit }) => invoke(async () => {
    const session = await manager();
    return compactState(await session.state(id, {
      screen: true,
      limit: limit ?? session.snapshotLimit,
      ...(cursor === undefined ? {} : { cursor }),
    }));
  }));

  server.registerTool('bh_act', {
    description: 'Выполнить одно действие: с элементом страницы (click, dblclick, fill, select, press, check, hover, drag, scroll, upload) или по координате точки (clickAt, hoverAt — для canvas и других целей без DOM-семантики)',
    inputSchema: z.strictObject({
      sessionId,
      elementId: z.string().min(1).optional(),
      action: z.enum([
        'click', 'dblclick', 'fill', 'select', 'press', 'check', 'hover',
        'drag', 'scroll', 'clickAt', 'hoverAt', 'upload',
      ]),
      value: z.string().optional(),
      toElementId: z.string().min(1).optional(),
      at: z.strictObject({ x: z.number(), y: z.number() }).optional(),
      file: z.string().min(1).optional(),
      scroll: z.strictObject({ direction: z.enum(['up', 'down', 'left', 'right']), delta: z.number() }).optional(),
    }),
  }, async ({ sessionId: id, elementId, action, value, toElementId, at, file, scroll }) => {
    const response = await invoke(async () => (await manager()).act(id, {
      action,
      ...(elementId === undefined ? {} : { elementId }),
      ...(value === undefined ? {} : { value }),
      ...(toElementId === undefined ? {} : { toElementId }),
      ...(at === undefined ? {} : { at }),
      ...(file === undefined ? {} : { file }),
      ...(scroll === undefined ? {} : { scroll }),
    }));
    const text = response.content[0]?.text;
    if (text) {
      const value = JSON.parse(text) as { ok?: boolean; error?: string };
      if (value.ok === false && value.error) {
        const known = errorCode(new Error(value.error));
        if (known.code !== 'TOOL_FAILED') return { ...result(known), isError: true };
      }
    }
    return response;
  });

  server.registerTool('bh_navigate', {
    description: 'Перейти по разрешённому пути в текущей сессии',
    inputSchema: z.strictObject({ sessionId, path: z.string().min(1) }),
  }, async ({ sessionId: id, path }) => invoke(async () => {
    const session = await manager();
    return compactState(await session.navigate(id, path, { screen: true, limit: session.snapshotLimit }));
  }));

  server.registerTool('bh_probe', {
    description: 'Проверить перезагрузку, возврат или мобильный viewport',
    inputSchema: z.strictObject({ sessionId, kind: z.enum(['reload', 'back', 'mobile_viewport']) }),
  }, async ({ sessionId: id, kind }) => invoke(async () => {
    const session = await manager();
    return compactState(await session.probe(id, kind, { screen: true, limit: session.snapshotLimit }));
  }));

  server.registerTool('bh_report_candidate', {
    description: 'Сохранить кандидата в баги с сигналами и журналом',
    inputSchema: z.strictObject({
      sessionId,
      title: z.string().min(1),
      expected: z.string().min(1),
      actual: z.string().min(1),
      signalIds,
      check: z.strictObject({
        kind: z.enum(['visibleText', 'notVisibleText', 'elementCount']),
        target: z.string().min(1),
        expected: z.union([z.string(), z.number()]).optional(),
      }).optional(),
    }),
  }, async ({ sessionId: id, ...input }) => invoke(async () => (await manager()).reportCandidate(id, input)));

  server.registerTool('bh_reproduce', {
    description: 'Воспроизвести кандидата в чистом контексте и минимизировать шаги',
    inputSchema: z.strictObject({
      runId,
      candidateId: z.string().min(1),
      attempts: z.number().int().min(1).max(3).default(3),
    }),
  }, async ({ runId: id, candidateId, attempts }) => invoke(() => runOperation(id, 'reproduce', () =>
    reproduceCandidate({ runId: id, candidateId, attempts, stateDir }),
  )));

  server.registerTool('bh_triage', {
    description: 'Подтвердить, отклонить или связать кандидата с известным багом',
    inputSchema: z.strictObject({
      runId,
      candidateId: z.string().min(1),
      verdict: z.enum(['confirmed', 'rejected', 'duplicate']),
      reason: z.string().min(1),
      suppress: z.boolean().optional(),
    }),
  }, async ({ runId: id, candidateId, verdict, reason, suppress }) => invoke(() => runOperation(id, 'triage', () =>
    triageCandidate({ runId: id, candidateId, verdict, reason, ...(suppress === undefined ? {} : { suppress }), stateDir }),
  )));

  server.registerTool('bh_export_e2e', {
    description: 'Экспортировать воспроизведённый подтверждённый баг в Playwright-тест',
    inputSchema: z.strictObject({ runId, bugId: z.string().min(1) }),
  }, async ({ runId: id, bugId }) => invoke(() => runOperation(id, 'export', () =>
    exportE2e({ runId: id, bugId, stateDir }),
  )));

  server.registerTool('bh_detect_tests', {
    description: 'Определить Jest или Vitest и найти соседние примеры тестов',
    inputSchema: z.strictObject({ path: z.string().min(1) }),
  }, async ({ path }) => invoke(async () => {
    const config = await loadConfig(stateDir);
    return detectTests(path, { unitCommand: config.tests.unit.command });
  }));

  server.registerTool('bh_verify_red', {
    description: 'Проверить один тестовый файл и получить вердикт red, green или broken',
    inputSchema: z.strictObject({
      testFile: z.string().min(1),
      runId: runId.optional(),
      candidateId: z.string().min(1).optional(),
      kind: z.enum(['e2e', 'unit']).optional(),
    }),
  }, async ({ testFile, runId: id, candidateId, kind }) => invoke(async () => {
    if ((id === undefined) !== (candidateId === undefined)) throw new Error('TEST_ASSOCIATION_INCOMPLETE');
    const absoluteTestFile = resolve(testFile);
    const config = await loadConfig(stateDir);
    const verdict = await verifyRed(absoluteTestFile, {
      unitCommand: config.tests.unit.command,
      ...(kind === undefined ? {} : { kind }),
    });
    if (id !== undefined && candidateId !== undefined) {
      await recordCandidateTest(id, candidateId, kind ?? 'unit', absoluteTestFile, stateDir);
      await recordRunStage(id, 'export', 'done', stateDir);
    }
    return verdict;
  }));

  server.registerTool('bh_close', {
    description: 'Закрыть сессию и сохранить артефакты',
    inputSchema: z.strictObject({ sessionId }),
  }, async ({ sessionId: id }) => invoke(async () => {
    const exploration = explorations.get(id);
    let leaseSettled = false;
    try {
      await (await manager()).close(id);
      if (exploration) {
        await recordRouteExploration(exploration.runId, exploration.route, 'done', stateDir);
        if (exploration.leaseId !== undefined) {
          await withExplorationQueueLock(exploration.runId, () =>
            completeExplorationLease(exploration.runId, exploration.leaseId!, stateDir),
          );
          leaseSettled = true;
        }
      }
      return { ok: true };
    } finally {
      if (exploration) {
        // Закрытие не удалось — задача не считается выполненной и возвращается в очередь.
        if (exploration.leaseId !== undefined && !leaseSettled) {
          await withExplorationQueueLock(exploration.runId, () =>
            releaseExplorationLease(exploration.runId, exploration.leaseId!, stateDir),
          ).catch(() => undefined);
        }
        activeExplorerRuns.delete(exploration.runId);
        explorations.delete(id);
      }
    }
  }));

  const transport = new stdio.StdioServerTransport();
  const shutdown = async () => {
    const active = managerPromise ? await managerPromise.catch(() => undefined) : undefined;
    await active?.closeAll().catch(() => undefined);
    await server.close().catch(() => undefined);
  };
  process.once('SIGINT', () => { void shutdown().finally(() => { process.exitCode = 130; }); });
  process.once('SIGTERM', () => { void shutdown().finally(() => { process.exitCode = 143; }); });
  await server.connect(transport);
}

main().catch((error: unknown) => {
  if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') {
    console.error(missingDependenciesMessage);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});
