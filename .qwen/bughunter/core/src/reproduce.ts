import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { Replay, ReplayOutcome } from './preset.ts';
import { readRun, writeJsonAtomic } from './run-store.ts';
import type { Candidate, Journal, StepBase } from './types.ts';

/**
 * Бюджеты воспроизведения принадлежат core: это экономика метода, а не домена.
 * Пресет исполняет шаги журнала, но не решает, сколько раз повторять и когда остановиться.
 */
export const reproductionBudget = {
  maximumAttempts: 3,
  maximumEvaluations: 20,
  maximumDurationMs: 300_000,
} as const;

export type ReplayAlgorithmResult = {
  successes: number;
  initialAttempts: number;
  evaluations: number;
  minimalSteps: StepBase[];
};

export type ReproductionResult = {
  reproduced: `${number}/${number}`;
  steps: number;
  signature: string;
  artifacts: string[];
  minimalSteps: number;
};

type ReplayOptions = {
  now?: () => number;
  abort?: () => Promise<void>;
};

function validId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && value !== '.' && value !== '..';
}

async function readCandidate(runId: string, candidateId: string, stateDir: string): Promise<Candidate> {
  if (!validId(candidateId)) throw new Error(`CANDIDATE_ID_INVALID: ${candidateId}`);
  const path = join(stateDir, 'runs', runId, 'candidates', `${candidateId}.json`);
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Candidate;
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

/**
 * Протокол «повторить → тот же симптом → удалить шаг» с бюджетами и дедлайном.
 * Минимизация идёт по конверту шага: core не знает, что внутри шага, поэтому
 * удаление одного шага одинаково законно для любого домена.
 */
export async function replayAndMinimize(
  originalSteps: StepBase[],
  attempts: number,
  replay: (steps: StepBase[]) => Promise<boolean>,
  options: ReplayOptions = {},
): Promise<ReplayAlgorithmResult> {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > reproductionBudget.maximumAttempts) {
    throw new Error('ATTEMPTS_INVALID');
  }
  const now = options.now ?? Date.now;
  const deadline = now() + reproductionBudget.maximumDurationMs;
  let evaluations = 0;
  let initialAttempts = 0;
  let successes = 0;

  async function evaluate(steps: StepBase[]): Promise<boolean | undefined> {
    if (evaluations >= reproductionBudget.maximumEvaluations || now() >= deadline) return undefined;
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

/**
 * Полный цикл воспроизведения кандидата: проверка входа, протокол с бюджетами,
 * запись результата и накопление артефактов. Исполнение шагов и сопоставление
 * симптома — за пресетом, он приходит через `Replay`.
 */
export async function reproduceCandidate(input: {
  runId: string;
  candidateId: string;
  attempts?: number;
  stateDir: string;
  replay: Replay;
  now?: () => number;
}): Promise<ReproductionResult> {
  const attempts = input.attempts ?? reproductionBudget.maximumAttempts;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > reproductionBudget.maximumAttempts) {
    throw new Error('ATTEMPTS_INVALID');
  }
  const stateDir = resolve(input.stateDir);
  await readRun(input.runId, stateDir);
  const candidate = await readCandidate(input.runId, input.candidateId, stateDir);
  if (candidate.runId !== input.runId) throw new Error(`CANDIDATE_RUN_MISMATCH: ${input.candidateId}`);
  if (candidate.signalIds.length === 0 && !candidate.check) throw new Error('CANDIDATE_ORACLE_REQUIRED');
  const journal = await readJournal(input.runId, candidate.sessionId, stateDir);

  const replayArtifacts: string[] = [];
  const algorithm = await replayAndMinimize(candidate.steps, attempts, async (steps) => {
    const outcome: ReplayOutcome = await input.replay.replay(steps, { candidate, journal, stateDir });
    replayArtifacts.push(...outcome.artifacts);
    return outcome.matched;
  }, {
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.replay.abort === undefined ? {} : { abort: input.replay.abort }),
  });

  const reproduced = algorithm.successes > 0;
  const artifacts = [...new Set([...candidate.artifacts, ...replayArtifacts])];
  const updated: Candidate = {
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
}
