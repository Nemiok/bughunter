import type { Replay, ReplayContext, ReplayOutcome, Signal, StepBase } from '@bughunter/core';

import { cliCheckViolated } from './checks.ts';
import { cliReset } from './reset.ts';
import { openCliSession, performCommand, sessionView } from './session.ts';
import type { CliSessionHandle } from './session.ts';
import type { CliStep } from './types.ts';

export type CliReplay = Replay & { abort(): Promise<void>; close(): Promise<void> };

/**
 * Фабрика, а не модульная константа: `abort()` по дедлайну core обязан закрыть сессию именно
 * этого воспроизведения. Параллельные повторы не задевают друг друга.
 */
export function createCliReplay(): CliReplay {
  let active: CliSessionHandle | undefined;

  const closeActive = async (): Promise<void> => {
    const handle = active;
    active = undefined;
    await handle?.close().catch(() => undefined);
  };

  return {
    async replay(steps: StepBase[], context: ReplayContext): Promise<ReplayOutcome> {
      const artifacts: string[] = [];
      let handle: CliSessionHandle | undefined;
      try {
        handle = await openCliSession({
          runId: context.candidate.runId,
          target: context.journal.target,
          persona: context.journal.persona,
          stateDir: context.stateDir,
        });
        active = handle;
        const config = sessionView(handle).config;
        if (config.reset !== null) await cliReset.apply(handle);

        const signals: Signal[] = [];
        for (const step of steps) {
          const recorded = step as CliStep;
          if (recorded.argv === undefined || recorded.argv.length === 0) {
            throw new Error(`REPLAY_STEP_INCOMPLETE: ${step.id}`);
          }
          const { signals: emitted } = await performCommand(handle, {
            argv: recorded.argv,
            ...(recorded.setup === undefined ? {} : { setup: recorded.setup }),
          }, config);
          signals.push(...emitted);
        }

        artifacts.push(...handle.artifacts());
        const { candidate } = context;
        const matched = candidate.signalIds.length > 0
          ? signals.some((signal) => signal.signature === candidate.signature)
          : candidate.check !== undefined && await cliCheckViolated(handle, candidate.check);
        return { matched, artifacts };
      } catch {
        return { matched: false, artifacts };
      } finally {
        if (active === handle) active = undefined;
        await handle?.close().catch(() => undefined);
      }
    },
    abort: closeActive,
    close: closeActive,
  };
}
