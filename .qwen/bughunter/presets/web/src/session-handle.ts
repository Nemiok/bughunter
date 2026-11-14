import type { Page } from 'playwright-core';

import type { Session, SessionHandle, Signal, StepBase } from '@bughunter/core';

import { SessionManager } from './browser/session.ts';
import type { ActInput } from './browser/session.ts';
import { loadConfig } from './config.ts';
import { loadProfile } from './profile/load.ts';
import { webSnapshot } from './snapshot.ts';

const managers = new Map<string, Promise<SessionManager>>();

/**
 * Один менеджер на каталог состояния: браузер поднимается один раз на прогон, а снимки, действия
 * и закрытие обязаны видеть один и тот же контекст. Отказ не кэшируется — конфиг приложения мог
 * появиться позже, и следующий вызов пробует снова.
 */
export function sessionManager(stateDir: string): Promise<SessionManager> {
  let created = managers.get(stateDir);
  if (created === undefined) {
    created = (async () => {
      const config = await loadConfig(stateDir);
      const profile = config.profile === undefined ? null : await loadProfile(stateDir, config.profile);
      return new SessionManager(config, stateDir, profile);
    })();
    created.catch(() => managers.delete(stateDir));
    managers.set(stateDir, created);
  }
  return created;
}

/** Уже созданный менеджер: завершению процесса нечего поднимать, ему нужно только закрыть. */
export function activeSessionManager(stateDir: string): Promise<SessionManager> | undefined {
  return managers.get(stateDir);
}

export type WebSessionHandle = SessionHandle & {
  /** Страница сессии: через неё работают оракулы и детекторы пресета. */
  page: Page;
  /** Симптомы, которые сессия накопила с прошлого сканирования. */
  drainSignals(): Signal[];
};

/**
 * Сессия исследования. Веб-детекторы слушают страницу непрерывно, поэтому снимки и действия
 * складывают сигналы в буфер дескриптора, а `detectors.scan` его опустошает.
 */
export async function openWebSession(input: {
  runId: string;
  target: string;
  persona: string;
  stateDir: string;
}): Promise<WebSessionHandle> {
  const manager = await sessionManager(input.stateDir);
  const { sessionId } = await manager.open(input.runId, input.target, input.persona);
  const page = manager.pageOf(sessionId);
  const collected: Signal[] = [];
  return {
    id: sessionId,
    page,
    async snapshot() {
      const state = await manager.state(sessionId, { screen: true, limit: manager.snapshotLimit });
      collected.push(...state.signals);
      return webSnapshot.compact(state);
    },
    async act(payload: unknown) {
      const result = await manager.act(sessionId, payload as ActInput);
      collected.push(...result.signals);
      return result;
    },
    steps: (): StepBase[] => manager.stepsOf(sessionId),
    // Trace, скриншот и видео веб-сессия пишет при закрытии: до `close()` артефактов нет.
    artifacts: () => [],
    drainSignals: () => collected.splice(0, collected.length),
    close: () => manager.close(sessionId),
  };
}

export const webSession: Session = { open: openWebSession };
