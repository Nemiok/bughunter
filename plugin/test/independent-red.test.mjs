import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runIndependentRed } from './independent-red.mjs';

async function reportFile(value) {
  const cwd = await mkdtemp(join(tmpdir(), 'bh-red-'));
  const reportPath = join(cwd, 'report.json');
  await writeFile(reportPath, typeof value === 'string' ? value : JSON.stringify(value));
  return { cwd, reportPath };
}

function observingSpawn(status = 1) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
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

test('playwright red result is counted from the JSON report', async () => {
  const { cwd, reportPath } = await reportFile(playwrightFailed);
  const { spawn, calls } = observingSpawn(1);
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
  const green = await reportFile(playwrightGreen);
  const greenSpawn = observingSpawn(1);
  await assert.rejects(runIndependentRed({
    runner: 'playwright', cwd: green.cwd, testPath: 'orders.spec.ts', reportPath: green.reportPath, spawn: greenSpawn.spawn,
  }), /RED_ASSERTIONS_REQUIRED/);
  const failed = await reportFile(playwrightFailed);
  await assert.rejects(runIndependentRed({
    runner: 'playwright', cwd: failed.cwd, testPath: 'orders.spec.ts', reportPath: failed.reportPath, spawn: () => ({ status: 0 }),
  }), /RED_EXPECTED/);
});

test('playwright top-level errors and other-file failures are rejected', async () => {
  const withError = {
    ...playwrightFailed,
    errors: [{ message: 'browser launch failed' }],
  };
  const errored = await reportFile(withError);
  const spawn = observingSpawn(1).spawn;
  await assert.rejects(runIndependentRed({
    runner: 'playwright', cwd: errored.cwd, testPath: 'orders.spec.ts', reportPath: errored.reportPath, spawn,
  }), /RED_REPORT_INVALID/);

  const foreign = {
    ...playwrightFailed,
    suites: [playwrightFailed.suites[0], {
      title: 'other', file: 'other.spec.ts', specs: [{
        title: 'other', file: 'other.spec.ts', tests: [{ title: 'other', results: [{ status: 'failed', error: { message: 'x' } }] }],
      }],
    }],
  };
  const foreignReport = await reportFile(foreign);
  await assert.rejects(runIndependentRed({
    runner: 'playwright', cwd: foreignReport.cwd, testPath: 'orders.spec.ts', reportPath: foreignReport.reportPath, spawn,
  }), /RED_REPORT_INVALID/);
});

test('playwright missing or malformed reports are rejected', async () => {
  const missing = await reportFile('{}');
  const spawn = observingSpawn(1).spawn;
  await assert.rejects(runIndependentRed({
    runner: 'playwright', cwd: missing.cwd, testPath: 'orders.spec.ts', reportPath: join(missing.cwd, 'missing.json'), spawn,
  }), /RED_REPORT_INVALID/);
  await assert.rejects(runIndependentRed({
    runner: 'playwright', cwd: missing.cwd, testPath: 'orders.spec.ts', reportPath: missing.reportPath, spawn,
  }), /RED_REPORT_INVALID/);
});

test('vitest red result is counted from the JSON report', async () => {
  const { cwd, reportPath } = await reportFile(vitestFailed);
  const { spawn, calls } = observingSpawn(1);
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
  const green = await reportFile(vitestGreen);
  const spawn = observingSpawn(1).spawn;
  await assert.rejects(runIndependentRed({
    runner: 'vitest', cwd: green.cwd, testPath: 'orders.test.ts', reportPath: green.reportPath, spawn,
  }), /RED_ASSERTIONS_REQUIRED/);
  const foreign = {
    ...vitestFailed,
    testResults: [vitestFailed.testResults[0], {
      name: 'other.test.ts', status: 'failed',
      assertionResults: [{ status: 'failed', title: 'other', failureMessages: ['x'] }],
    }],
  };
  const foreignReport = await reportFile(foreign);
  await assert.rejects(runIndependentRed({
    runner: 'vitest', cwd: foreignReport.cwd, testPath: 'orders.test.ts', reportPath: foreignReport.reportPath, spawn,
  }), /RED_REPORT_INVALID/);
});
