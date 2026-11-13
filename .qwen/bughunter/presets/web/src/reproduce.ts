import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Page } from 'playwright-core';
import { SessionManager } from './browser/session.ts';
import type { ActInput, StateResult } from './browser/session.ts';
import { toPlaywrightLocator } from './browser/elements.ts';
import { loadConfig } from './config.ts';
import { loadProfile } from './profile/load.ts';
import { signalSignature } from '@bughunter/core';
import { findAnomalyTexts } from './detectors/signals.ts';
import { readRun, writeJsonAtomic } from '@bughunter/core';
import type { Candidate, Check, Config, Journal, Signal, Step } from '@bughunter/core';

const maximumEvaluations = 20;
const maximumDurationMs = 300_000;
import { defaultStateDir } from './paths.ts';

export type ReproductionResult = {
  reproduced: `${number}/${number}`;
  steps: number;
  signature: string;
  artifacts: string[];
  minimalSteps: number;
};

export type ReplayAlgorithmResult = {
  successes: number;
  initialAttempts: number;
  evaluations: number;
  minimalSteps: Step[];
};

type ReplayOptions = {
  now?: () => number;
  abort?: () => Promise<void>;
};

type StoredCandidate = Candidate & { minimalSteps?: Step[] };

type ReplayOutcome = {
  matched: boolean;
  artifacts: string[];
};

function validId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && value !== '.' && value !== '..';
}

async function readCandidate(runId: string, candidateId: string, stateDir: string): Promise<StoredCandidate> {
  if (!validId(candidateId)) throw new Error(`CANDIDATE_ID_INVALID: ${candidateId}`);
  const path = join(stateDir, 'runs', runId, 'candidates', `${candidateId}.json`);
  try {
    return JSON.parse(await readFile(path, 'utf8')) as StoredCandidate;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`CANDIDATE_NOT_FOUND: ${candidateId}`);
    }
    throw error;
  }
}

async function readJournal(runId: string, sessionId: string, stateDir: string): Promise<Journal> {
  if (!validId(sessionId)) throw new Error(`SESSION_ID_INVALID: ${sessionId}`);
  const path = join(stateDir, 'runs', runId, 'journals', `${sessionId}.json`);
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Journal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`JOURNAL_NOT_FOUND: ${sessionId}`);
    }
    throw error;
  }
}

export async function replayAndMinimize(
  originalSteps: Step[],
  attempts: number,
  replay: (steps: Step[]) => Promise<boolean>,
  options: ReplayOptions = {},
): Promise<ReplayAlgorithmResult> {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 3) throw new Error('ATTEMPTS_INVALID');
  const now = options.now ?? Date.now;
  const deadline = now() + maximumDurationMs;
  let evaluations = 0;
  let initialAttempts = 0;
  let successes = 0;

  async function evaluate(steps: Step[]): Promise<boolean | undefined> {
    if (evaluations >= maximumEvaluations || now() >= deadline) return undefined;
    const remaining = deadline - now();
    if (remaining <= 0) return undefined;
    evaluations += 1;
    let timer: NodeJS.Timeout | undefined;
    const work = Promise.resolve().then(() => replay(steps)).catch(() => false);
    const expired = new Promise<false>((resolveExpired) => {
      timer = setTimeout(() => {
        void Promise.resolve(options.abort?.()).catch(() => undefined).then(() => resolveExpired(false));
      }, remaining);
    });
    try {
      return await Promise.race([work, expired]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  for (let attempt = 0; attempt < attempts; attempt++) {
    const matched = await evaluate(originalSteps);
    if (matched === undefined) break;
    initialAttempts += 1;
    if (matched) successes += 1;
  }

  const minimalSteps = [...originalSteps];
  if (successes > 0) {
    for (let index = 0; index < minimalSteps.length;) {
      const candidate = minimalSteps.filter((_, stepIndex) => stepIndex !== index);
      const matched = await evaluate(candidate);
      if (matched === undefined) break;
      if (matched) minimalSteps.splice(index, 1);
      else index += 1;
    }
  }

  return { successes, initialAttempts, evaluations, minimalSteps };
}

function pageFor(manager: SessionManager, sessionId: string): Page {
  const page = (manager as unknown as {
    sessions: Map<string, { page: Page }>;
  }).sessions.get(sessionId)?.page;
  if (!page) throw new Error(`SESSION_NOT_FOUND: ${sessionId}`);
  return page;
}

/**
 * Текст считается присутствующим только если видимо хотя бы одно совпадение. `first()` для этого
 * не годится: одно и то же значение часто встречается и в скрытом узле (option фильтра, шаблон,
 * aria-live), и в видимой ячейке — по первому совпадению нарушение пропадало или возникало зря.
 */
async function hasVisibleText(page: Page, target: string): Promise<boolean> {
  const matches = page.getByText(target, { exact: true });
  const total = await matches.count();
  for (let index = 0; index < total; index += 1) {
    if (await matches.nth(index).isVisible()) return true;
  }
  return false;
}

export async function checkViolated(page: Page, check: Check): Promise<boolean> {
  switch (check.kind) {
    case 'visibleText':
      return !await hasVisibleText(page, check.target);
    case 'notVisibleText':
      return await hasVisibleText(page, check.target);
    case 'elementCount':
      return await page.locator(check.target).count() !== Number(check.expected ?? 0);
  }
}

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
      if (signalSignature({ kind: 'anomaly', message, route }) === signature) observed.matched = true;
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
  };
}

