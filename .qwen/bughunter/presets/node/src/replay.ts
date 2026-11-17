import type { Replay, ReplayContext, ReplayOutcome, Signal, StepBase } from '@bughunter/core';

import { nodeCheckViolated } from './checks.ts';
import { nodeReset } from './reset.ts';
import { openNodeSession, performRequest, sessionView } from './session.ts';
import type { NodeActInput, NodeSessionHandle } from './session.ts';
import type { NodeStep } from './types.ts';

export type NodeReplay = Replay & { close(): Promise<void> };

/**
 * Фабрика, а не модульная константа: `abort()` по дедлайну core обязан закрыть висящий повтор,
 * значит нужен доступ к активной сессии именно этого воспроизведения. Тот же приём, что в
 * веб-пресете: параллельные воспроизведения не задевают друг друга.
 */
export function createNodeReplay(): NodeReplay {
  let active: NodeSessionHandle | undefined;

  const closeActive = async (): Promise<void> => {
    const handle = active;
    active = undefined;
    await handle?.close().catch(() => undefined);
  };

  return {
    async replay(steps: StepBase[], context: ReplayContext): Promise<ReplayOutcome> {
      const artifacts: string[] = [];
      let handle: NodeSessionHandle | undefined;
      try {
        handle = await openNodeSession({
          runId: context.candidate.runId,
          target: context.journal.target,
          persona: context.journal.persona,
          stateDir: context.stateDir,
        });
        active = handle;
        const config = sessionView(handle).config;
        // Без рецепта сброса повтор всё равно законный: стенд может быть одноразовым по природе.
        if (config.reset !== null) await nodeReset.apply(handle);

        const signals: Signal[] = [];
        for (const step of steps) {
          const recorded = step as NodeStep;
          if (recorded.method === undefined || recorded.path === undefined) {
            throw new Error(`REPLAY_STEP_INCOMPLETE: ${step.id}`);
          }
          const { signals: emitted } = await performRequest(handle, {
            method: recorded.method as NodeActInput['method'],
            path: recorded.path,
            ...(recorded.body === undefined ? {} : { body: recorded.body }),
            ...(recorded.headers === undefined ? {} : { headers: recorded.headers }),
          }, config);
          signals.push(...emitted);
        }

        // Дампы ответов — доказательство повтора: core приложит их к кандидату.
        artifacts.push(...handle.artifacts());
        const { candidate } = context;
        // Композитная сигнатура кандидата включает оракул; повтор ищет сырую сигнатуру симптома.
        const symptomSignature = candidate.signalSignature ?? candidate.signature;
        const matched = candidate.signalIds.length > 0
          ? signals.some((signal) => signal.signature === symptomSignature)
          : candidate.check !== undefined && await nodeCheckViolated(handle, candidate.check);
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
