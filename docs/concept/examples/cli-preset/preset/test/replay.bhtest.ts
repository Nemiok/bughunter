import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Candidate, Journal, Signal, StepBase } from '@bughunter/core';

import { createCliReplay } from '../src/replay.ts';
import { scanExecution } from '../src/detectors.ts';
import { cliReset } from '../src/reset.ts';
import type { CliCheck } from '../src/checks.ts';
import { stateFor } from './harness.ts';
import type { CliStep } from '../src/types.ts';

function candidateWith(patch: Omit<Partial<Candidate>, 'check' | 'steps'> & { steps: StepBase[]; check?: CliCheck }): Candidate {
  return {
    id: 'candidate-replay',
    runId: 'run-replay',
    sessionId: 'session-replay',
    target: 'show <name>',
    title: 'replay test',
    expected: 'ожидание',
    actual: 'факт',
    signalIds: [],
    signature: 'unused',
    artifacts: [],
    status: 'unprocessed',
    createdAt: new Date(0).toISOString(),
    ...patch,
  };
}

function journalFor(target: string): Journal {
  return {
    sessionId: 'session-replay',
    runId: 'run-replay',
    target,
    persona: 'бухгалтер',
    steps: [],
    createdAt: new Date(0).toISOString(),
  };
}

function step(patch: Partial<CliStep>): CliStep {
  return {
    id: 'step-1',
    kind: 'command',
    timestamp: new Date(0).toISOString(),
    targetRef: 'show <name>',
    argv: ['show', 'apple'],
    ...patch,
  };
}

test('replay executes setup exactly once', async () => {
  const state = await stateFor();
  try {
    const replay = createCliReplay();
    const duplicated = step({
      targetRef: 'list',
      setup: [['add', 'apple', '3']],
      argv: ['list'],
    });
    const once = await replay.replay([duplicated], {
      candidate: candidateWith({
        target: 'list',
        steps: [duplicated],
        // Одна подготовка — одно вхождение, поэтому оракул на одно вхождение не нарушен;
        // повторное выполнение setup дало бы два вхождения и matched=true.
        check: { kind: 'stdoutOccurrences', target: 'list', pointer: '"name":"apple"', expected: 1 },
      }),
      journal: journalFor('list'),
      stateDir: state.stateDir,
    });
    assert.equal(once.matched, false);
    await replay.close();
  } finally {
    await state.cleanup();
  }
});

test('replay resets, executes setup and each attempt sees only its own data', async () => {
  const state = await stateFor();
  const originalReset = cliReset.apply;
  let resets = 0;
  try {
    cliReset.apply = async (handle) => {
      resets += 1;
      return originalReset(handle);
    };
    const replay = createCliReplay();
    const stored = step({
      targetRef: 'show <name>',
      setup: [['add', 'apple', '3']],
      argv: ['show', 'apple'],
    });
    const first = await replay.replay([stored], {
      candidate: candidateWith({ steps: [stored], check: { kind: 'stdoutContains', target: 'show <name>', expected: '300' } }),
      journal: journalFor('show <name>'),
      stateDir: state.stateDir,
    });
    assert.equal(first.matched, false, 'подготовка не выполнилась: show не нашёл apple');
    assert.equal(resets, 1);

    // Другая подготовка в следующем повторе: apple из первой попытки не должен пережить сброс.
    const clean = await replay.replay([{ ...stored, setup: [['add', 'banana', '1']] } as CliStep], {
      candidate: candidateWith({
        steps: [stored],
        check: { kind: 'exitCode', target: 'show <name>', expected: 0 },
      }),
      journal: journalFor('show <name>'),
      stateDir: state.stateDir,
    });
    assert.equal(clean.matched, true, 'apple из прошлой попытки пережил сброс: show завершился успешно');
    assert.equal(resets, 2);
    await replay.close();
  } finally {
    cliReset.apply = originalReset;
    await state.cleanup();
  }
});

test('replay matches a signal signature and reports incomplete steps as unmatched', async () => {
  const state = await stateFor();
  try {
    const replay = createCliReplay();
    const anomalous = scanExecution({
      argv: ['add', 'x', 'abc'],
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: 'ok x total=NaN\n',
      stderr: '',
      durationMs: 1,
    }, 'add <name> <qty>', state.config).find((signal: Signal) => signal.kind === 'anomaly');
    assert.ok(anomalous !== undefined);

    const stored = step({ targetRef: 'add <name> <qty>', argv: ['add', 'x', 'abc'], signalIds: [anomalous.id] });
    const matched = await replay.replay([stored], {
      candidate: candidateWith({
        target: 'add <name> <qty>',
        steps: [stored],
        signalIds: [anomalous.id],
        signature: anomalous.signature,
      }),
      journal: journalFor('add <name> <qty>'),
      stateDir: state.stateDir,
    });
    assert.equal(matched.matched, true, 'сигнатура симптома должна совпасть при повторе');

    const incomplete = await replay.replay([{ ...stored, argv: undefined } as CliStep], {
      candidate: candidateWith({
        target: 'add <name> <qty>',
        steps: [stored],
        signalIds: [anomalous.id],
        signature: anomalous.signature,
      }),
      journal: journalFor('add <name> <qty>'),
      stateDir: state.stateDir,
    });
    assert.equal(incomplete.matched, false);
    await replay.close();
  } finally {
    await state.cleanup();
  }
});

test('abort closes the active replay session and later replays still work', async () => {
  const state = await stateFor();
  try {
    const replay = createCliReplay();
    await replay.abort();
    const stored = step({ targetRef: 'list', argv: ['list'] });
    const outcome = await replay.replay([stored], {
      candidate: candidateWith({ target: 'list', steps: [stored], check: { kind: 'exitCode', target: 'list', expected: 2 } }),
      journal: journalFor('list'),
      stateDir: state.stateDir,
    });
    assert.equal(outcome.matched, true);
    assert.equal(outcome.artifacts.length, 1);
    await replay.close();
  } finally {
    await state.cleanup();
  }
});
