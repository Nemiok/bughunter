import { runSweep as runCoreSweep } from '@bughunter/core';
import type { FindingDraft, Session, SessionHandle, Signal, SweepResult, SweepVisit } from '@bughunter/core';

import { cliFindingKinds, scenarioWidget } from './finding-kinds.ts';
import { cliInventory, targetOfArgv } from './inventory.ts';
import { cliReset } from './reset.ts';
import { cliSession, executionHash, performCommand, sessionView } from './session.ts';
import type { CliSessionHandle } from './session.ts';
import type { CliScenario } from './types.ts';

/**
 * Сессия обхода: те же запуски, но без журнала — находка становится журналом только при промоции.
 * Действия модели запрещены: обход детерминирован и умеет ровно заявленные сценарии.
 */
export const cliSweepSession: Session = {
  open: async (input) => {
    const handle = await cliSession.open(input);
    return {
      ...handle,
      act: async (): Promise<never> => {
        throw new Error('SWEEP_SESSION_READ_ONLY: детерминированный обход не совершает действий вне сценариев');
      },
    };
  },
};

/**
 * Визит одной цели: выполнить её сценарии и сравнить исход с объявленным ожиданием. Ожидание
 * в конфиге — контракт приложения, поэтому обход находит нарушение без модели. Принадлежность
 * сценария цели определяется по объявленным командам профиля, а не угадывается по argv.
 */
export const cliSweepVisit: SweepVisit = {
  visit: async ({ target, handle, stateDir }): Promise<FindingDraft[]> => {
    const view = sessionView(handle);
    const drafts: FindingDraft[] = [];
    for (const scenario of view.config.scenarios) {
      const belongs = targetOfArgv(view.commands, scenario.argv);
      if (belongs === undefined) throw new Error(`SCENARIO_INVALID: ${scenarioWidget(scenario)} не подходит ни одной команде профиля`);
      if (belongs !== target) continue;
      // Сброс перед каждым сценарием: наблюдения не зависят друг от друга. Отказ сброса здесь
      // не находка — core уже отметил его один раз на прогон.
      await cliReset.apply(handle).catch(() => undefined);
      for (const setup of scenario.setup ?? []) {
        await performCommand(handle as CliSessionHandle, { argv: setup.argv }, view.config, { journal: false });
      }
      const { execution, signals } = await performCommand(
        handle as CliSessionHandle,
        { argv: scenario.argv },
        view.config,
        { journal: false },
      );
      drafts.push(...findingsFor(target, scenario, execution.exitCode, execution.timedOut, execution.spawnError, execution.stdout, execution.stderr, signals, [executionHash(execution)]));
    }
    return drafts;
  },
};

function findingsFor(
  target: string,
  scenario: CliScenario,
  exitCode: number | null,
  timedOut: boolean,
  spawnError: string | undefined,
  stdout: string,
  stderr: string,
  signals: Signal[],
  responseHashes: string[],
): FindingDraft[] {
  const widget = scenarioWidget(scenario);
  const drafts: FindingDraft[] = [];
  const add = (kind: string, detail: string): void => {
    drafts.push({ targetRef: target, widget, kind, detail, responseHashes });
  };
  const expected = scenario.expect;

  if (timedOut) {
    add('execution-failed', `${widget}: выполнение не завершилось за отведённое время`);
  } else if (spawnError !== undefined) {
    add('execution-failed', `${widget}: ${spawnError}`);
  } else if (exitCode === null) {
    add('execution-failed', `${widget}: процесс завершён сигналом`);
  }

  if (exitCode !== expected.exitCode) {
    add('exit-code-unexpected', `${widget}: ожидался код ${expected.exitCode}, получен ${exitCode ?? 'сигнал'}`);
  }
  for (const text of expected.stdoutContains ?? []) {
    if (!stdout.includes(text)) add('output-mismatch', `${widget}: stdout не содержит ${JSON.stringify(text)}`);
  }
  for (const text of expected.stdoutNotContains ?? []) {
    if (stdout.includes(text)) add('output-mismatch', `${widget}: stdout содержит ${JSON.stringify(text)}`);
  }
  for (const text of expected.stderrContains ?? []) {
    if (!stderr.includes(text)) add('output-mismatch', `${widget}: stderr не содержит ${JSON.stringify(text)}`);
  }
  for (const text of expected.stderrNotContains ?? []) {
    if (stderr.includes(text)) add('output-mismatch', `${widget}: stderr содержит ${JSON.stringify(text)}`);
  }

  const anomalous = signals.filter((signal) => signal.kind === 'anomaly' || signal.kind === 'stderr-stack');
  if (anomalous.length > 0) {
    add('output-anomaly', `${widget}: ${anomalous.map((signal) => signal.message).join('; ')}`);
  }
  return drafts;
}

export async function runSweep(input: {
  runId: string;
  stateDir: string;
  limit?: number;
  cursor?: number;
}): Promise<SweepResult> {
  return runCoreSweep({
    ...input,
    inventory: cliInventory,
    session: cliSweepSession,
    visit: cliSweepVisit,
    reset: cliReset,
    findingKinds: cliFindingKinds,
  });
}
