import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { ReportFormat } from '../src/preset.ts';
import {
  completeExplorationLease, createRun, finishRun, leaseNextExploration,
  readFindings, readRun, readSharedMemory, recordCandidateTest, recordRunStage, recordTargetExploration,
  triageCandidate,
} from '../src/run-store.ts';
import type { Candidate, Config, Finding } from '../src/types.ts';

const config = { targetMap: {}, baseBranch: 'main' } as unknown as Config;
const createdAt = '2026-11-13T00:00:00.000Z';

async function withStateDir(run: (stateDir: string) => Promise<void>): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), 'bh-core-run-store-'));
  try {
    await run(stateDir);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

async function markStagesDone(
  runId: string,
  stateDir: string,
  stages: readonly ('explore' | 'reproduce' | 'triage' | 'export')[] = ['explore', 'reproduce', 'triage', 'export'],
): Promise<void> {
  for (const stage of stages) await recordRunStage(runId, stage, 'done', stateDir);
}

async function writeConfirmedCandidate(runId: string, stateDir: string, id = 'cand-1'): Promise<void> {
  const candidate: Candidate = {
    id,
    runId,
    sessionId: 'sess-1',
    target: '/a',
    title: 'Заголовок кандидата',
    expected: 'ожидалось одно',
    actual: 'получилось другое',
    signalIds: [],
    signature: 'signature-1',
    steps: [],
    artifacts: [],
    status: 'confirmed',
    createdAt,
    reproduction: { status: 'reproduced', attempts: 3 },
    review: { status: 'confirmed', reason: 'воспроизведено 3/3' },
    tests: { e2e: `runs/${runId}/e2e/${id}.spec.ts` },
  };
  const directory = join(stateDir, 'runs', runId, 'candidates');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${id}.json`), `${JSON.stringify(candidate, null, 2)}\n`, 'utf8');
}

test('the persona roster comes from the caller, not from the store', () => withStateDir(async (stateDir) => {
  const run = await createRun('full', undefined, {
    config,
    projectRoot: stateDir,
    stateDir,
    personas: ['персона А', 'персона Б'],
    targets: ['/a'],
  });
  assert.deepEqual(run.exploreQueue?.map((item) => item.persona), ['персона А', 'персона Б']);
  assert.deepEqual(run.exploreQueue?.map((item) => item.target), ['/a', '/a']);
}));

test('findings written before the envelope rename stay readable', () => withStateDir(async (stateDir) => {
  const run = await createRun('full', undefined, { config, projectRoot: stateDir, stateDir, personas: ['p'], targets: ['/a'] });
  const directory = join(stateDir, 'runs', run.id, 'findings');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'find-old.json'), JSON.stringify({
    id: 'find-old',
    runId: run.id,
    targetRef: '/a',
    widget: 'orders',
    kind: 'response-captured',
    detail: 'старая находка',
    responseHashes: ['hash-1'],
    status: 'new',
    createdAt,
  }), 'utf8');

  const [finding] = await readFindings(run.id, stateDir);
  assert.equal(finding?.subject, 'orders');
  assert.deepEqual(finding?.evidenceHashes, ['hash-1']);
  assert.ok(!('widget' in (finding as object)) && !('responseHashes' in (finding as object)));
}));

test('the report renders candidates and findings through the preset format', () => withStateDir(async (stateDir) => {
  const format: ReportFormat = {
    candidate: () => ['SENTINEL_STEPS'],
    finding: () => ['SENTINEL_FINDING'],
  };
  const run = await createRun('full', undefined, { config, projectRoot: stateDir, stateDir, personas: ['p'], targets: ['/a'] });
  await writeConfirmedCandidate(run.id, stateDir);
  const finding: Finding = {
    id: 'find-1',
    runId: run.id,
    targetRef: '/a',
    kind: 'response-captured',
    detail: 'детали находки',
    evidenceHashes: [],
    status: 'new',
    createdAt,
  };
  const findings = join(stateDir, 'runs', run.id, 'findings');
  await mkdir(findings, { recursive: true });
  await writeFile(join(findings, `${finding.id}.json`), `${JSON.stringify(finding, null, 2)}\n`, 'utf8');
  const leased = await leaseNextExploration(run.id, { personas: ['p'] }, stateDir);
  if (leased.status !== 'task') throw new Error('не достигнуто');
  await recordTargetExploration(run.id, '/a', 'done', stateDir);
  await completeExplorationLease(run.id, leased.leaseId, stateDir);
  await markStagesDone(run.id, stateDir);

  const { report } = await finishRun(run.id, stateDir, format);
  const contents = await readFile(report, 'utf8');
  assert.match(contents, /SENTINEL_STEPS/);
  assert.match(contents, /SENTINEL_FINDING/);
  assert.match(contents, /## Confirmed/);
  assert.match(contents, /## Pending\n\nNone\./);
}));

/**
 * `targetStages` грубее очереди: цель помечается готовой закрытием любой её сессии, а очередь
 * держит задачу на каждую пару цель×персона. Без проверки очереди прогон, исследовавший по одной
 * персоне на цель, завершался с `finished` и `Pending: None`.
 */
test('finish refuses a run whose explore queue is not drained', () => withStateDir(async (stateDir) => {
  const format: ReportFormat = { candidate: () => ['C'], finding: () => ['F'] };
  const run = await createRun('full', undefined, {
    config, projectRoot: stateDir, stateDir, personas: ['персона А', 'персона Б'], targets: ['/a'],
  });
  await recordTargetExploration(run.id, '/a', 'done', stateDir);
  await markStagesDone(run.id, stateDir);
  await assert.rejects(() => finishRun(run.id, stateDir, format), /RUN_INCOMPLETE: queue/);
}));

test('finish accepts a run whose explore queue is drained', () => withStateDir(async (stateDir) => {
  const format: ReportFormat = { candidate: () => ['C'], finding: () => ['F'] };
  const run = await createRun('full', undefined, {
    config, projectRoot: stateDir, stateDir, personas: ['персона А'], targets: ['/a'],
  });
  const leased = await leaseNextExploration(run.id, { personas: ['персона А'] }, stateDir);
  assert.equal(leased.status, 'task');
  if (leased.status !== 'task') throw new Error('не достигнуто');
  await recordTargetExploration(run.id, leased.target, 'done', stateDir);
  await completeExplorationLease(run.id, leased.leaseId, stateDir);
  await markStagesDone(run.id, stateDir);
  const { report } = await finishRun(run.id, stateDir, format);
  assert.match(await readFile(report, 'utf8'), /## Pending\n\nNone\./);
}));

test('finish accepts a run with no confirmed bugs even though export was never started', () => withStateDir(async (stateDir) => {
  const format: ReportFormat = { candidate: () => ['C'], finding: () => ['F'] };
  const run = await createRun('target', '/a', {
    config, projectRoot: stateDir, stateDir, personas: ['персона А'], targets: ['/a'],
  });
  const leased = await leaseNextExploration(run.id, { personas: ['персона А'] }, stateDir);
  if (leased.status !== 'task') throw new Error('не достигнуто');
  await recordTargetExploration(run.id, leased.target, 'done', stateDir);
  await completeExplorationLease(run.id, leased.leaseId, stateDir);
  await recordRunStage(run.id, 'reproduce', 'done', stateDir);
  await recordRunStage(run.id, 'triage', 'done', stateDir);
  const candidate: Candidate = {
    id: 'rejected-1',
    runId: run.id,
    sessionId: 'sess-1',
    target: '/a',
    title: 'Заголовок кандидата',
    expected: 'ожидалось одно',
    actual: 'получилось другое',
    signalIds: [],
    signature: 'signature-rejected',
    steps: [],
    artifacts: [],
    status: 'rejected',
    createdAt,
    reproduction: { status: 'reproduced', attempts: 3 },
    review: { status: 'rejected', reason: 'Не нарушает контракт приложения' },
  };
  const directory = join(stateDir, 'runs', run.id, 'candidates');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${candidate.id}.json`), `${JSON.stringify(candidate, null, 2)}\n`, 'utf8');

  const { report } = await finishRun(run.id, stateDir, format);
  assert.match(await readFile(report, 'utf8'), /## Pending\n\nNone\./);
  assert.equal((await readRun(run.id, stateDir)).status, 'finished');
}));

