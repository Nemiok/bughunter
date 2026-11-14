import assert from 'node:assert/strict';
import { test } from 'node:test';
import { replayAndMinimize } from '../src/reproduce.ts';
import type { StepBase } from '../src/types.ts';

function algorithmSteps(count: number): StepBase[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `step-${index}`,
    kind: 'step',
    timestamp: '2026-11-10T00:00:00.000Z',
    targetRef: '/target',
  }));
}

test('fake replay minimizes by removal and restores required steps exactly', async () => {
  const calls: string[][] = [];
  const result = await replayAndMinimize(algorithmSteps(3), 1, async (steps) => {
    calls.push(steps.map((step) => step.id));
    return steps.some((step) => step.id === 'step-1') && steps.some((step) => step.id === 'step-2');
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
    return true;
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
    return await new Promise<boolean>(() => undefined);
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
    await assert.rejects(replayAndMinimize(algorithmSteps(1), attempts, async () => true), /ATTEMPTS_INVALID/);
  }
});
