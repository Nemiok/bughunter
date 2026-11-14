import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  readCandidate,
  readRun,
  recordCandidateTest,
  recordTargetExploration,
  recordRunStage,
  resumeRun,
  triageCandidate,
  updateRun,
  writeJsonAtomic,
} from '@bughunter/core';
import type { Candidate } from '@bughunter/core';
import type { Step } from '../src/types.ts';
import type { WebConfig as Config } from '../src/config.ts';
import { createRun, finishRun } from '../src/runs.ts';

const createdAt = '2026-11-10T00:00:00.000Z';

function config(): Config {
  return {
    baseUrl: 'https://example.test/',
    allowedOrigins: ['https://example.test'],
    routes: ['/', '/orders'],
    targetMap: {},
    baseBranch: 'main',
    limits: { stepsPerSession: 60, candidatesPerRun: 20 },
    safety: { forbiddenActionText: [], readOnly: false },
    testDataPrefix: 'bh_',
    detectors: { ignoreConsole: [], ignoreRequests: [], anomalyTexts: [], errorBoundarySelector: '[data-error-boundary]' },
    tests: { unit: { command: null }, generated: { dir: 'e2e/bughunter' } },
  };
}

function candidate(runId: string, id: string, patch: Partial<Candidate> = {}): Candidate {
  return {
    id,
    runId,
    sessionId: `session-${id}`,
    target: '/orders',
    title: `Title ${id}`,
    expected: 'Expected result',
    actual: 'Actual result',
    signalIds: ['signal-one'],
    signature: `signature-${id}`,
    steps: [],
    artifacts: [],
    status: 'unprocessed',
    createdAt,
    reproduction: { status: 'unreproduced', attempts: 0 },
    ...patch,
  };
}

