import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { parseCliReport } from '../src/test-runner.ts';
import { presetRoot } from './harness.ts';

const reporter = join(presetRoot, 'src', 'test-report.ts');

async function testFile(directory: string, name: string, source: string): Promise<string> {
  const file = join(directory, name);
  await writeFile(file, source, 'utf8');
  return file;
}

async function reportFor(file: string, report: string): Promise<{ status: number | null; raw: unknown }> {
  const run = spawnSync(process.execPath, [reporter, file, report], {
    cwd: presetRoot,
    encoding: 'utf8',
    env: { ...process.env, NODE_TEST_CONTEXT: 'inherited-from-parent' },
  });
  return {
    status: run.status,
    raw: JSON.parse(await readFile(report, 'utf8')) as unknown,
  };
}

test('the reporter distinguishes passing, assertion-failing and broken test files', async () => {
  const directory = await mkdtemp(join(presetRoot, '.test-report-'));
  try {
    const passingFile = await testFile(directory, 'passing.mjs', [
      "import assert from 'node:assert/strict';",
      "import { test } from 'node:test';",
      "test('сложение', () => assert.equal(2 + 2, 4));",
      '',
    ].join('\n'));
    const passing = await reportFor(passingFile, join(directory, 'passing.json'));
    const green = parseCliReport(passing.raw, passingFile);
    assert.equal(passing.status, 0);
    assert.equal(green.singleFile, true);
    assert.equal(green.tests, 1);
    assert.equal(green.passed, 1);
    assert.equal(green.failed, 0);
    assert.equal(green.cleanPass, true);
    assert.equal(green.runtimeErrors, false);
    assert.equal(green.assertionFailuresOnly, false);
    assert.deepEqual(green.names, ['сложение']);

    const failingFile = await testFile(directory, 'failing.mjs', [
      "import assert from 'node:assert/strict';",
      "import { test } from 'node:test';",
      "test('падающий ассерт', () => assert.equal(1, 2));",
      '',
    ].join('\n'));
    const failing = await reportFor(failingFile, join(directory, 'failing.json'));
    const red = parseCliReport(failing.raw, failingFile);
    assert.equal(failing.status, 1);
    assert.equal(red.singleFile, true);
    assert.equal(red.tests, 1);
    assert.equal(red.failed, 1);
    assert.equal(red.assertionFailuresOnly, true);
    assert.equal(red.runtimeErrors, false);
    assert.equal(red.cleanPass, false);

    const brokenFile = await testFile(directory, 'broken.mjs', [
      "import './missing-module.mjs';",
      "import { test } from 'node:test';",
      "test('не дойдёт', () => {});",
      '',
    ].join('\n'));
    const broken = await reportFor(brokenFile, join(directory, 'broken.json'));
    const infrastructure = parseCliReport(broken.raw, brokenFile);
    assert.equal(broken.status, 1);
    assert.equal(infrastructure.singleFile, true);
    assert.equal(infrastructure.runtimeErrors, true);
    assert.equal(infrastructure.cleanPass, false);
    assert.match(infrastructure.diagnostic, /missing-module/);

    const mismatched = parseCliReport(passing.raw, join(directory, 'another.test.mjs'));
    assert.equal(mismatched.singleFile, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a malformed report is not mistaken for a clean pass', () => {
  const summary = parseCliReport({ totals: { tests: 'много' }, tests: 'нет' }, '/tmp/none.test.ts');
  assert.equal(summary.singleFile, false);
  assert.equal(summary.tests, 0);
  assert.equal(summary.cleanPass, false);
  assert.equal(summary.runtimeErrors, true);
});
