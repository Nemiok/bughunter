import { randomUUID } from 'node:crypto';
import { mkdir, rename } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Page } from 'playwright-core';
import { SessionManager } from './browser/session.ts';
import type { ActInput, StateResult } from './browser/session.ts';
import { toPlaywrightLocator } from './browser/elements.ts';
import { loadConfig } from './config.ts';
import { loadProfile } from './profile/load.ts';
import type { Profile } from './profile/types.ts';
import { applyReset } from './reset.ts';
import { findAnomalyTexts } from './detectors/signals.ts';
import { defaultStateDir } from './paths.ts';
import { reproduceCandidate as reproduceCoreCandidate, signalSignature } from '@bughunter/core';
import type {
  Candidate, Journal, Replay, ReplayContext, ReplayOutcome, ReproductionResult, Signal, StepBase,
} from '@bughunter/core';
import type { WebConfig as Config } from './config.ts';
import { checkViolated } from './checks.ts';
import type { Step } from './types.ts';

async function observeReplayAnomaly(page: Page, config: Config, signature: string): Promise<{ matched: boolean }> {
  const observed = { matched: false };
  await page.exposeFunction('__bughunterReplayText', (text: string) => {
    let route: string;
    try {
      route = new URL(page.url()).pathname;
    } catch {
      route = page.url();
    }
    for (const message of findAnomalyTexts(text, config.detectors.anomalyTexts)) {
      if (signalSignature({ kind: 'anomaly', message, target: route }) === signature) observed.matched = true;
    }
  });
  await page.addInitScript(() => {
    const target = window as unknown as Window & { __bughunterReplayText: (text: string) => Promise<void> };
    const report = () => {
      if (document.body) void target.__bughunterReplayText(document.body.innerText);
    };
    new MutationObserver(report).observe(document, { childList: true, characterData: true, subtree: true });
    report();
  });
  return observed;
}

/**
 * Шаг журнала обратно превращается в `bh_act`. Координатный шаг повторяется точкой: цель под ней
 * приложение определит само, а `resolvedLocator` остаётся в журнале доказательством для отчёта.
 */
function replayActInput(step: Step, state: StateResult): ActInput {
  const action = step.action;
  if (action === undefined) throw new Error('REPLAY_ELEMENT_NOT_FOUND');
  if (step.at !== undefined) return { action, at: step.at };
  if (step.locator === undefined) {
    if (action === 'scroll' && step.scroll !== undefined) return { action, scroll: step.scroll };
    throw new Error('REPLAY_ELEMENT_NOT_FOUND');
  }
  const find = (locator: string) => state.elements.find((element) => toPlaywrightLocator(element.locator) === locator);
  const element = find(step.locator);
  if (element === undefined) throw new Error('REPLAY_ELEMENT_NOT_FOUND');
  let toElementId: string | undefined;
  if (step.to !== undefined) {
    const target = find(step.to.locator);
    if (target === undefined) throw new Error('REPLAY_ELEMENT_NOT_FOUND');
    toElementId = target.id;
  }
  return {
    elementId: element.id,
    action,
    ...(step.value === undefined ? {} : { value: step.value }),
    ...(toElementId === undefined ? {} : { toElementId }),
    ...(step.file === undefined ? {} : { file: step.file }),
    ...(step.scroll === undefined ? {} : { scroll: step.scroll }),
    ...(step.dialog === undefined ? {} : { dialog: step.dialog }),
  };
}

