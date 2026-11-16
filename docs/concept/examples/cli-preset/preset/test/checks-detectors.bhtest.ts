import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cliChecks, cliCheckViolated, validateCliCheck } from '../src/checks.ts';
import type { CliCheck } from '../src/checks.ts';
import { cliDetectors, scanExecution } from '../src/detectors.ts';
import { openCliSession, performCommand } from '../src/session.ts';
import type { CommandExecution } from '../src/session.ts';
import { cliCheckSignature } from '../src/signature.ts';
import { stateFor } from './harness.ts';

const clean: CommandExecution = {
  argv: ['list'], exitCode: 0, signal: null, timedOut: false, stdout: '[]\n', stderr: '', durationMs: 5,
};

test('every declared check kind has a violation rule and validates its shape', () => {
  assert.deepEqual([...cliChecks.kinds], [
    'exitCode', 'stdoutContains', 'stdoutNotContains', 'stderrContains', 'stderrNotContains', 'stdoutOccurrences',
  ]);
  assert.throws(() => validateCliCheck({ kind: 'status', target: 'list', expected: 0 }), /CHECK_INVALID/);
  assert.throws(() => validateCliCheck({ kind: 'exitCode', target: '', expected: 0 }), /CHECK_INVALID/);
  assert.throws(() => validateCliCheck({ kind: 'exitCode', target: 'list' }), /CHECK_INVALID/);
  assert.throws(() => validateCliCheck({ kind: 'stdoutContains', target: 'list', expected: 1 }), /CHECK_INVALID/);
  assert.throws(() => validateCliCheck({ kind: 'stdoutOccurrences', target: 'list', expected: 1 }), /CHECK_INVALID/);
  assert.throws(
    () => validateCliCheck({ kind: 'stdoutOccurrences', target: 'list', pointer: 'x', expected: -1 } as CliCheck),
    /CHECK_INVALID/,
  );
  assert.doesNotThrow(() => validateCliCheck({ kind: 'stdoutOccurrences', target: 'list', pointer: 'x', expected: 0 } as CliCheck));
});

test('checks judge only the last execution of the session', async () => {
  const state = await stateFor();
  const handle = await openCliSession({
    runId: 'run-checks', target: 'add <name> <qty>', persona: 'бухгалтер', stateDir: state.stateDir,
  });
  try {
    await performCommand(handle, { argv: ['add', 'x', 'abc'] }, state.config);
    assert.equal(await cliCheckViolated(handle, { kind: 'exitCode', target: 'add <name> <qty>', expected: 2 }), true);
    assert.equal(await cliCheckViolated(handle, { kind: 'exitCode', target: 'add <name> <qty>', expected: 0 }), false);
    assert.equal(await cliCheckViolated(handle, { kind: 'stdoutContains', target: 'add <name> <qty>', expected: 'NaN' }), false);
    assert.equal(await cliCheckViolated(handle, { kind: 'stdoutNotContains', target: 'add <name> <qty>', expected: 'NaN' }), true);
    assert.equal(await cliCheckViolated(handle, { kind: 'stderrContains', target: 'add <name> <qty>', expected: 'количество' }), true);
    assert.equal(await cliCheckViolated(handle, { kind: 'stderrNotContains', target: 'add <name> <qty>', expected: '    at ' }), false);

    await performCommand(handle, { argv: ['add', 'apple', '3'] }, state.config);
    assert.equal(
      await cliCheckViolated(handle, { kind: 'stdoutOccurrences', target: 'add <name> <qty>', pointer: 'ok', expected: 1 } as CliCheck),
      false,
    );
    assert.equal(
      await cliCheckViolated(handle, { kind: 'stdoutOccurrences', target: 'add <name> <qty>', pointer: 'ok', expected: 2 } as CliCheck),
      true,
    );
  } finally {
    await handle.close();
    await state.cleanup();
  }
});

test('a check on an empty session is not violated and the preload signature includes the pointer', async () => {
  const state = await stateFor();
  const handle = await openCliSession({
    runId: 'run-empty-check', target: 'list', persona: 'бухгалтер', stateDir: state.stateDir,
  });
  try {
    assert.equal(await cliCheckViolated(handle, { kind: 'exitCode', target: 'list', expected: 42 }), false);
  } finally {
    await handle.close();
    await state.cleanup();
  }
  const one = cliCheckSignature({ kind: 'stdoutOccurrences', target: 'list', pointer: 'a', expected: 1 }, 'list');
  const two = cliCheckSignature({ kind: 'stdoutOccurrences', target: 'list', pointer: 'b', expected: 1 }, 'list');
  assert.notEqual(one, two);
});

test('detector scan flags unexpected exit, stack, anomaly, timeout and signal', async () => {
  const state = await stateFor();
  const scan = (execution: CommandExecution) => scanExecution(execution, 'list', state.config);
  try {
    assert.deepEqual(scan(clean), []);

    const failed = scan({ ...clean, exitCode: 3 });
    assert.equal(failed.some((signal) => signal.kind === 'exit-code'), true);

    const expected = scan({ ...clean, exitCode: 2 });
    assert.equal(expected.some((signal) => signal.kind === 'exit-code'), false);

    const stack = scan({ ...clean, exitCode: 1, stderr: "TypeError: x\n    at read (file.js:1:1)" });
    assert.equal(stack.some((signal) => signal.kind === 'stderr-stack'), true);

    const anomaly = scan({ ...clean, stdout: 'ok x total=NaN\n' });
    assert.equal(anomaly.some((signal) => signal.kind === 'anomaly'), true);

    const timedOut = scan({ ...clean, exitCode: null, timedOut: true });
    assert.match(timedOut[0]?.message ?? '', /EXECUTION_TIMEOUT/);

    const signalled = scan({ ...clean, exitCode: null, signal: 'SIGKILL' });
    assert.match(signalled[0]?.message ?? '', /EXECUTION_SIGNAL/);

    const spawnError = scan({ ...clean, exitCode: null, spawnError: 'ENOENT' });
    assert.match(spawnError[0]?.message ?? '', /EXECUTION_FAILED/);
  } finally {
    await state.cleanup();
  }
});

test('the Detectors hook drains pending signals exactly once', async () => {
  const state = await stateFor();
  const handle = await openCliSession({
    runId: 'run-drain', target: 'add <name> <qty>', persona: 'бухгалтер', stateDir: state.stateDir,
  });
  try {
    await performCommand(handle, { argv: ['add', 'x', 'abc'] }, state.config);
    const first = await cliDetectors.scan(handle);
    assert.equal(first.some((signal) => signal.kind === 'anomaly'), true);
    assert.deepEqual(await cliDetectors.scan(handle), []);
  } finally {
    await handle.close();
    await state.cleanup();
  }
});
