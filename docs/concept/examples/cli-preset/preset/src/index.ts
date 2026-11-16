import { resolve } from 'node:path';

import { cliInstallHint } from './cli-host.ts';
import { errorCode, ToolError } from './errors.ts';
import { defaultStateDir } from './paths.ts';
import { trimExecution } from './snapshot.ts';

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

  const { ensureCliConfig, loadCliConfig } = await import('./config.ts');
  const { cliCheckKinds, validateCliCheck } = await import('./checks.ts');
  const { findProjectRoot, createLifecycle } = core;
  const {
    recordCandidateTest, recordRunStage, reproduceCandidate, resumeRun, triageCandidate,
  } = await import('@bughunter/core');
  const {
    createRun, finishRun, leaseNextExploration, promoteFindingToCandidate,
  } = await import('./runs.ts');
  const { exportCliTest } = await import('./export-cli.ts');
  const { detectCliTests, cliTestKinds, verifyCliRed } = await import('./test-runner.ts');
  const { closeCliSession, performCommand, reportCliCandidate, sessionHandle, sessionView } =
    await import('./session.ts');
  const { runSweep } = await import('./sweep-visit.ts');
  const { cliPreset } = await import('./preset.ts');
  const { z } = zod;
  const stateDir = process.env.BUGHUNTER_STATE_DIR
    ? resolve(process.env.BUGHUNTER_STATE_DIR)
    : defaultStateDir;
  core.assertPreset(cliPreset);
  await core.assertSinglePreset(stateDir, cliPreset.name);

  // Порядок lease-вызовов принадлежит core: он один на все пресеты и им доказан resume-гейт.
  const lifecycle = createLifecycle({
    stateDir,
    personas: cliPreset.personas.roster,
    open: async ({ runId, target, persona }) => {
      const brief = cliPreset.personas.brief(persona);
      const handle = await cliPreset.session.open({ runId, target, persona, stateDir });
      return { sessionId: handle.id, payload: { sessionId: handle.id, personaBrief: brief } };
    },
    close: async (sessionId) => {
      await closeCliSession(sessionId);
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

  const compactState = cliPreset.snapshot.compact;

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
    kind: z.enum(cliCheckKinds),
    target: z.string().min(1),
    pointer: z.string().min(1).optional(),
    expected: z.union([z.string(), z.number()]).optional(),
  }).describe('Оракул — проверяемое нарушение. target: шаблон команды из инвентаря, например «add <name> <qty>». pointer обязателен для stdoutOccurrences — это искомая подстрока. expected — правильное значение: нарушение фиксируется, когда фактическое отличается. Оракул судит по последнему запуску сессии, поэтому сначала выполните команды шагом, потом заявляйте кандидата').optional();

  server.registerTool('bh_start_run', {
    description: 'Создать прогон проверки CLI: diff/full/target исследует модель, sweep (все команды или одна) обходится детерминированно через bh_sweep',
    inputSchema: z.strictObject({
      scope: z.enum(['diff', 'full', 'target', 'sweep']),
      target: z.string().min(1).optional(),
    }),
  }, async ({ scope, target }) => invoke(async () => {
    const ensured = await ensureCliConfig(stateDir);
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
    const { run, pendingCandidates } = await resumeRun(id, stateDir, cliPreset.exportTarget.kind);
    return {
      runId: run.id,
      stages: run.stages,
      candidates: pendingCandidates.map((candidate) => ({
        candidateId: candidate.id, title: candidate.title, status: candidate.status,
      })),
    };
  }));

  server.registerTool('bh_explore_next', {
    description: 'Получить следующую задачу исследования: шаблон команды, персону и lease для bh_open',
    inputSchema: z.strictObject({ runId, target: z.string().min(1).optional() }),
  }, async ({ runId: id, target }) => invoke(() =>
    lifecycle.leaseNext(id, target === undefined ? {} : { target })));

  server.registerTool('bh_finish_run', {
    description: 'Записать отчёт и завершить существующий прогон',
    inputSchema: z.strictObject({ runId }),
  }, async ({ runId: id }) => invoke(() => finishRun(id, stateDir)));

  server.registerTool('bh_open', {
    description: 'Открыть сессию исследования команды: цель — шаблон из инвентаря, например «add <name> <qty>». Без шелла: argv передаётся массивом',
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
    description: 'Получить инвентарь команд, объявленные сценарии своей цели с ожиданиями (контракт приложения), последние запуски (потоки усечены), новые симптомы и остаток шагов',
    inputSchema: z.strictObject({ sessionId }),
  }, async ({ sessionId: id }) => invoke(async () => compactState(await sessionHandle(id).snapshot())));

  server.registerTool('bh_act', {
    description: 'Выполнить одну команду в сессии: argv — массив слов, например ["add","apple","3"]. Процесс запускается без оболочки, база сессии изолирована. Необязательный setup — команды подготовки перед основной. Ответ и симптомы возвращаются сразу. Ожидаемые коды и текст бери из сценариев bh_state, а не из догадок',
    inputSchema: z.strictObject({
      sessionId,
      argv: z.array(z.string().min(1)).min(1),
      setup: z.array(z.array(z.string().min(1)).min(1)).optional()
        .describe('Команды подготовки: каждая — argv без имени исполняемого файла. Выполняются перед основной в той же базе'),
    }),
  }, async ({ sessionId: id, argv, setup }) => invoke(async () => {
    const handle = sessionHandle(id);
    const { execution, signals } = await performCommand(
      handle,
      { argv, ...(setup === undefined ? {} : { setup }) },
      sessionView(handle).config,
    );
    return { execution: trimExecution(execution), signals };
  }));

  server.registerTool('bh_report_candidate', {
    description: 'Сохранить кандидата в баги с симптомами и журналом запусков',
    inputSchema: z.strictObject({
      sessionId,
      title: z.string().min(1),
      expected: z.string().min(1),
      actual: z.string().min(1),
      signalIds,
      check,
    }),
  }, async ({ sessionId: id, ...input }) => invoke(async () => {
    // Оракул проверяется до записи: ошибку вида или иглы модель может исправить сразу,
    // а не узнать о ней на воспроизведении, где её проглотит catch.
    if (input.check !== undefined) validateCliCheck(input.check);
    return reportCliCandidate(sessionHandle(id), input);
  }));

  server.registerTool('bh_reproduce', {
    description: 'Воспроизвести кандидата в чистой сессии и минимизировать шаги',
    inputSchema: z.strictObject({
      runId,
      candidateId: z.string().min(1),
      attempts: z.number().int().min(1).max(3).default(3),
    }),
  }, async ({ runId: id, candidateId, attempts }) => invoke(() => runOperation(id, 'reproduce', () =>
    reproduceCandidate({ runId: id, candidateId, attempts, stateDir, replay: cliPreset.replay }),
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
    description: 'Экспортировать воспроизведённый подтверждённый баг в node:test-тест',
    inputSchema: z.strictObject({ runId, bugId: z.string().min(1) }),
  }, async ({ runId: id, bugId }) => invoke(() => runOperation(id, 'export', () =>
    exportCliTest({ runId: id, bugId, stateDir }),
  )));

  server.registerTool('bh_detect_tests', {
    description: 'Определить поддержку node:test для проекта приложения и найти соседние примеры тестов',
    inputSchema: z.strictObject({ path: z.string().min(1) }),
  }, async ({ path }) => invoke(async () => {
    const config = await loadCliConfig(stateDir);
    return detectCliTests(path, { unitCommand: config.tests.unit.command });
  }));

  server.registerTool('bh_verify_red', {
    description: 'Проверить один тестовый файл и получить вердикт red, green или broken',
    inputSchema: z.strictObject({
      testFile: z.string().min(1),
      runId: runId.optional(),
      candidateId: z.string().min(1).optional(),
      kind: z.enum(cliTestKinds).optional(),
    }),
  }, async ({ testFile, runId: id, candidateId, kind }) => invoke(async () => {
    if ((id === undefined) !== (candidateId === undefined)) throw new Error('TEST_ASSOCIATION_INCOMPLETE');
    const absoluteTestFile = resolve(testFile);
    const config = await loadCliConfig(stateDir);
    const verdict = await verifyCliRed(absoluteTestFile, {
      unitCommand: config.tests.unit.command,
      ...(kind === undefined ? {} : { kind }),
    });
    if (id !== undefined && candidateId !== undefined) {
      await recordCandidateTest(id, candidateId, kind ?? 'cli', absoluteTestFile, stateDir);
      await recordRunStage(id, 'export', 'done', stateDir);
    }
    return verdict;
  }));

  server.registerTool('bh_sweep', {
    description: 'Детерминированно обойти команды инвентаря в прогоне области sweep: сброс базы, заявленные сценарии (валидный, пустой, невалидный, граничный), сравнение с объявленным ожиданием. Находки пишутся в runs/<runId>/findings, курсор — в sweep.json, поэтому прерванный обход продолжается. Модель при этом не расходуется',
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
    description: 'Превратить находку обхода в кандидата: создаёт журнал из одной команды сценария, после чего работают обычные bh_reproduce, bh_triage и bh_export_test. Обязателен check — иначе кандидата нечем воспроизвести',
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
    if (input.check !== undefined) validateCliCheck(input.check);
    return promoteFindingToCandidate({ ...input, runId: id, stateDir });
  }));

  server.registerTool('bh_close', {
    description: 'Закрыть сессию и сохранить журнал запусков',
    inputSchema: z.strictObject({ sessionId }),
  }, async ({ sessionId: id }) => invoke(async () => {
    await lifecycle.close(id);
    return { ok: true };
  }));

  const transport = new stdio.StdioServerTransport();
  const shutdown = async () => {
    await cliPreset.replay.abort?.().catch(() => undefined);
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
