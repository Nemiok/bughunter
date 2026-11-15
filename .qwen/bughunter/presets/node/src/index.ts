import { resolve } from 'node:path';

import type { Check } from '@bughunter/core';

import { cliInstallHint } from './cli-host.ts';
import { errorCode, ToolError } from './errors.ts';
import { defaultStateDir } from './paths.ts';
import { nodeSnapshot, trimResponse } from './snapshot.ts';

const missingDependenciesMessage = `Зависимости Bughunter не установлены. Выполните: ${cliInstallHint()}`;

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

  const { ensureNodeConfig, loadNodeConfig } = await import('./config.ts');
  const { nodeCheckKinds, validateNodeCheck } = await import('./checks.ts');
  const { findProjectRoot, createLifecycle } = core;
  const {
    recordCandidateTest, recordRunStage, reproduceCandidate, resumeRun, triageCandidate,
  } = await import('@bughunter/core');
  const {
    createRun, finishRun, leaseNextExploration, promoteFindingToCandidate,
  } = await import('./runs.ts');
  const { exportNodeTest } = await import('./export-vitest.ts');
  const { detectNodeTests, nodeTestKinds, verifyNodeRed, apiKind } = await import('./test-runner.ts');
  const { closeNodeSession, performRequest, reportNodeCandidate, sessionHandle, sessionView } =
    await import('./session.ts');
  const { runSweep } = await import('./sweep-visit.ts');
  const { nodePreset } = await import('./preset.ts');
  const { z } = zod;
  const stateDir = process.env.BUGHUNTER_STATE_DIR
    ? resolve(process.env.BUGHUNTER_STATE_DIR)
    : defaultStateDir;
  core.assertPreset(nodePreset);
  await core.assertSinglePreset(stateDir, nodePreset.name);

  // Порядок lease-вызовов принадлежит core: он один на все пресеты и им доказан resume-гейт.
  const lifecycle = createLifecycle({
    stateDir,
    personas: nodePreset.personas.roster,
    open: async ({ runId, target, persona }) => {
      // Бриф персоны отдаёт сервер, а не промпт: ростер принадлежит пресету.
      const brief = nodePreset.personas.brief(persona);
      const handle = await nodePreset.session.open({ runId, target, persona, stateDir });
      return { sessionId: handle.id, payload: { sessionId: handle.id, personaBrief: brief } };
    },
    close: async (sessionId) => {
      await closeNodeSession(sessionId);
    },
  });

  function result(value: unknown) {
    return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
  }

  function failure(error: unknown) {
    return { ...result(errorCode(error)), isError: true };
  }

  async function invoke(callback: () => Promise<unknown>) {
    try {
      return result(await callback());
    } catch (error) {
      return failure(error);
    }
  }

  const compactState = nodeSnapshot.compact;

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
  const check = z.strictObject({
    kind: z.enum(nodeCheckKinds),
    target: z.string().min(1),
    pointer: z.string().min(1).optional(),
    expected: z.union([z.string(), z.number()]).optional(),
  }).describe('Оракул — проверяемое нарушение. target: строка запроса «МЕТОД /путь», например GET /orders/ord-unknown. pointer обязателен для jsonPath (указатель $.totalCents или /totalCents) и для headerContains (имя заголовка). expected — правильное значение: нарушение фиксируется, когда фактическое отличается. Оракул судит по последнему ответу сессии, поэтому сначала выполните запросы шагом, потом заявляйте кандидата').optional();

  server.registerTool('bh_start_run', {
    description: 'Создать прогон проверки API: diff/full/target исследует модель, sweep (весь инвентарь или один эндпоинт) обходится детерминированно через bh_sweep',
    inputSchema: z.strictObject({
      scope: z.enum(['diff', 'full', 'target', 'sweep']),
      target: z.string().min(1).optional(),
    }),
  }, async ({ scope, target }) => invoke(async () => {
    const ensured = await ensureNodeConfig(stateDir);
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
    const { run, pendingCandidates } = await resumeRun(id, stateDir, nodePreset.exportTarget.kind);
    return {
      runId: run.id,
      stages: run.stages,
      candidates: pendingCandidates.map((candidate) => ({
        candidateId: candidate.id, title: candidate.title, status: candidate.status,
      })),
    };
  }));

  server.registerTool('bh_explore_next', {
    description: 'Получить следующую задачу исследования: эндпоинт, персону и lease для bh_open',
    inputSchema: z.strictObject({ runId, target: z.string().min(1).optional() }),
  }, async ({ runId: id, target }) => invoke(() =>
    lifecycle.leaseNext(id, target === undefined ? {} : { target })));

  server.registerTool('bh_finish_run', {
    description: 'Записать отчёт и завершить существующий прогон',
    inputSchema: z.strictObject({ runId }),
  }, async ({ runId: id }) => invoke(() => finishRun(id, stateDir)));

  server.registerTool('bh_open', {
    description: 'Открыть сессию исследования эндпоинта: цель — строка «МЕТОД /шаблон» из инвентаря, например GET /orders/:id',
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
    description: 'Получить инвентарь эндпоинтов, объявленные сценарии своей цели с ожиданиями (контракт приложения), последние ответы сессии (тела усечены), новые симптомы и остаток шагов',
    inputSchema: z.strictObject({ sessionId }),
  }, async ({ sessionId: id }) => invoke(async () => compactState(await sessionHandle(id).snapshot())));

  server.registerTool('bh_act', {
    description: 'Выполнить один HTTP-запрос в сессии: метод, путь от baseUrl приложения, необязательное тело и заголовки. Ответ и симптомы возвращаются сразу. Ожидаемые коды ответов и поля бери из сценариев bh_state, а не из обычаев REST',
    inputSchema: z.strictObject({
      sessionId,
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
      path: z.string().min(1),
      body: z.unknown().optional().describe('Тело запроса как JSON-значение: объект, массив, число, строка. Передавай значение, а не его строковое представление — строка, разбирающаяся в объект или массив, будет разобрана сервером'),
      headers: z.record(z.string(), z.string()).optional(),
    }),
  }, async ({ sessionId: id, ...input }) => invoke(async () => {
    const handle = sessionHandle(id);
    const { response, signals } = await performRequest(handle, input, sessionView(handle).config);
    return { response: trimResponse(response), signals };
  }));

  server.registerTool('bh_report_candidate', {
    description: 'Сохранить кандидата в баги с симптомами и журналом запросов',
    inputSchema: z.strictObject({
      sessionId,
      title: z.string().min(1),
      expected: z.string().min(1),
      actual: z.string().min(1),
      signalIds,
      check,
    }),
  }, async ({ sessionId: id, ...input }) => invoke(async () => {
    // Оракул проверяется до записи: ошибку вида или указателя модель может исправить сразу,
    // а не узнать о ней на воспроизведении, где её проглотит catch.
    if (input.check !== undefined) validateNodeCheck(input.check);
    return reportNodeCandidate(sessionHandle(id), input);
  }));

  server.registerTool('bh_reproduce', {
    description: 'Воспроизвести кандидата в чистой сессии и минимизировать шаги',
    inputSchema: z.strictObject({
      runId,
      candidateId: z.string().min(1),
      attempts: z.number().int().min(1).max(3).default(3),
    }),
  }, async ({ runId: id, candidateId, attempts }) => invoke(() => runOperation(id, 'reproduce', () =>
    reproduceCandidate({ runId: id, candidateId, attempts, stateDir, replay: nodePreset.replay }),
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
    description: 'Экспортировать воспроизведённый подтверждённый баг в Vitest-тест',
    inputSchema: z.strictObject({ runId, bugId: z.string().min(1) }),
  }, async ({ runId: id, bugId }) => invoke(() => runOperation(id, 'export', () =>
    exportNodeTest({ runId: id, bugId, stateDir }),
  )));

  server.registerTool('bh_detect_tests', {
    description: 'Определить Jest или Vitest и найти соседние примеры тестов',
    inputSchema: z.strictObject({ path: z.string().min(1) }),
  }, async ({ path }) => invoke(async () => {
    const config = await loadNodeConfig(stateDir);
    return detectNodeTests(path, { unitCommand: config.tests.unit.command });
  }));

  server.registerTool('bh_verify_red', {
    description: 'Проверить один тестовый файл и получить вердикт red, green или broken',
    inputSchema: z.strictObject({
      testFile: z.string().min(1),
      runId: runId.optional(),
      candidateId: z.string().min(1).optional(),
      kind: z.enum(nodeTestKinds).optional(),
    }),
  }, async ({ testFile, runId: id, candidateId, kind }) => invoke(async () => {
    if ((id === undefined) !== (candidateId === undefined)) throw new Error('TEST_ASSOCIATION_INCOMPLETE');
    const absoluteTestFile = resolve(testFile);
    const config = await loadNodeConfig(stateDir);
    const verdict = await verifyNodeRed(absoluteTestFile, {
      unitCommand: config.tests.unit.command,
      ...(kind === undefined ? {} : { kind }),
    });
    if (id !== undefined && candidateId !== undefined) {
      await recordCandidateTest(id, candidateId, kind ?? apiKind, absoluteTestFile, stateDir);
      await recordRunStage(id, 'export', 'done', stateDir);
    }
    return verdict;
  }));

  server.registerTool('bh_sweep', {
    description: 'Детерминированно обойти эндпоинты инвентаря в прогоне области sweep: сброс стенда, заявленные сценарии (валидный, пустой, невалидный, граничный), сравнение с объявленным ожиданием. Находки пишутся в runs/<runId>/findings, курсор — в sweep.json, поэтому прерванный обход продолжается. Модель при этом не расходуется',
    inputSchema: z.strictObject({
      runId,
      limit: z.number().int().positive().max(2000).optional(),
      cursor: z.number().int().nonnegative().optional(),
    }),
  }, async ({ runId: id, limit, cursor }) => invoke(() => runSweep({
    runId: id,
    stateDir,
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
  })));

  server.registerTool('bh_promote_finding', {
    description: 'Превратить находку обхода в кандидата: создаёт журнал из одного запроса сценария, после чего работают обычные bh_reproduce, bh_triage и bh_export_test. Обязателен check — иначе кандидата нечем воспроизвести',
    inputSchema: z.strictObject({
      runId,
      findingId: z.string().min(1),
      title: z.string().min(1),
      expected: z.string().min(1),
      actual: z.string().min(1),
      check,
    }),
  }, async ({ runId: id, ...input }) => invoke(async () => {
    // Оракул проверяется до промоции: иначе ошибка синтаксиса всплывёт уже на воспроизведении.
    if (input.check !== undefined) validateNodeCheck(input.check);
    return promoteFindingToCandidate({ ...input, runId: id, stateDir });
  }));

  server.registerTool('bh_close', {
    description: 'Закрыть сессию и сохранить дамп ответов',
    inputSchema: z.strictObject({ sessionId }),
  }, async ({ sessionId: id }) => invoke(async () => {
    await lifecycle.close(id);
    return { ok: true };
  }));

  const transport = new stdio.StdioServerTransport();
  const shutdown = async () => {
    await nodePreset.replay.abort?.().catch(() => undefined);
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
