import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { verifyRed } from '../src/tests/verify-red.ts';

const fixtures = {
  jest: resolve(import.meta.dirname, '../fixtures/jest-project'),
  vitest: resolve(import.meta.dirname, '../fixtures/vitest-project'),
  demo: resolve(import.meta.dirname, '../fixtures/buggy-app'),
};
const temporaryDirectories: string[] = [];
const cases = [
  { name: 'red', status: 'red', diagnostic: /expected|toBe|received/i },
  { name: 'green', status: 'green', diagnostic: /green assertion|passed/i },
  { name: 'broken', status: 'broken', diagnostic: /setup exploded/i },
  { name: 'setup-hook', status: 'broken', diagnostic: /setup hook exploded/i },
  { name: 'teardown-hook', status: 'broken', diagnostic: /teardown hook exploded/i },
  { name: 'syntax', status: 'broken', diagnostic: /syntax|unexpected|expected|transform/i },
  { name: 'import', status: 'broken', diagnostic: /missing-module|cannot find module|failed to resolve/i },
  { name: 'timeout', status: 'broken', diagnostic: /timed out|timeout/i },
] as const;

after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

for (const framework of ['jest', 'vitest'] as const) {
  test(`${framework} one-file verdict matrix`, async (t) => {
    const extension = framework === 'jest' ? 'js' : 'ts';
    for (const fixture of cases) {
      await t.test(`${fixture.name} is ${fixture.status}`, async () => {
        const result = await verifyRed(join(fixtures[framework], `${fixture.name}.test.${extension}`), {
          ...(fixture.name === 'timeout' ? { timeoutMs: 300 } : {}),
        });
        assert.equal(result.status, fixture.status, result.message);
        assert.match(result.message, fixture.diagnostic);
        assert.ok(result.message.length <= 1500, `message length: ${result.message.length}`);
      });
    }
  });
}

test('playwright e2e verdicts use the project-local JSON reporter', async (t) => {
  const e2eRoot = join(fixtures.demo, 'e2e/bughunter');
  await mkdir(e2eRoot, { recursive: true });
  const directory = await mkdtemp(join(e2eRoot, 'verdict-'));
  temporaryDirectories.push(directory);
  const playwrightCases = [
    { name: 'red', status: 'red', body: 'expect(1).toBe(2);', diagnostic: /expected|received|toBe/i },
    { name: 'green', status: 'green', body: 'expect(1).toBe(1);', diagnostic: /green assertion|passed/i },
    { name: 'broken', status: 'broken', body: 'throw new Error("setup exploded");', diagnostic: /setup exploded/i },
  ] as const;
  for (const fixture of playwrightCases) {
    const file = join(directory, `${fixture.name}.spec.ts`);
    await writeFile(file, `import { expect, test } from '@playwright/test';\n\ntest('${fixture.name} assertion', () => { ${fixture.body} });\n`, 'utf8');
    await t.test(`${fixture.name} is ${fixture.status}`, async () => {
      const result = await verifyRed(file, { kind: 'e2e' });
      assert.equal(result.status, fixture.status, result.message);
      assert.match(result.message, fixture.diagnostic);
      assert.ok(result.message.length <= 1500, `message length: ${result.message.length}`);
    });
  }
});

test('explicit unit command takes precedence over the framework default', async () => {
  const command = `${JSON.stringify(join(fixtures.jest, 'node_modules/.bin/jest'))}`;
  const result = await verifyRed(join(fixtures.jest, 'green.test.js'), { unitCommand: command });
  assert.equal(result.status, 'green', result.message);
});

test('passing report followed by nonzero exit is broken', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bh-verify-red-exit-'));
  temporaryDirectories.push(directory);
  const helper = join(directory, 'passing-report-exit.cjs');
  await writeFile(helper, `
    const { spawn } = require('node:child_process');
    const runner = require('node:path').join(${JSON.stringify(fixtures.jest)}, 'node_modules/jest/bin/jest.js');
    const child = spawn(process.execPath, [runner, ...process.argv.slice(2)], { stdio: 'inherit' });
    child.once('close', () => { process.exit(7); });
  `, 'utf8');

  const result = await verifyRed(join(fixtures.jest, 'green.test.js'), {
    unitCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(helper)}`,
  });
  assert.equal(result.status, 'broken', result.message);
  assert.match(result.message, /passed|exit 7/i);
});

test('zero discovered tests and reporter failure are broken, not red', async () => {
  const empty = join(fixtures.jest, 'empty.test.js');
  await writeFile(empty, '', 'utf8');
  try {
    const emptyResult = await verifyRed(empty);
    assert.equal(emptyResult.status, 'broken', emptyResult.message);
    assert.match(emptyResult.message, /no tests|zero|not found|no report|at least one test|0 total/i);

    const reporterResult = await verifyRed(join(fixtures.jest, 'red.test.js'), {
      unitCommand: `${JSON.stringify(process.execPath)} -e "process.exit(1)"`,
    });
    assert.equal(reporterResult.status, 'broken', reporterResult.message);
  } finally {
    await rm(empty, { force: true });
  }
});

test('timeout kills descendants spawned by the configured command', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bh-verify-red-'));
  temporaryDirectories.push(directory);
  const pidFile = join(directory, 'child.pid');
  const helper = join(directory, 'spawn-child.cjs');
  await writeFile(helper, `
    const { spawn } = require('node:child_process');
    const { writeFileSync } = require('node:fs');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
    setInterval(() => {}, 1000);
  `, 'utf8');

  const result = await verifyRed(join(fixtures.jest, 'green.test.js'), {
    unitCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(helper)}`,
    timeoutMs: 300,
  });
  assert.equal(result.status, 'broken', result.message);
  assert.match(result.message, /timed out/i);

  const childPid = Number(await readFile(pidFile, 'utf8'));
  const deadline = Date.now() + 2000;
  while (true) {
    try {
      process.kill(childPid, 0);
    } catch (error) {
      assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH');
      break;
    }
    if (Date.now() >= deadline) assert.fail(`descendant ${childPid} survived timeout`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
});
