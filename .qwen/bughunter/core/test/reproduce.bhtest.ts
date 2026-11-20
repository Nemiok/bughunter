import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRun, writeJsonAtomic } from '../src/run-store.ts';
import { replayAndMinimize, reproduceCandidate } from '../src/reproduce.ts';
import type { Replay } from '../src/preset.ts';
import type { Candidate, Config, Journal, StepBase } from '../src/types.ts';

function algorithmSteps(count: number): StepBase[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `step-${index}`,
    kind: 'step',
    timestamp: '2026-11-10T00:00:00.000Z',
    targetRef: '/target',
  }));
}

const matched = (value: boolean) => ({ matched: value, artifacts: [] });

test('fake replay minimizes by removal and restores required steps exactly', async () => {
  const calls: string[][] = [];
  const result = await replayAndMinimize(algorithmSteps(3), 1, async (steps) => {
    calls.push(steps.map((step) => step.id));
    return matched(steps.some((step) => step.id === 'step-1') && steps.some((step) => step.id === 'step-2'));
  });
  assert.deepEqual(calls, [
    ['step-0', 'step-1', 'step-2'],
    ['step-1', 'step-2'],
    ['step-2'],
    ['step-1'],
  ]);
  assert.equal(result.successes, 1);
  assert.equal(result.evaluations, 4);
  assert.deepEqual(result.minimalSteps.map((step) => step.id), ['step-1', 'step-2']);
});

test('fake replay never invokes the 21st evaluation including initial attempts', async () => {
  let calls = 0;
  const result = await replayAndMinimize(algorithmSteps(25), 3, async () => {
    calls += 1;
    return matched(true);
  });
  assert.equal(calls, 20);
  assert.equal(result.evaluations, 20);
  assert.equal(result.successes, 3);
  assert.equal(result.minimalSteps.length, 8);
});

test('deadline aborts pending replay and prevents further evaluations', async () => {
  let calls = 0;
  let aborted = 0;
  let clock = 0;
  let clockReads = 0;
  const result = await replayAndMinimize(algorithmSteps(3), 3, async () => {
    calls += 1;
    return await new Promise<{ matched: boolean; artifacts: string[] }>(() => undefined);
  }, {
    now: () => {
      clockReads += 1;
      return clockReads === 3 ? 299_999 : clock;
    },
    abort: async () => {
      aborted += 1;
      clock = 300_000;
    },
  });
  assert.equal(calls, 1);
  assert.equal(aborted, 1);
  assert.equal(result.evaluations, 1);
  assert.equal(result.successes, 0);
  assert.equal(result.minimalSteps.length, 3);
});

test('attempts outside the budget are rejected before any replay', async () => {
  for (const attempts of [0, 4, 1.5]) {
    await assert.rejects(replayAndMinimize(algorithmSteps(1), attempts, async () => matched(true)), /ATTEMPTS_INVALID/);
  }
});

const config = { targetMap: {}, baseBranch: 'main' } as unknown as Config;

async function reproduceFixture(replay: Replay['replay']) {
  const stateDir = await mkdtemp(join(tmpdir(), 'bh-core-reproduce-'));
  const run = await createRun('full', undefined, { config, projectRoot: stateDir, stateDir, personas: ['p'], targets: ['/a'] });
  const steps = algorithmSteps(2);
  const candidate: Candidate = {
    id: 'cand-1', runId: run.id, sessionId: 'sess-1', target: '/a',
    title: 't', expected: 'e', actual: 'a', signalIds: ['signal-1'], signature: 'sig',
    steps, artifacts: [], status: 'unprocessed', createdAt: '2026-11-10T00:00:00.000Z',
    reproduction: { status: 'unreproduced', attempts: 0 },
  };
  await writeJsonAtomic(join(stateDir, 'runs', run.id, 'candidates', 'cand-1.json'), candidate);
  const journal: Journal = {
    sessionId: 'sess-1', runId: run.id, target: '/a', persona: 'p', steps,
    createdAt: '2026-11-10T00:00:00.000Z',
  };
  await writeJsonAtomic(join(stateDir, 'runs', run.id, 'journals', 'sess-1.json'), journal);
  const candidateFile = join(stateDir, 'runs', run.id, 'candidates', 'cand-1.json');
  return {
    stateDir, runId: run.id, candidateFile, steps,
    input: { runId: run.id, candidateId: 'cand-1', stateDir, replay: { replay } },
  };
}

test('all-attempts-error-throws-replay-failed', async (t) => {
  const fixture = await reproduceFixture(async () => { throw new Error('STAND_DOWN'); });
  t.after(() => rm(fixture.stateDir, { recursive: true, force: true }));
  await assert.rejects(reproduceCandidate(fixture.input), /REPLAY_FAILED: STAND_DOWN/);
  const stored = JSON.parse(await readFile(fixture.candidateFile, 'utf8')) as Candidate;
  assert.deepEqual(stored.reproduction, { status: 'unreproduced', attempts: 0 });
});

test('error-then-match-reproduces', async (t) => {
  let calls = 0;
  const fixture = await reproduceFixture(async () => {
    calls += 1;
    if (calls <= 2) throw new Error('FLAKY_STAND');
    return matched(true);
  });
  t.after(() => rm(fixture.stateDir, { recursive: true, force: true }));
  const result = await reproduceCandidate({ ...fixture.input, attempts: 3 });
  assert.equal(result.reproduced, '1/3');
});

test('minimize-error-keeps-step', async (t) => {
  let calls = 0;
  const fixture = await reproduceFixture(async () => {
    calls += 1;
    if (calls <= 3) return matched(true);
    return { matched: false, artifacts: [], error: 'FLAKY' };
  });
  t.after(() => rm(fixture.stateDir, { recursive: true, force: true }));
  const result = await reproduceCandidate(fixture.input);
  assert.equal(result.reproduced, '3/3');
  assert.equal(result.minimalSteps, fixture.steps.length);
});

test('outcome-error-field-counts-as-error', async (t) => {
  const fixture = await reproduceFixture(async () => ({ matched: false, artifacts: [], error: 'CHECK_INVALID: bad selector' }));
  t.after(() => rm(fixture.stateDir, { recursive: true, force: true }));
  await assert.rejects(reproduceCandidate(fixture.input), /REPLAY_FAILED: CHECK_INVALID/);
});
