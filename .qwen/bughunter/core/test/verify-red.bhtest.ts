import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { TestRunner } from '../src/preset.ts';
import { classifyVerdict, shellArgument, verifyRed } from '../src/verify-red.ts';
import type { Execution, TestRunSummary } from '../src/verify-red.ts';

const execution = (patch: Partial<Execution> = {}): Execution => ({
  code: 0,
  signal: null,
  timedOut: false,
  stdout: '',
  stderr: '',
  ...patch,
});

const summary = (patch: Partial<TestRunSummary> = {}): TestRunSummary => ({
  singleFile: true,
  tests: 1,
  passed: 1,
  failed: 0,
  runtimeErrors: false,
  assertionFailuresOnly: true,
  cleanPass: true,
  names: ['проверка'],
  diagnostic: '',
  ...patch,
});

test('a failed assertion is red, anything else is broken', () => {
  const red = classifyVerdict(summary({ passed: 0, failed: 1, cleanPass: false, names: ['дубль заказа'] }), execution({ code: 1 }));
  assert.equal(red.status, 'red');
  assert.match(red.message, /дубль заказа/);

  const infrastructure = classifyVerdict(
    summary({ passed: 0, failed: 1, cleanPass: false, assertionFailuresOnly: false, diagnostic: 'SyntaxError' }),
    execution({ code: 1 }),
  );
  assert.equal(infrastructure.status, 'broken');
  assert.match(infrastructure.message, /SyntaxError/);
});

test('a clean pass is green', () => {
  const green = classifyVerdict(summary(), execution({ code: 0 }));
  assert.equal(green.status, 'green');
  assert.match(green.message, /проверка/);
});

test('infrastructure outcomes stay broken', () => {
  assert.equal(classifyVerdict(summary(), execution({ timedOut: true })).status, 'broken');
  assert.equal(classifyVerdict(summary(), execution({ error: new Error('spawn failed') })).status, 'broken');
  assert.equal(classifyVerdict(null, execution({ code: 2 })).status, 'broken');
  assert.equal(classifyVerdict(summary({ singleFile: false }), execution()).status, 'broken');
  assert.equal(classifyVerdict(summary({ tests: 0, passed: 0, cleanPass: false }), execution()).status, 'broken');
  assert.equal(classifyVerdict(summary({ runtimeErrors: true, cleanPass: false }), execution()).status, 'broken');
});

test('the report file is handed to the preset as raw text', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'bh-verify-raw-'));
  try {
    await writeFile(join(projectRoot, 'package.json'), '{}\n');
    const testFile = join(projectRoot, 'sample.test.ts');
    await writeFile(testFile, '');
    const seen: string[] = [];
    const runner: TestRunner = {
      kinds: ['raw'],
      resolveKind: async () => 'raw',
      command: async (_kind, input) => ({
        command: `printf 'REPORT:1' > ${shellArgument(input.reportFile)}`,
      }),
      parseReport: (_kind, raw) => {
        seen.push(raw);
        return summary({ names: ['raw report'] });
      },
      ownsProject: () => true,
    };

    const verdict = await verifyRed(testFile, { runner });
    assert.equal(verdict.status, 'green');
    assert.deepEqual(seen, ['REPORT:1'], 'пресет сам решает, как читать свой отчёт');
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('a long diagnostic is truncated, not dropped', () => {
  const verdict = classifyVerdict(
    summary({ passed: 0, failed: 1, cleanPass: false, diagnostic: 'x'.repeat(4000) }),
    execution({ code: 1 }),
  );
  assert.equal(verdict.status, 'red');
  assert.ok(verdict.message.length <= 1500, `message length ${verdict.message.length}`);
});