test('finish accepts a run with no candidates even though candidate stages never started', () => withStateDir(async (stateDir) => {
  const format: ReportFormat = { candidate: () => ['C'], finding: () => ['F'] };
  const run = await createRun('target', '/a', {
    config, projectRoot: stateDir, stateDir, personas: ['персона А'], targets: ['/a'],
  });
  const leased = await leaseNextExploration(run.id, { personas: ['персона А'] }, stateDir);
  if (leased.status !== 'task') throw new Error('не достигнуто');
  await recordTargetExploration(run.id, leased.target, 'done', stateDir);
  await completeExplorationLease(run.id, leased.leaseId, stateDir);

  const { report } = await finishRun(run.id, stateDir, format);
  assert.match(await readFile(report, 'utf8'), /## Pending\n\nNone\./);
  assert.equal((await readRun(run.id, stateDir)).status, 'finished');
}));

test('finish refuses a run with a failed stage', () => withStateDir(async (stateDir) => {
  const format: ReportFormat = { candidate: () => ['C'], finding: () => ['F'] };
  const run = await createRun('target', '/a', {
    config, projectRoot: stateDir, stateDir, personas: ['персона А'], targets: ['/a'],
  });
  const leased = await leaseNextExploration(run.id, { personas: ['персона А'] }, stateDir);
  if (leased.status !== 'task') throw new Error('не достигнуто');
  await recordTargetExploration(run.id, leased.target, 'done', stateDir);
  await completeExplorationLease(run.id, leased.leaseId, stateDir);
  await recordRunStage(run.id, 'explore', 'done', stateDir);
  await recordRunStage(run.id, 'reproduce', 'done', stateDir);
  await recordRunStage(run.id, 'triage', 'failed', stateDir);
  await recordRunStage(run.id, 'export', 'done', stateDir);
  await assert.rejects(() => finishRun(run.id, stateDir, format), /RUN_INCOMPLETE: stages/);
}));

/**
 * Экспорт записывает тест, но не доказывает, что он ловит баг: `bh_verify_red` может вернуть
 * `green` или `broken`. Подтверждённый баг с таким вердиктом не закрыт, иначе отчёт обещает
 * регрессию, которой нет.
 */
test('a confirmed bug needs a red verdict, not just a recorded test', () => withStateDir(async (stateDir) => {
  const format: ReportFormat = { candidate: () => ['C'], finding: () => ['F'] };
  const run = await createRun('full', undefined, {
    config, projectRoot: stateDir, stateDir, personas: ['персона А'], targets: ['/a'],
  });
  await writeConfirmedCandidate(run.id, stateDir);
  await recordCandidateTest(
    run.id, 'cand-1', 'api', join(stateDir, 'runs', run.id, 'api', 'x.test.ts'), stateDir, 'green',
  );
  const leased = await leaseNextExploration(run.id, { personas: ['персона А'] }, stateDir);
  if (leased.status !== 'task') throw new Error('не достигнуто');
  await recordTargetExploration(run.id, leased.target, 'done', stateDir);
  await completeExplorationLease(run.id, leased.leaseId, stateDir);
  await markStagesDone(run.id, stateDir);

  await assert.rejects(() => finishRun(run.id, stateDir, format, 'api'), /RUN_INCOMPLETE: cand-1/);
  await recordCandidateTest(
    run.id, 'cand-1', 'api', join(stateDir, 'runs', run.id, 'api', 'x.test.ts'), stateDir, 'red',
  );
  await finishRun(run.id, stateDir, format, 'api');
}));

test('a confirmed bug needs an explicit red verdict', () => withStateDir(async (stateDir) => {
  const format: ReportFormat = { candidate: () => ['C'], finding: () => ['F'] };
  const run = await createRun('target', '/a', {
    config, projectRoot: stateDir, stateDir, personas: ['персона А'], targets: ['/a'],
  });
  await writeConfirmedCandidate(run.id, stateDir);
  await recordCandidateTest(run.id, 'cand-1', 'api', join(stateDir, 'runs', run.id, 'api', 'x.test.ts'), stateDir);
  const leased = await leaseNextExploration(run.id, { personas: ['персона А'] }, stateDir);
  if (leased.status !== 'task') throw new Error('не достигнуто');
  await recordTargetExploration(run.id, leased.target, 'done', stateDir);
  await completeExplorationLease(run.id, leased.leaseId, stateDir);
  await markStagesDone(run.id, stateDir);

  await assert.rejects(() => finishRun(run.id, stateDir, format, 'api'), /RUN_INCOMPLETE: cand-1/);
  await recordCandidateTest(
    run.id, 'cand-1', 'api', join(stateDir, 'runs', run.id, 'api', 'x.test.ts'), stateDir, 'red',
  );
  await finishRun(run.id, stateDir, format, 'api');
}));

test('a test kind is an arbitrary preset string', () => withStateDir(async (stateDir) => {
  const run = await createRun('full', undefined, { config, projectRoot: stateDir, stateDir, personas: ['p'], targets: ['/a'] });
  await writeConfirmedCandidate(run.id, stateDir);
  await recordCandidateTest(run.id, 'cand-1', 'api', join(stateDir, 'runs', run.id, 'api', 'x.test.ts'), stateDir);
  const raw = JSON.parse(await readFile(
    join(stateDir, 'runs', run.id, 'candidates', 'cand-1.json'),
    'utf8',
  )) as { tests: Record<string, string> };
  assert.equal(raw.tests.api, 'api/x.test.ts');
  assert.ok(raw.tests.e2e !== undefined, 'прежний вид теста сохраняется');
}));

async function writeReproducedCandidate(runId: string, stateDir: string, id: string, signature: string): Promise<void> {
  const candidate: Candidate = {
    id,
    runId,
    sessionId: 'sess-1',
    target: '/a',
    title: 'Кандидат на отзыв',
    expected: 'ожидалось одно',
    actual: 'получилось другое',
    signalIds: [],
    signature,
    steps: [],
    artifacts: [],
    status: 'unprocessed',
    createdAt,
    reproduction: { status: 'reproduced', attempts: 1 },
  };
  const directory = join(stateDir, 'runs', runId, 'candidates');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${id}.json`), `${JSON.stringify(candidate, null, 2)}\n`, 'utf8');
}

test('rejected-revokes-own-known-bug', () => withStateDir(async (stateDir) => {
  const run = await createRun('full', undefined, { config, projectRoot: stateDir, stateDir, personas: ['p'], targets: ['/a'] });
  await writeReproducedCandidate(run.id, stateDir, 'cand-a', 'sig-shared');
  await triageCandidate({ runId: run.id, candidateId: 'cand-a', verdict: 'confirmed', reason: 'воспроизведено', stateDir });
  assert.equal((await readSharedMemory('known-bugs.json', stateDir)).length, 1);
  await triageCandidate({ runId: run.id, candidateId: 'cand-a', verdict: 'rejected', reason: 'артефакт среды', stateDir });
  assert.deepEqual(await readSharedMemory('known-bugs.json', stateDir), []);
}));

test('rejected-keeps-foreign-known-bug', () => withStateDir(async (stateDir) => {
  const run = await createRun('full', undefined, { config, projectRoot: stateDir, stateDir, personas: ['p'], targets: ['/a'] });
  await writeReproducedCandidate(run.id, stateDir, 'cand-a', 'sig-shared');
  await writeReproducedCandidate(run.id, stateDir, 'cand-b', 'sig-shared');
  await triageCandidate({ runId: run.id, candidateId: 'cand-a', verdict: 'confirmed', reason: 'воспроизведено', stateDir });
  await triageCandidate({ runId: run.id, candidateId: 'cand-b', verdict: 'rejected', reason: 'ложная заявка того же симптома', stateDir });
  const known = await readSharedMemory('known-bugs.json', stateDir);
  assert.equal(known.length, 1);
  assert.equal(known[0]!.sourceCandidate, 'cand-a');
}));

test('rejected-without-known-bug-is-noop', () => withStateDir(async (stateDir) => {
  const run = await createRun('full', undefined, { config, projectRoot: stateDir, stateDir, personas: ['p'], targets: ['/a'] });
  await writeReproducedCandidate(run.id, stateDir, 'cand-c', 'sig-other');
  await triageCandidate({ runId: run.id, candidateId: 'cand-c', verdict: 'rejected', reason: 'не баг', stateDir });
  assert.deepEqual(await readSharedMemory('known-bugs.json', stateDir), []);
}));

test('duplicate-verdict-keeps-known-bug', () => withStateDir(async (stateDir) => {
  const run = await createRun('full', undefined, { config, projectRoot: stateDir, stateDir, personas: ['p'], targets: ['/a'] });
  await writeReproducedCandidate(run.id, stateDir, 'cand-a', 'sig-shared');
  await writeReproducedCandidate(run.id, stateDir, 'cand-b', 'sig-shared');
  await triageCandidate({ runId: run.id, candidateId: 'cand-a', verdict: 'confirmed', reason: 'воспроизведено', stateDir });
  await triageCandidate({ runId: run.id, candidateId: 'cand-b', verdict: 'duplicate', reason: 'тот же симптом', stateDir });
  assert.equal((await readSharedMemory('known-bugs.json', stateDir)).length, 1);
}));

test('diff scope includes uncommitted changes', () => withStateDir(async (stateDir) => {
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: stateDir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  await mkdir(join(stateDir, 'src'), { recursive: true });
  await writeFile(join(stateDir, 'src', 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(stateDir, 'src', 'b.ts'), 'export const b = 1;\n');
  git(['add', '.']);
  git(['commit', '-m', 'init']);
  await writeFile(join(stateDir, 'src', 'a.ts'), 'export const a = 2;\n');
  const diffConfig = { targetMap: { 'src/a.ts': ['/a'], 'src/b.ts': ['/b'] }, baseBranch: 'main' } as unknown as Config;
  const run = await createRun('diff', undefined, { config: diffConfig, projectRoot: stateDir, stateDir, personas: ['p'], targets: ['/a', '/b'] });
  assert.deepEqual(run.targets, ['/a'], 'незакоммиченное изменение обязано попасть в diff-область');
}));