async function fixture(t: TestContext): Promise<{ stateDir: string; runId: string; runRoot: string }> {
  const stateDir = await mkdtemp(join(tmpdir(), 'bh-report-resume-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const run = await createRun('full', undefined, { config: config(), projectRoot: stateDir, stateDir });
  return { stateDir, runId: run.id, runRoot: join(stateDir, 'runs', run.id) };
}

async function writeCandidate(stateDir: string, value: Candidate): Promise<void> {
  await writeJsonAtomic(join(stateDir, 'runs', value.runId, 'candidates', `${value.id}.json`), value);
}

async function completeConfiguredRoutes(runId: string, stateDir: string): Promise<void> {
  for (const route of config().routes) await recordTargetExploration(runId, route, 'done', stateDir);
}

test('finish writes a deterministic escaped Markdown report with steps, artifacts, tests, and review reasons', async (t) => {
  const { stateDir, runId, runRoot } = await fixture(t);
  const steps: Step[] = [{
    id: 'step-one', kind: 'act', action: 'fill', value: 'bad]\n# forged', locator: 'page.getByTestId("name")',
    timestamp: createdAt, targetRef: '/orders',
  }];
  const confirmed = candidate(runId, 'candidate-confirmed', {
    title: 'Confirmed [save] *failure*',
    status: 'confirmed',
    createdAt: '2026-11-10T00:00:02.000Z',
    steps,
    minimalSteps: steps,
    reproduction: { status: 'reproduced', attempts: 3 },
    artifacts: [`runs/${runId}/artifacts/candidate-confirmed/trace.zip`],
    review: { status: 'confirmed', reason: 'Owned by the application' },
    tests: { e2e: 'e2e/confirmed.spec.ts', unit: 'unit/confirmed.test.ts' },
  });
  const rejected = candidate(runId, 'candidate-rejected', {
    status: 'rejected',
    createdAt: '2026-11-10T00:00:01.000Z',
    reproduction: { status: 'reproduced', attempts: 1 },
    review: { status: 'rejected', reason: 'Expected [behavior]\n# forged heading' },
  });
  const duplicate = candidate(runId, 'candidate-duplicate', {
    status: 'duplicate', duplicateOf: 'known-one', reproduction: { status: 'reproduced', attempts: 1 },
    review: { status: 'duplicate', reason: 'Same signature' },
  });
  const unreproduced = candidate(runId, 'candidate-unreproduced', {
    reproduction: { status: 'unreproduced', attempts: 2 },
  });
  for (const value of [confirmed, rejected, duplicate, unreproduced]) await writeCandidate(stateDir, value);
  await completeConfiguredRoutes(runId, stateDir);

  const first = await finishRun(runId, stateDir);
  assert.deepEqual(first, { report: join(runRoot, 'report.md') });
  const report = await readFile(first.report, 'utf8');
  const second = await finishRun(runId, stateDir);
  assert.deepEqual(second, first);
  assert.equal(await readFile(second.report, 'utf8'), report);
  assert.equal((await readRun(runId, stateDir)).status, 'finished');

  assert.match(report, /## Confirmed\n/);
  assert.ok(report.includes('Confirmed \\[save\\] \\*failure\\*'));
  assert.match(report, /1\..*fill/);
  assert.ok(report.includes('bad\\] \\# forged'));
  assert.match(report, /artifacts\/candidate-confirmed\/trace\.zip/);
  assert.ok(!report.includes(`runs/${runId}/artifacts`));
  assert.match(report, /e2e: e2e\/confirmed\.spec\.ts/);
  assert.match(report, /unit: unit\/confirmed\.test\.ts/);
  assert.match(report, /## Rejected\n/);
  assert.ok(report.includes('Expected \\[behavior\\] \\# forged heading'));
  assert.match(report, /## Duplicates\n/);
  assert.match(report, /Same signature/);
  assert.match(report, /## Unreproduced\n/);
  assert.match(report, /candidate-unreproduced/);
  assert.match(report, /## Pending\n\nNone\./);
  assert.ok(!report.includes('\n# forged heading'));
});

test('resume returns persisted route and stage state and only candidates with remaining work', async (t) => {
  const { stateDir, runId } = await fixture(t);
  await updateRun(runId, {
    status: 'reviewing',
    stages: { explore: 'done', reproduce: 'running', triage: 'running', export: 'pending' },
    targetStages: { '/': 'done', '/orders': 'exploring' },
  }, stateDir);
  const values = [
    candidate(runId, 'done-rejected', { status: 'rejected', createdAt: '2026-11-10T00:00:01.000Z' }),
    candidate(runId, 'done-duplicate', { status: 'duplicate', createdAt: '2026-11-10T00:00:02.000Z' }),
    candidate(runId, 'done-unreproduced', {
      createdAt: '2026-11-10T00:00:03.000Z', reproduction: { status: 'unreproduced', attempts: 3 },
    }),
    candidate(runId, 'done-confirmed', {
      status: 'confirmed', createdAt: '2026-11-10T00:00:04.000Z',
      reproduction: { status: 'reproduced', attempts: 1 }, tests: { e2e: 'e2e/done.spec.ts' },
    }),
    candidate(runId, 'pending-review', {
      createdAt: '2026-11-10T00:00:05.000Z', reproduction: { status: 'reproduced', attempts: 1 },
    }),
    candidate(runId, 'pending-tests', {
      status: 'confirmed', createdAt: '2026-11-10T00:00:06.000Z', reproduction: { status: 'reproduced', attempts: 1 },
    }),
    candidate(runId, 'pending-reproduction', { createdAt: '2026-11-10T00:00:07.000Z' }),
  ];
  for (const value of values) await writeCandidate(stateDir, value);

  const resumed = await resumeRun(runId, stateDir);
  assert.equal(resumed.run.id, runId);
  assert.equal(resumed.run.status, 'reviewing');
  assert.deepEqual(resumed.run.stages, { explore: 'done', reproduce: 'running', triage: 'running', export: 'pending' });
  assert.deepEqual(resumed.run.targetStages, { '/': 'done', '/orders': 'exploring' });
  assert.deepEqual(resumed.pendingCandidates.map((value) => value.id), [
    'pending-review', 'pending-tests', 'pending-reproduction',
  ]);

  await assert.rejects(finishRun(runId, stateDir), /RUN_INCOMPLETE/);
  const unfinished = await resumeRun(runId, stateDir);
  assert.equal(unfinished.run.id, runId);
  assert.equal(unfinished.run.status, 'reviewing');
  assert.deepEqual(unfinished.pendingCandidates.map((value) => value.id), resumed.pendingCandidates.map((value) => value.id));
  assert.deepEqual(await readdir(join(stateDir, 'runs')), [runId]);
});

test('route, run, review, and created-test transitions persist immediately', async (t) => {
  const { stateDir, runId, runRoot } = await fixture(t);
  await recordTargetExploration(runId, '/', 'exploring', stateDir);
  let run = await readRun(runId, stateDir);
  assert.equal(run.status, 'exploring');
  assert.deepEqual(run.targetStages, { '/': 'exploring', '/orders': 'pending' });
  assert.equal(run.stages.explore, 'running');

  await recordTargetExploration(runId, '/', 'done', stateDir);
  assert.equal((await readRun(runId, stateDir)).stages.explore, 'running');
  await recordTargetExploration(runId, '/orders', 'done', stateDir);
  run = await readRun(runId, stateDir);
  assert.equal(run.stages.explore, 'done');
  assert.deepEqual(run.targetStages, { '/': 'done', '/orders': 'done' });

  await recordRunStage(runId, 'reproduce', 'running', stateDir);
  assert.equal((await readRun(runId, stateDir)).status, 'reproducing');
  await recordRunStage(runId, 'reproduce', 'done', stateDir);
  assert.equal((await readRun(runId, stateDir)).stages.reproduce, 'done');

  const reviewed = candidate(runId, 'reviewed', { reproduction: { status: 'reproduced', attempts: 1 } });
  await writeCandidate(stateDir, reviewed);
  const rejected = await triageCandidate({
    runId, candidateId: reviewed.id, verdict: 'rejected', reason: 'Third-party response', stateDir,
  });
  assert.deepEqual(rejected.review, { status: 'rejected', reason: 'Third-party response' });
  assert.deepEqual((await readCandidate(runId, reviewed.id, stateDir)).review, rejected.review);

  const unitFile = join(runRoot, 'unit', 'reviewed.test.ts');
  await recordCandidateTest(runId, reviewed.id, 'unit', unitFile, stateDir);
  assert.equal((await readCandidate(runId, reviewed.id, stateDir)).tests?.unit, 'unit/reviewed.test.ts');
});

test('finish rejects pending candidates without writing a report or marking finished', async (t) => {
  const { stateDir, runId, runRoot } = await fixture(t);
  const pending = candidate(runId, 'pending-finish');
  await writeCandidate(stateDir, pending);

  await assert.rejects(finishRun(runId, stateDir), /RUN_INCOMPLETE/);
  assert.equal((await readRun(runId, stateDir)).status, 'created');
  await assert.rejects(readFile(join(runRoot, 'report.md'), 'utf8'), { code: 'ENOENT' });

  await writeCandidate(stateDir, candidate(runId, pending.id, {
    status: 'rejected', reproduction: { status: 'reproduced', attempts: 1 },
    review: { status: 'rejected', reason: 'Processed after resume' },
  }));
  await completeConfiguredRoutes(runId, stateDir);
  await finishRun(runId, stateDir);
  assert.equal((await readRun(runId, stateDir)).status, 'finished');
});

test('finish requires a test of the kind the preset exports, not just any test', async (t) => {
  const { stateDir, runId, runRoot } = await fixture(t);
  const confirmed = candidate(runId, 'unit-only', {
    status: 'confirmed', reproduction: { status: 'reproduced', attempts: 1 },
    review: { status: 'confirmed', reason: 'Воспроизведён в чистой сессии' },
  });
  await writeCandidate(stateDir, confirmed);
  await completeConfiguredRoutes(runId, stateDir);
  await recordCandidateTest(runId, confirmed.id, 'unit', join(runRoot, 'unit.test.ts'), stateDir);

  // Гарантия «red-тест на каждый подтверждённый баг» держится на виде теста, который
  // экспортирует пресет: unit-тест его не заменяет.
  await assert.rejects(finishRun(runId, stateDir), /RUN_INCOMPLETE/);
  assert.equal((await readRun(runId, stateDir)).status, 'exploring');

  await recordCandidateTest(runId, confirmed.id, 'e2e', join(runRoot, 'e2e/done.spec.ts'), stateDir);
  await finishRun(runId, stateDir);
  assert.equal((await readRun(runId, stateDir)).status, 'finished');
});

test('finish rejects an exploring route even with zero candidates', async (t) => {
  const { stateDir, runId, runRoot } = await fixture(t);
  await updateRun(runId, {
    status: 'exploring',
    stages: { explore: 'running', reproduce: 'pending', triage: 'pending', export: 'pending' },
    targetStages: { '/': 'exploring', '/orders': 'pending' },
  }, stateDir);

  await assert.rejects(finishRun(runId, stateDir), /RUN_INCOMPLETE/);
  const unfinished = await readRun(runId, stateDir);
  assert.equal(unfinished.status, 'exploring');
  assert.deepEqual(unfinished.targetStages, { '/': 'exploring', '/orders': 'pending' });
  await assert.rejects(readFile(join(runRoot, 'report.md'), 'utf8'), { code: 'ENOENT' });
});

test('finish requires actual resumed route completion after terminal candidate work', async (t) => {
  const { stateDir, runId, runRoot } = await fixture(t);
  await updateRun(runId, {
    status: 'writing_tests',
    stages: { explore: 'running', reproduce: 'done', triage: 'done', export: 'running' },
    targetStages: { '/': 'exploring', '/orders': 'exploring' },
  }, stateDir);
  const confirmed = candidate(runId, 'interrupted-confirmed', {
    status: 'confirmed', reproduction: { status: 'reproduced', attempts: 3 },
    review: { status: 'confirmed', reason: 'Reproduced before interruption' },
  });
  await writeCandidate(stateDir, confirmed);

  await assert.rejects(finishRun(runId, stateDir), /RUN_INCOMPLETE/);
  assert.equal((await readRun(runId, stateDir)).stages.explore, 'running');
  await recordCandidateTest(runId, confirmed.id, 'e2e', join(runRoot, 'e2e/done.spec.ts'), stateDir);
  await assert.rejects(finishRun(runId, stateDir), /RUN_INCOMPLETE/);
  await recordTargetExploration(runId, '/', 'done', stateDir);
  await recordTargetExploration(runId, '/orders', 'done', stateDir);
  await finishRun(runId, stateDir);

  const finished = await readRun(runId, stateDir);
  assert.equal(finished.status, 'finished');
  assert.equal(finished.stages.explore, 'done');
  assert.deepEqual(finished.targetStages, { '/': 'done', '/orders': 'done' });
  assert.deepEqual((await resumeRun(runId, stateDir)).pendingCandidates, []);
});

test('triage rejects unreproduced candidates without changing status or memory', async (t) => {
  const { stateDir, runId, runRoot } = await fixture(t);
  const pending = candidate(runId, 'pending-triage');
  await writeCandidate(stateDir, pending);

  await assert.rejects(triageCandidate({
    runId, candidateId: pending.id, verdict: 'confirmed', reason: 'Skipped reproduction', stateDir,
  }), /CANDIDATE_UNREPRODUCED/);
  assert.equal((await readCandidate(runId, pending.id, stateDir)).status, 'unprocessed');
  await assert.rejects(readFile(join(runRoot, '../known-bugs.json'), 'utf8'), { code: 'ENOENT' });
});

test('a report write failure leaves the run unfinished and removes temporary files', async (t) => {
  const { stateDir, runId, runRoot } = await fixture(t);
  await completeConfiguredRoutes(runId, stateDir);
  await mkdir(join(runRoot, 'report.md'), { recursive: true });
  await assert.rejects(finishRun(runId, stateDir));
  assert.equal((await readRun(runId, stateDir)).status, 'exploring');
  assert.deepEqual((await readdir(runRoot)).filter((file) => file.endsWith('.tmp')), []);
});

test('query-string routes retain distinct stage keys and complete exploration', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'bh-query-routes-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const routes = ['/search?q=x', '/search?q=y'];
  const run = await createRun('full', undefined, {
    config: { ...config(), routes }, projectRoot: stateDir, stateDir,
  });

  await recordTargetExploration(run.id, '/search?q=x', 'exploring', stateDir);
  let resumed = await resumeRun(run.id, stateDir);
  assert.deepEqual(resumed.run.targetStages, { '/search?q=x': 'exploring', '/search?q=y': 'pending' });
  assert.equal(resumed.run.targetStages['/search'], undefined);
  assert.equal(resumed.run.stages.explore, 'running');

  await recordTargetExploration(run.id, '/search?q=x', 'done', stateDir);
  resumed = await resumeRun(run.id, stateDir);
  assert.deepEqual(resumed.run.targetStages, { '/search?q=x': 'done', '/search?q=y': 'pending' });
  assert.equal(resumed.run.stages.explore, 'running');

  await recordTargetExploration(run.id, '/search?q=y', 'done', stateDir);
  resumed = await resumeRun(run.id, stateDir);
  assert.deepEqual(resumed.run.targetStages, { '/search?q=x': 'done', '/search?q=y': 'done' });
  assert.equal(resumed.run.stages.explore, 'done');
});