async function executeReplay(
  manager: SessionManager,
  config: Config,
  stateDir: string,
  candidate: Candidate,
  journal: Journal,
  steps: Step[],
  profile: Profile | null,
): Promise<ReplayOutcome> {
  let sessionId: string | undefined;
  let matched = false;
  let replayError: string | undefined;
  try {
    const opened = await manager.open(candidate.runId, journal.target, journal.persona);
    sessionId = opened.sessionId;
    // Повтор начинается с того же состояния, что и исследование: data-зависимый баг
    // без сброса воспроизводился бы на изменённых данных.
    if (profile?.reset !== undefined) {
      await applyReset(manager.pageOf(sessionId), profile, config.baseUrl);
    }
    // Композитная сигнатура кандидата включает оракул; повтор ищет сырую сигнатуру симптома.
    const symptomSignature = candidate.signalSignature ?? candidate.signature;
    const observedAnomaly = await observeReplayAnomaly(manager.pageOf(sessionId), config, symptomSignature);
    const signals: Signal[] = [];
    const collect = (emitted: Signal[]) => signals.push(...emitted);
    for (const step of steps) {
      if (step.kind === 'act') {
        if (!step.action) throw new Error('REPLAY_ELEMENT_NOT_FOUND');
        // Полный снимок без лимита: шаг журнала может ссылаться на элемент за пределами первой страницы.
        const state = await manager.state(sessionId, { full: true });
        collect(state.signals);
        const acted = await manager.act(sessionId, replayActInput(step, state));
        collect(acted.signals);
        if (!acted.ok) throw new Error(acted.error ?? 'REPLAY_ACTION_FAILED');
      } else if (step.kind === 'navigate') {
        if (!step.path) throw new Error('REPLAY_PATH_REQUIRED');
        collect((await manager.navigate(sessionId, step.path)).signals);
      } else {
        if (!step.probe) throw new Error('REPLAY_PROBE_REQUIRED');
        collect((await manager.probe(sessionId, step.probe)).signals);
      }
    }
    collect((await manager.state(sessionId)).signals);
    if (candidate.signalIds.length > 0) {
      matched = observedAnomaly.matched
        || signals.some((signal) => signal.signature === symptomSignature);
    } else if (candidate.check) {
      matched = await checkViolated(manager.pageOf(sessionId), candidate.check);
    }
  } catch (error) {
    matched = false;
    replayError = error instanceof Error ? error.message : String(error);
  }

  if (!sessionId) {
    return { matched: false, artifacts: [], ...(replayError === undefined ? {} : { error: replayError }) };
  }
  try {
    await manager.close(sessionId);
  } catch {
    matched = false;
  }
  const source = join(stateDir, 'runs', candidate.runId, 'artifacts', sessionId);
  const destination = join(stateDir, 'runs', candidate.runId, 'artifacts', candidate.id, `replay-${randomUUID()}`);
  await mkdir(dirname(destination), { recursive: true });
  await rename(source, destination);
  const artifacts = ['trace.zip', 'screenshot.png', 'video.webm'].map((name) =>
    relative(stateDir, join(destination, name)).split(sep).join('/'),
  );
  return { matched, artifacts, ...(replayError === undefined ? {} : { error: replayError }) };
}

export type WebReplay = Replay & { close(): Promise<void> };

/**
 * Повтор живёт в экземпляре, а не в модульной константе: abort() по дедлайну core обязан
 * дотянуться до висящего браузера, а общий модуль смешал бы два воспроизведения.
 * Конфиг и профиль читаются один раз на экземпляр — столько же, сколько читал прежний оркестратор.
 */
export function createWebReplay(): WebReplay {
  let manager: SessionManager | undefined;
  let active: Promise<ReplayOutcome> | undefined;
  let loaded: { config: Config; profile: Awaited<ReturnType<typeof loadProfile>> | null } | undefined;

  return {
    async replay(steps: StepBase[], context: ReplayContext): Promise<ReplayOutcome> {
      if (loaded === undefined) {
        const config = await loadConfig(context.stateDir);
        const profile = config.profile === undefined ? null : await loadProfile(context.stateDir, config.profile);
        loaded = { config, profile };
      }
      manager ??= new SessionManager(loaded.config, context.stateDir, loaded.profile);
      const operation = executeReplay(
        manager,
        loaded.config,
        context.stateDir,
        context.candidate,
        context.journal,
        steps as Step[],
        loaded.profile,
      );
      active = operation;
      try {
        return await operation;
      } finally {
        if (active === operation) active = undefined;
      }
    },
    async abort(): Promise<void> {
      await manager?.closeAll();
      await active?.catch(() => ({ matched: false, artifacts: [] }));
    },
    async close(): Promise<void> {
      await manager?.closeAll();
      manager = undefined;
    },
  };
}

/** Обёртка пресета: протокол, бюджеты и запись результата принадлежат core. */
export async function reproduceCandidate(input: {
  runId: string;
  candidateId: string;
  attempts?: number;
  stateDir?: string;
  now?: () => number;
}): Promise<ReproductionResult> {
  const replay = createWebReplay();
  try {
    return await reproduceCoreCandidate({
      runId: input.runId,
      candidateId: input.candidateId,
      ...(input.attempts === undefined ? {} : { attempts: input.attempts }),
      stateDir: input.stateDir === undefined ? defaultStateDir : resolve(input.stateDir),
      replay,
      ...(input.now === undefined ? {} : { now: input.now }),
    });
  } finally {
    await replay.close();
  }
}
