import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runIndependentRed } from './independent-red.mjs';

async function reportDir() {
  const cwd = await mkdtemp(join(tmpdir(), 'bh-red-'));
  return { cwd, reportPath: join(cwd, 'report.json') };
}

function spawnWriting(reportPath, value, status = 1) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    writeFileSync(reportPath, typeof value === 'string' ? value : JSON.stringify(value));
    return { status };
  };
  return { spawn, calls };
}

const playwrightFailed = {
  suites: [{
    title: 'orders', file: 'orders.spec.ts', specs: [{
      title: 'total', file: 'orders.spec.ts', tests: [{
        title: 'renders numeric total', results: [{ status: 'failed', error: { message: 'Total: NaN' } }],
      }],
    }],
  }],
  errors: [],
};

const playwrightGreen = {
  suites: [{
    title: 'orders', file: 'orders.spec.ts', specs: [{
      title: 'total', file: 'orders.spec.ts', tests: [{ title: 'renders', results: [{ status: 'passed' }] }],
    }],
  }],
  errors: [],
};

const vitestFailed = {
  numTotalTests: 1, numFailedTests: 1, success: false,
  testResults: [{
    name: 'orders.test.ts', status: 'failed',
    assertionResults: [{ status: 'failed', title: 'total', failureMessages: ['expected 1 received NaN'] }],
  }],
};

const vitestGreen = {
  numTotalTests: 1, numFailedTests: 0, success: true,
  testResults: [{
    name: 'orders.test.ts', status: 'passed',
    assertionResults: [{ status: 'passed', title: 'total' }],
  }],
};

test('playwright red result is counted from the JSON report written by the runner', async () => {
  const { cwd, reportPath } = await reportDir();
  const { spawn, calls } = spawnWriting(reportPath, playwrightFailed, 1);
  const result = await runIndependentRed({
    runner: 'playwright', cwd, testPath: 'orders.spec.ts', reportPath, spawn,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'npx');
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(calls[0].args, ['playwright', 'test', 'orders.spec.ts', '--workers=1', '--reporter=json']);
  assert.equal(calls[0].options.env.PLAYWRIGHT_JSON_OUTPUT_NAME, reportPath);
  assert.equal(result.exitCode, 1);
  assert.equal(result.failedAssertions, 1);
  assert.equal(result.reportSha256, createHash('sha256').update(JSON.stringify(playwrightFailed)).digest('hex'));
});

test('playwright green report and zero exit are rejected', async () => {
  const green = await reportDir();
  const greenSpawn = spawnWriting(green.reportPath, playwrightGreen, 1);
  await assert.rejects(runIndependentRed({
    runner: 'playwright', cwd: green.cwd, testPath: 'orders.spec.ts', reportPath: green.reportPath, spawn: greenSpawn.spawn,
  }), /RED_ASSERTIONS_REQUIRED/);
  const failed = await reportDir();
  await assert.rejects(runIndependentRed({
    runner: 'playwright', cwd: failed.cwd, testPath: 'orders.spec.ts', reportPath: failed.reportPath, spawn: () => ({ status: 0 }),
  }), /RED_EXPECTED/);
});

test('playwright top-level errors and other-file failures are rejected', async () => {
  const withError = { ...playwrightFailed, errors: [{ message: 'browser launch failed' }] };
  const errored = await reportDir();
  const errorSpawn = spawnWriting(errored.reportPath, withError, 1).spawn;
  await assert.rejects(runIndependentRed({
    runner: 'playwright', cwd: errored.cwd, testPath: 'orders.spec.ts', reportPath: errored.reportPath, spawn: errorSpawn,
  }), /RED_REPORT_INVALID/);

  const foreign = {
    ...playwrightFailed,
    suites: [playwrightFailed.suites[0], {
      title: 'other', file: 'other.spec.ts', specs: [{
        title: 'other', file: 'other.spec.ts', tests: [{ title: 'other', results: [{ status: 'failed', error: { message: 'x' } }] }],
      }],
    }],
  };
  const foreignReport = await reportDir();
  const foreignSpawn = spawnWriting(foreignReport.reportPath, foreign, 1).spawn;
  await assert.rejects(runIndependentRed({
    runner: 'playwright', cwd: foreignReport.cwd, testPath: 'orders.spec.ts', reportPath: foreignReport.reportPath, spawn: foreignSpawn,
  }), /RED_REPORT_INVALID/);
});

test('playwright missing or malformed reports are rejected', async () => {
  const missing = await reportDir();
  await assert.rejects(runIndependentRed({
    runner: 'playwright', cwd: missing.cwd, testPath: 'orders.spec.ts', reportPath: missing.reportPath, spawn: () => ({ status: 1 }),
  }), /RED_REPORT_INVALID/);
  const malformed = await reportDir();
  const malformedSpawn = spawnWriting(malformed.reportPath, '{}', 1).spawn;
  await assert.rejects(runIndependentRed({
    runner: 'playwright', cwd: malformed.cwd, testPath: 'orders.spec.ts', reportPath: malformed.reportPath, spawn: malformedSpawn,
  }), /RED_REPORT_INVALID/);
});

test('a stale red report is not accepted without a fresh runner report', async () => {
  const { cwd, reportPath } = await reportDir();
  writeFileSync(reportPath, JSON.stringify(playwrightFailed));
  await assert.rejects(runIndependentRed({
    runner: 'playwright', cwd, testPath: 'orders.spec.ts', reportPath, spawn: () => ({ status: 1 }),
  }), /RED_REPORT_INVALID/);
});

test('vitest red result is counted from the JSON report written by the runner', async () => {
  const { cwd, reportPath } = await reportDir();
  const { spawn, calls } = spawnWriting(reportPath, vitestFailed, 1);
  const result = await runIndependentRed({
    runner: 'vitest', cwd, testPath: 'orders.test.ts', reportPath, spawn,
  });
  assert.equal(calls[0].command, 'npx');
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(calls[0].args, ['vitest', 'run', 'orders.test.ts', '--reporter=json', `--outputFile=${reportPath}`]);
  assert.equal(result.failedAssertions, 1);
  assert.equal(result.reportSha256, createHash('sha256').update(JSON.stringify(vitestFailed)).digest('hex'));
});

test('vitest green and foreign-file failures are rejected', async () => {
  const green = await reportDir();
  const greenSpawn = spawnWriting(green.reportPath, vitestGreen, 1).spawn;
  await assert.rejects(runIndependentRed({
    runner: 'vitest', cwd: green.cwd, testPath: 'orders.test.ts', reportPath: green.reportPath, spawn: greenSpawn,
  }), /RED_ASSERTIONS_REQUIRED/);
  const foreign = {
    ...vitestFailed,
    testResults: [vitestFailed.testResults[0], {
      name: 'other.test.ts', status: 'failed',
      assertionResults: [{ status: 'failed', title: 'other', failureMessages: ['x'] }],
    }],
  };
  const foreignReport = await reportDir();
  const foreignSpawn = spawnWriting(foreignReport.reportPath, foreign, 1).spawn;
  await assert.rejects(runIndependentRed({
    runner: 'vitest', cwd: foreignReport.cwd, testPath: 'orders.test.ts', reportPath: foreignReport.reportPath, spawn: foreignSpawn,
  }), /RED_REPORT_INVALID/);
});
