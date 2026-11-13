import type { TargetRef } from './preset.ts';
import {
  completeExplorationLease,
  leaseNextExploration,
  readRun,
  reclaimExplorationLeases,
  recordRouteExploration,
  releaseExplorationLease,
  validateExplorationLease,
} from './run-store.ts';
import type { ExploreNextResult } from './run-store.ts';

/**
 * Ошибка жизненного цикла сессии. Код извлекается из префикса сообщения до двоеточия —
 * так же, как у ошибок инструментов пресета, поэтому `EXPLORER_BUSY` и `LEASE_REQUIRED`
 * доходят до модели своими именами.
 */
export class LifecycleError extends Error {}

export type OpenedSession = { sessionId: string; payload: unknown };

export type LifecycleDeps = {
  stateDir: string;
  personas: readonly string[];
  open(input: { runId: string; target: TargetRef; persona: string }): Promise<OpenedSession>;
  close(sessionId: string): Promise<void>;
};

export type Lifecycle = {
  open(input: { runId: string; target: TargetRef; persona: string; leaseId?: string }): Promise<OpenedSession>;
  close(sessionId: string): Promise<void>;
  leaseNext(runId: string, options?: { route?: TargetRef }): Promise<ExploreNextResult>;
  reclaim(runId: string): Promise<unknown>;
  liveLeaseIds(runId: string): Set<string>;
};

/**
 * Порядок «проверить lease → открыть → отметить цель → откатить при неудаче» существует в одном
 * экземпляре: именно им доказан resume-гейт, и дублирование в каждом пресете рано или поздно
 * разошлось бы с ним.
 */
export function createLifecycle(deps: LifecycleDeps): Lifecycle {
  const explorations = new Map<string, { runId: string; route: TargetRef; leaseId?: string }>();
  const activeRuns = new Set<string>();
  const queueLocks = new Map<string, Promise<unknown>>();

  // Сериализация read-modify-write очереди исследования внутри одного серверного процесса.
  async function withQueueLock<T>(id: string, callback: () => Promise<T>): Promise<T> {
    const previous = queueLocks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    queueLocks.set(id, tail);
    await previous;
    try {
      return await callback();
    } finally {
      release();
      if (queueLocks.get(id) === tail) queueLocks.delete(id);
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

  return {
    async open({ runId, target, persona, leaseId }) {
      if (activeRuns.has(runId)) throw new LifecycleError(`EXPLORER_BUSY: ${runId}`);
      activeRuns.add(runId);
      let validatedLease: string | undefined;
      try {
        const run = await readRun(runId, deps.stateDir);
        if (run.exploreQueue) {
          if (leaseId === undefined) throw new LifecycleError(`LEASE_REQUIRED: ${runId}`);
          await validateExplorationLease(runId, leaseId, target, persona, deps.stateDir);
          validatedLease = leaseId;
        }
        const opened = await deps.open({ runId, target, persona });
        try {
          await recordRouteExploration(runId, target, 'exploring', deps.stateDir);
          explorations.set(opened.sessionId, {
            runId,
            route: target,
            ...(validatedLease === undefined ? {} : { leaseId: validatedLease }),
          });
          return opened;
        } catch (error) {
          await deps.close(opened.sessionId).catch(() => undefined);
          throw error;
        }
      } catch (error) {
        // Открытие не состоялось — задача возвращается в очередь для повторной выдачи.
        if (validatedLease !== undefined) {
          const leaseToRelease = validatedLease;
          await withQueueLock(runId, () => releaseExplorationLease(runId, leaseToRelease, deps.stateDir)).catch(() => undefined);
        }
        activeRuns.delete(runId);
        throw error;
      }
    },

    async close(sessionId) {
      const exploration = explorations.get(sessionId);
      let leaseSettled = false;
      try {
        await deps.close(sessionId);
        if (exploration) {
          await recordRouteExploration(exploration.runId, exploration.route, 'done', deps.stateDir);
          if (exploration.leaseId !== undefined) {
            await withQueueLock(exploration.runId, () =>
              completeExplorationLease(exploration.runId, exploration.leaseId!, deps.stateDir),
            );
            leaseSettled = true;
          }
        }
      } finally {
        if (exploration) {
          // Закрытие не удалось — задача не считается выполненной и возвращается в очередь.
          if (exploration.leaseId !== undefined && !leaseSettled) {
            await withQueueLock(exploration.runId, () =>
              releaseExplorationLease(exploration.runId, exploration.leaseId!, deps.stateDir),
            ).catch(() => undefined);
          }
          activeRuns.delete(exploration.runId);
          explorations.delete(sessionId);
        }
      }
    },

    leaseNext(runId, options) {
      return withQueueLock(runId, () => leaseNextExploration(runId, {
        personas: deps.personas,
        ...(options?.route === undefined ? {} : { route: options.route }),
        keepLeaseIds: liveLeaseIds(runId),
      }, deps.stateDir));
    },

    reclaim(runId) {
      return withQueueLock(runId, () => reclaimExplorationLeases(runId, deps.stateDir, liveLeaseIds(runId)));
    },

    liveLeaseIds,
  };
}
