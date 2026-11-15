import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';

import { createRun, writeJsonAtomic } from '@bughunter/core';
import type { Candidate, Journal } from '@bughunter/core';

import type { NodeConfig } from '../src/config.ts';
import { exportNodeTest, nodeExportTarget, nodeTestGenerator } from '../src/export-vitest.ts';
import { apiKind, nodeTestKinds, nodeTestRunner, verifyNodeRed } from '../src/test-runner.ts';
import type { NodeStep } from '../src/types.ts';
import { startFixture, stateForFixture, vitestProject } from './harness.ts';
import type { Fixture, FixtureState } from './harness.ts';

const createdAt = '2026-11-15T00:00:00.000Z';
const fixtureRoot = resolve(import.meta.dirname, '../../../fixtures/node-api-app');

let fixture: Fixture;
let state: FixtureState;

before(async () => {
  fixture = await startFixture();
  state = await stateForFixture(fixture.baseUrl);
});

after(async () => {
  await state?.cleanup();
  await fixture?.stop();
});

const steps: NodeStep[] = [{
  id: 'step-one',
  kind: 'act',
  timestamp: createdAt,
  targetRef: 'POST /orders',
  method: 'POST',
  path: '/orders',
  body: { qty: -5 },
  status: 200,
  durationMs: 3,
}];

/** N2: отрицательное количество принято, оракул ждёт 400. */
function seededCandidate(runId: string): Candidate {
  return {
    id: 'candidate-n2',
    runId,
    sessionId: 'session-export',
    target: 'POST /orders',
    title: 'Отрицательное количество принимается',
    expected: '400 на отрицательное количество',
    actual: '200 и отрицательный итог заказа',
    signalIds: [],
    signature: 'signature-n2',
    steps,
    artifacts: [],
    status: 'confirmed',
    createdAt,
    reproduction: { status: 'reproduced', attempts: 1 },
    minimalSteps: steps,
    check: { kind: 'status', target: 'POST /orders', expected: 400 },
  };
}

async function generate(runId = 'run-export'): Promise<string> {
  return nodeTestGenerator.generate({
    candidate: seededCandidate(runId),
    initialTarget: 'POST /orders',
    stateDir: state.stateDir,
  });
}

async function confirmedBug(config: NodeConfig): Promise<{ runId: string; bugId: string }> {
  const run = await createRun('full', undefined, {
    config,
    projectRoot: state.stateDir,
    stateDir: state.stateDir,
    personas: ['ревизор'],
    targets: ['POST /orders'],
  });
  const value = seededCandidate(run.id);
  await mkdir(join(state.stateDir, 'runs', run.id, 'candidates'), { recursive: true });
  await mkdir(join(state.stateDir, 'runs', run.id, 'journals'), { recursive: true });
  await writeJsonAtomic(join(state.stateDir, 'runs', run.id, 'candidates', `${value.id}.json`), value);
  const journal: Journal = {
    sessionId: value.sessionId,
    runId: run.id,
    target: value.target,
    persona: 'ревизор',
    steps,
    createdAt,
  };
  await writeJsonAtomic(join(state.stateDir, 'runs', run.id, 'journals', `${value.sessionId}.json`), journal);
  await writeJsonAtomic(join(state.stateDir, 'known-bugs.json'), [{
    id: 'bug-node-1',
    signature: value.signature,
    title: value.title,
    target: value.target,
    reason: 'confirmed',
    sourceCandidate: value.id,
    createdAt,
    updatedAt: createdAt,
  }]);
  return { runId: run.id, bugId: 'bug-node-1' };
}

test('the generated test replays the request sequence and asserts one symptom', async () => {
  const source = await generate();
  assert.match(source, /from 'vitest'/);
  assert.match(source, /fetch\(/);
  assert.match(source, /\/__reset/, 'сброс стенда перед прогоном обязателен');
  assert.match(source, /"qty":-5/);
  assert.equal(
    (source.match(/await request\(/g) ?? []).length,
    steps.length + 1,
    'по запросу на каждый шаг журнала плюс сброс',
  );
  assert.equal((source.match(/expect\(/g) ?? []).length, 1, 'один симптом — один expect');
  assert.ok(!source.includes('sleep'), 'искусственные ожидания запрещены');
  assert.ok(!source.includes('setTimeout'), 'искусственные ожидания запрещены');
  assert.ok(source.includes(fixture.baseUrl), 'тест идёт на стенд из конфига');

  assert.equal(nodeExportTarget.kind, apiKind);
  assert.equal(nodeExportTarget.fileName('bug-node-1'), 'bug-node-1.test.ts');
  assert.equal(nodeExportTarget.dir(state.config), state.config.tests.generated.dir);
});

test('the generated test is red on the seeded bug', async () => {
  const project = await vitestProject();
  try {
    const file = join(project.root, 'bughunter', 'bug-node-1.test.ts');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, await generate(), 'utf8');
    const verdict = await verifyNodeRed(file, { kind: apiKind });
    assert.equal(verdict.status, 'red', verdict.message);
  } finally {
    await project.cleanup();
  }
});

test('export writes once and refuses to overwrite a human edit', async () => {
  const { runId, bugId } = await confirmedBug(state.config);
  const exported = await exportNodeTest({ runId, bugId, stateDir: state.stateDir });
  assert.equal(exported.placedInProject, false, 'вне проекта тест остаётся в каталоге прогона');
  assert.match(exported.file, /runs\/[^/]+\/api\/bug-node-1\.test\.ts$/);

  await writeFile(exported.file, '// правка человека\n', 'utf8');
  await assert.rejects(
    exportNodeTest({ runId, bugId, stateDir: state.stateDir }),
    /EXPORT_FILE_EXISTS/,
  );
});

test('resolveKind maps the api kind to vitest and detects the project runner otherwise', async () => {
  assert.deepEqual(nodeTestRunner.kinds, [...nodeTestKinds]);
  const generated = join(fixtureRoot, 'test', 'bughunter', 'bug-node-1.test.ts');
  assert.equal(
    await nodeTestRunner.resolveKind({ projectRoot: fixtureRoot, testFile: generated, requested: apiKind }),
    'vitest',
  );
  assert.equal(
    await nodeTestRunner.resolveKind({ projectRoot: fixtureRoot, testFile: join(fixtureRoot, 'test', 'seeded.test.js') }),
    'vitest',
  );
  assert.equal(nodeTestRunner.ownsProject({ devDependencies: { vitest: '^3.2.4' } }), true);
  assert.equal(nodeTestRunner.ownsProject({ dependencies: { vitest: '^3.2.4' } }), true);
  assert.equal(nodeTestRunner.ownsProject({ dependencies: { express: '^4.0.0' } }), false);
});
