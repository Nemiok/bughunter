import { resolve } from 'node:path';

import { webCheckKinds } from './checks.ts';
import { errorCode, ToolError } from './errors.ts';
import { defaultStateDir } from './paths.ts';
import { webSnapshot } from './snapshot.ts';
import type { SessionManager } from './browser/session.ts';

const missingDependenciesMessage = 'Зависимости Bughunter недоступны. Переустановите плагин или выполните npm ci в workspace Bughunter.';

function supportsCurrentRuntime(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 18);
}

async function main(): Promise<void> {
  if (!supportsCurrentRuntime()) {
    throw new Error(`Для Bughunter требуется Node.js ≥22.18. Текущая версия: ${process.version}`);
  }

  let sdk: typeof import('@modelcontextprotocol/sdk/server/mcp.js');
  let stdio: typeof import('@modelcontextprotocol/sdk/server/stdio.js');
  let zod: typeof import('zod');
  let core: typeof import('@bughunter/core');
  try {
    [sdk, stdio, zod, core] = await Promise.all([
      import('@modelcontextprotocol/sdk/server/mcp.js'),
      import('@modelcontextprotocol/sdk/server/stdio.js'),
      import('zod'),
      import('@bughunter/core'),
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
  const { findProjectRoot } = core;
  const {
    readRun, recordCandidateTest, recordRunStage, resumeRun, triageCandidate,
  } = await import('@bughunter/core');
  const {
    createRun, finishRun, leaseNextExploration, promoteFindingToCandidate,
  } = await import('./runs.ts');
  const { reproduceCandidate } = await import('./reproduce.ts');
  const { exportTest } = await import('./export-playwright.ts');
  const { detectWebTests, verifyWebRed, webTestKinds } = await import('./test-runner.ts');
  const { resolveLaunchOptions } = await import('./browser/session.ts');
  const { activeSessionManager, sessionManager } = await import('./session-handle.ts');
  const { loadProfile } = await import('./profile/load.ts');
  const { crawlScreens, defaultMaxDepth, defaultMaxScreens } = await import('./discovery/crawl.ts');
  const { runSweep } = await import('./sweep-visit.ts');
  const { webPreset } = await import('./preset.ts');
  const { createLifecycle } = core;
  const { z } = zod;
  const stateDir = process.env.BUGHUNTER_STATE_DIR
    ? resolve(process.env.BUGHUNTER_STATE_DIR)
    : defaultStateDir;
  core.assertPreset(webPreset);
  await core.assertSinglePreset(stateDir, webPreset.name);
  let contextPromise: ReturnType<typeof loadContext> | undefined;
  // Порядок lease-вызовов принадлежит core: он один на все пресеты и им доказан resume-гейт.
  const lifecycle = createLifecycle({
    stateDir,
    personas: webPreset.personas.roster,
    // Сессию открывает адаптер контракта, а не точка входа напрямую: менеджер и браузер остаются
    // общими с остальными инструментами пресета.
    open: async ({ runId, target, persona }) => {
      const handle = await webPreset.session.open({ runId, target, persona, stateDir });
      return { sessionId: handle.id, payload: { sessionId: handle.id } };
    },
    close: async (sessionId) => {
      await (await manager()).close(sessionId);
    },
  });

  async function loadContext() {
    const config = await loadConfig(stateDir);
    return { config, profile: config.profile === undefined ? null : await loadProfile(stateDir, config.profile) };
  }

  // Конфиг и профиль нужны не только сессиям (bh_crawl работает без сессии), поэтому кэш отдельный.
  async function appContext(): ReturnType<typeof loadContext> {
    contextPromise ??= loadContext();
    try {
      return await contextPromise;
    } catch (error) {
      contextPromise = undefined;
      throw error;
    }
  }

  async function manager(): Promise<SessionManager> {
    return sessionManager(stateDir);
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

  // Что отдавать модели из снимка — знание пресета: сервер только вызывает хук.
  const compactState = webSnapshot.compact;

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
    description: 'Создать прогон проверки приложения: diff/full/target исследует модель, sweep (весь инвентарь или один шаблон экрана) обходится детерминированно через bh_sweep',
    inputSchema: z.strictObject({
      scope: z.enum(['diff', 'full', 'target', 'sweep']),
      target: z.string().startsWith('/').optional(),
    }),
  }, async ({ scope, target }) => invoke(async () => {
    const ensured = await ensureConfig(stateDir);
    if (ensured.createdPath) throw new ToolError(`CONFIG_CREATED: ${ensured.createdPath}`);
    const projectRoot = await findProjectRoot();
    const run = await createRun(scope, target, { config: ensured.config!, projectRoot, stateDir });
    return { runId: run.id, targets: run.targets };
  }));

  server.registerTool('bh_resume_run', {
    description: 'Прочитать состояние существующего прогона',
    inputSchema: z.strictObject({ runId }),
  }, async ({ runId: id }) => invoke(async () => {
    // Прерванные исследователи не вызывают bh_close: их lease возвращается в очередь здесь.
    await lifecycle.reclaim(id);
    const { run, pendingCandidates } = await resumeRun(id, stateDir, webPreset.exportTarget.kind);
    return {
      runId: run.id,
      stages: run.stages,
      candidates: pendingCandidates.map((candidate) => ({
        candidateId: candidate.id, title: candidate.title, status: candidate.status,
      })),
    };
  }));

  server.registerTool('bh_explore_next', {
    description: 'Получить следующую задачу исследования: цель, персону и lease для bh_open',
    inputSchema: z.strictObject({ runId, target: z.string().min(1).optional() }),
  }, async ({ runId: id, target }) => invoke(() =>
    lifecycle.leaseNext(id, target === undefined ? {} : { target })));

  server.registerTool('bh_finish_run', {
    description: 'Записать отчёт и завершить существующий прогон',
    inputSchema: z.strictObject({ runId }),
  }, async ({ runId: id }) => invoke(() => finishRun(id, stateDir)));

  server.registerTool('bh_open', {
    description: 'Открыть маршрут в новой браузерной сессии',
    inputSchema: z.strictObject({
      runId, target: z.string().min(1), persona: z.string().min(1), leaseId: z.string().min(1).optional(),
    }),
  }, async ({ runId: id, target, persona, leaseId }) => invoke(async () => {
    const opened = await lifecycle.open({
      runId: id,
      target,
      persona,
      ...(leaseId === undefined ? {} : { leaseId }),
    });
    return opened.payload;
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
    description: 'Выполнить одно действие: с элементом страницы (click, dblclick, fill, select, press, check, hover, drag, scroll, upload) или по координате точки (clickAt, hoverAt — для canvas и других целей без DOM-семантики). dialog: \'accept\' подтверждает нативный диалог (confirm/alert/prompt) этого действия; по умолчанию \'dismiss\'; каждый диалог возвращается в dialogs и сигналом kind=dialog',
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
      dialog: z.enum(['accept', 'dismiss']).optional(),
    }),
  }, async ({ sessionId: id, elementId, action, value, toElementId, at, file, scroll, dialog }) => {
    const response = await invoke(async () => (await manager()).act(id, {
      action,
      ...(elementId === undefined ? {} : { elementId }),
      ...(value === undefined ? {} : { value }),
      ...(toElementId === undefined ? {} : { toElementId }),
      ...(at === undefined ? {} : { at }),
      ...(file === undefined ? {} : { file }),
      ...(scroll === undefined ? {} : { scroll }),
      ...(dialog === undefined ? {} : { dialog }),
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

  server.registerTool('bh_crawl', {
    description: 'Обойти разрешённые экраны приложения и пополнить инвентарь state/screens.json: динамические сегменты приводятся к шаблону, для каждого экрана сохраняется список виджетов профиля, чужие и недоступные переходы записываются в blocked',
    inputSchema: z.strictObject({
      maxScreens: z.number().int().positive().max(5000).optional(),
      maxDepth: z.number().int().nonnegative().max(10).optional(),
      startPaths: z.array(z.string().min(1).startsWith('/')).min(1).max(50).optional(),
    }),
  }, async ({ maxScreens, maxDepth, startPaths }) => invoke(async () => {
    const { config, profile } = await appContext();
    return crawlScreens({
      baseUrl: config.baseUrl,
      allowedOrigins: config.allowedOrigins,
      stateDir,
      profile,
      maxScreens: maxScreens ?? defaultMaxScreens,
      maxDepth: maxDepth ?? defaultMaxDepth,
      startPaths: startPaths ?? config.routes,
      launch: resolveLaunchOptions(config, profile),
      // Тот же лимит, которым sweep ждёт ответы приложения: один регулятор на оба обхода.
      ...(config.limits.responseSettleMs === undefined ? {} : { settleMs: config.limits.responseSettleMs }),
    });
  }));

  server.registerTool('bh_sweep', {
    description: 'Детерминированно обойти экраны инвентаря в прогоне области sweep: сброс данных профиля, переход, ожидание ответов, структура экрана. Находки пишутся в runs/<runId>/findings, курсор — в sweep.json, поэтому прерванный обход продолжается. Модель при этом не расходуется',
    inputSchema: z.strictObject({
      runId,
      limit: z.number().int().positive().max(2000).optional(),
      cursor: z.number().int().nonnegative().optional(),
    }),
  }, async ({ runId: id, limit, cursor }) => invoke(async () => runSweep({
    runId: id,
    stateDir,
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
  })));

  server.registerTool('bh_promote_finding', {
    description: 'Превратить находку обхода в кандидата: создаёт журнал из перехода на экран, после чего работают обычные bh_reproduce, bh_triage и bh_export_test. Обязателен check — иначе кандидата нечем воспроизвести',
    inputSchema: z.strictObject({
      runId,
      findingId: z.string().min(1),
      title: z.string().min(1),
      expected: z.string().min(1),
      actual: z.string().min(1),
      check: z.strictObject({
        kind: z.enum(webCheckKinds),
        target: z.string().min(1),
        expected: z.union([z.string(), z.number()]).optional(),
      }).describe('Оракул — проверяемое нарушение. target: видимый текст для visibleText/notVisibleText; селектор Playwright для elementCount, а не текст (для подсчёта по тексту пишите text=<текст> или [data-testid="…"]). expected у elementCount — правильное количество: нарушение фиксируется, когда фактическое количество отличается. Неверный селектор отклоняется как CHECK_INVALID').optional(),
    }),
  }, async (input) => invoke(() => promoteFindingToCandidate({ ...input, stateDir })));

  server.registerTool('bh_report_candidate', {
    description: 'Сохранить кандидата в баги с сигналами и журналом',
    inputSchema: z.strictObject({
      sessionId,
      title: z.string().min(1),
      expected: z.string().min(1),
      actual: z.string().min(1),
      signalIds,
      check: z.strictObject({
        kind: z.enum(webCheckKinds),
        target: z.string().min(1),
        expected: z.union([z.string(), z.number()]).optional(),
      }).describe('Оракул — проверяемое нарушение. target: видимый текст для visibleText/notVisibleText; селектор Playwright для elementCount, а не текст (для подсчёта по тексту пишите text=<текст> или [data-testid="…"]). expected у elementCount — правильное количество: нарушение фиксируется, когда фактическое количество отличается. Неверный селектор отклоняется как CHECK_INVALID').optional(),
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

  server.registerTool('bh_export_test', {
    description: 'Экспортировать воспроизведённый подтверждённый баг в Playwright-тест',
    inputSchema: z.strictObject({ runId, bugId: z.string().min(1) }),
  }, async ({ runId: id, bugId }) => invoke(() => runOperation(id, 'export', () =>
    exportTest({ runId: id, bugId, stateDir }),
  )));

  server.registerTool('bh_detect_tests', {
    description: 'Определить Jest или Vitest и найти соседние примеры тестов',
    inputSchema: z.strictObject({ path: z.string().min(1) }),
  }, async ({ path }) => invoke(async () => {
    const config = await loadConfig(stateDir);
    return detectWebTests(path, { unitCommand: config.tests.unit.command });
  }));

  server.registerTool('bh_verify_red', {
    description: 'Проверить один тестовый файл и получить вердикт red, green или broken',
    inputSchema: z.strictObject({
      testFile: z.string().min(1),
      runId: runId.optional(),
      candidateId: z.string().min(1).optional(),
      kind: z.enum(webTestKinds).optional(),
    }),
  }, async ({ testFile, runId: id, candidateId, kind }) => invoke(async () => {
    if ((id === undefined) !== (candidateId === undefined)) throw new Error('TEST_ASSOCIATION_INCOMPLETE');
    const absoluteTestFile = resolve(testFile);
    const config = await loadConfig(stateDir);
    const verdict = await verifyWebRed(absoluteTestFile, {
      unitCommand: config.tests.unit.command,
      ...(kind === undefined ? {} : { kind }),
    });
    if (id !== undefined && candidateId !== undefined) {
      await recordCandidateTest(id, candidateId, kind ?? 'unit', absoluteTestFile, stateDir, verdict.status);
      await recordRunStage(id, 'export', 'done', stateDir);
    }
    return verdict;
  }));

  server.registerTool('bh_close', {
    description: 'Закрыть сессию и сохранить артефакты',
    inputSchema: z.strictObject({ sessionId }),
  }, async ({ sessionId: id }) => invoke(async () => {
    await lifecycle.close(id);
    return { ok: true };
  }));

  const transport = new stdio.StdioServerTransport();
  const shutdown = async () => {
    const created = activeSessionManager(stateDir);
    const active = created === undefined ? undefined : await created.catch(() => undefined);
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
