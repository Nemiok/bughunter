import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyVerdict } from '../src/verify-red.ts';
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

test('a long diagnostic is truncated, not dropped', () => {
  const verdict = classifyVerdict(
    summary({ passed: 0, failed: 1, cleanPass: false, diagnostic: 'x'.repeat(4000) }),
    execution({ code: 1 }),
  );
  assert.equal(verdict.status, 'red');
  assert.ok(verdict.message.length <= 1500, `message length ${verdict.message.length}`);
});