async function executeReplay(
  manager: SessionManager,
  config: Config,
  stateDir: string,
  candidate: StoredCandidate,
  journal: Journal,
  steps: Step[],
): Promise<ReplayOutcome> {
  let sessionId: string | undefined;
  let matched = false;
  try {
    const opened = await manager.open(candidate.runId, journal.route, journal.persona);
    sessionId = opened.sessionId;
    const observedAnomaly = await observeReplayAnomaly(pageFor(manager, sessionId), config, candidate.signature);
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
        || signals.some((signal) => signal.signature === candidate.signature);
    } else if (candidate.check) {
      matched = await checkViolated(pageFor(manager, sessionId), candidate.check);
    }
  } catch {
    matched = false;
  }

  if (!sessionId) return { matched: false, artifacts: [] };
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
  return { matched, artifacts };
}

export async function reproduceCandidate(input: {
  runId: string;
  candidateId: string;
  attempts?: number;
  stateDir?: string;
  now?: () => number;
}): Promise<ReproductionResult> {
  const attempts = input.attempts ?? 3;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 3) throw new Error('ATTEMPTS_INVALID');
  const stateDir = input.stateDir ? resolve(input.stateDir) : defaultStateDir;
  await readRun(input.runId, stateDir);
  const [config, candidate] = await Promise.all([
    loadConfig(stateDir),
    readCandidate(input.runId, input.candidateId, stateDir),
  ]);
  if (candidate.runId !== input.runId) throw new Error(`CANDIDATE_RUN_MISMATCH: ${input.candidateId}`);
  if (candidate.signalIds.length === 0 && !candidate.check) throw new Error('CANDIDATE_ORACLE_REQUIRED');
  const journal = await readJournal(input.runId, candidate.sessionId, stateDir);
  // Профиль нужен повтору: без него upload не найдёт каталог тестовых данных,
  // а координатные действия лишатся хука приложения.
  const profile = config.profile === undefined ? null : await loadProfile(stateDir, config.profile);
  const manager = new SessionManager(config, stateDir, profile);
  const replayArtifacts: string[] = [];
  let activeReplay: Promise<ReplayOutcome> | undefined;
  try {
    const algorithm = await replayAndMinimize(candidate.steps, attempts, (steps) => {
      const operation = executeReplay(manager, config, stateDir, candidate, journal, steps);
      activeReplay = operation;
      return operation.then((outcome) => {
        replayArtifacts.push(...outcome.artifacts);
        return outcome.matched;
      }).finally(() => {
        if (activeReplay === operation) activeReplay = undefined;
      });
    }, {
      ...(input.now === undefined ? {} : { now: input.now }),
      abort: async () => {
        await manager.closeAll();
        await activeReplay?.catch(() => ({ matched: false, artifacts: [] }));
      },
    });
    const reproduced = algorithm.successes > 0;
    const artifacts = [...new Set([...candidate.artifacts, ...replayArtifacts])];
    const updated: StoredCandidate = {
      ...candidate,
      artifacts,
      reproduction: { status: reproduced ? 'reproduced' : 'unreproduced', attempts: algorithm.initialAttempts },
    };
    if (reproduced) updated.minimalSteps = algorithm.minimalSteps;
    else delete updated.minimalSteps;
    await writeJsonAtomic(join(stateDir, 'runs', input.runId, 'candidates', `${input.candidateId}.json`), updated);
    return {
      reproduced: `${algorithm.successes}/${attempts}`,
      steps: candidate.steps.length,
      signature: candidate.signature,
      artifacts,
      minimalSteps: reproduced ? algorithm.minimalSteps.length : 0,
    };
  } finally {
    await manager.closeAll();
  }
}
