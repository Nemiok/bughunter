import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { attachCandidateArtifacts, candidateSignature, reportCandidate } from '../src/candidate.ts';
import type { Check } from '../src/types.ts';

const check: Check = { kind: 'invariant', target: 'Итого 42' };

async function withStateDir(run: (stateDir: string) => Promise<void>): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), 'bh-core-candidate-'));
  try {
    await run(stateDir);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

async function writeMemory(stateDir: string, file: string, entries: unknown[]): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, file), `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
}

test('signature composes a signal with its oracle and keeps single-source signatures unchanged', () => {
  assert.equal(candidateSignature({ signalSignature: 'from-signal', target: '/a' }), 'from-signal', 'без оракула сигнал остаётся сигнатурой');

  const legacyCheck = createHash('sha256')
    .update(JSON.stringify([check.kind, check.target, check.expected ?? null, '/a']))
    .digest('hex');
  assert.equal(candidateSignature({ check, target: '/a' }), legacyCheck, 'оракул без сигнала хешируется как раньше');
  assert.notEqual(candidateSignature({ check, target: '/b' }), legacyCheck, 'цель входит в сигнатуру');

  const withCheck = candidateSignature({ signalSignature: 'from-signal', check, target: '/a' });
  assert.match(withCheck, /^[0-9a-f]{64}$/);
  assert.notEqual(withCheck, 'from-signal', 'оракул не теряется при наличии сигнала');
  assert.equal(withCheck, candidateSignature({ signalSignature: 'from-signal', check, target: '/a' }), 'сигнатура устойчива');
  assert.notEqual(
    withCheck,
    candidateSignature({ signalSignature: 'from-signal', check: { ...check, expected: 'другое' }, target: '/a' }),
    'разные оракулы — разные баги',
  );
  assert.notEqual(
    withCheck,
    candidateSignature({ signalSignature: 'other-signal', check, target: '/a' }),
    'разные сигналы — разные баги',
  );

  const presetOracle = candidateSignature({ signalSignature: 'from-signal', checkSignature: 'preset-oracle', target: '/a' });
  assert.notEqual(
    presetOracle,
    candidateSignature({ signalSignature: 'from-signal', checkSignature: 'other-oracle', target: '/a' }),
    'явная сигнатура оракула различает пресетные оракулы',
  );
  assert.equal(
    presetOracle,
    candidateSignature({ signalSignature: 'from-signal', checkSignature: 'preset-oracle', check, target: '/a' }),
    'явная сигнатура оракула главнее вычисленной',
  );
  assert.throws(() => candidateSignature({ target: '/a' }), /CANDIDATE_ORACLE_REQUIRED/);
});

test('reportCandidate writes an unprocessed candidate with an unreproduced verdict', () => withStateDir(async (stateDir) => {
  const { candidateId } = await reportCandidate({
    runId: 'run-1',
    sessionId: 'sess-1',
    target: '/a',
    title: 'Заголовок',
    expected: 'ожидалось',
    actual: 'получилось',
    steps: [],
    signalIds: [],
    check,
    stateDir,
  });
  const raw = JSON.parse(await readFile(join(stateDir, 'runs', 'run-1', 'candidates', `${candidateId}.json`), 'utf8'));
  assert.equal(raw.status, 'unprocessed');
  assert.deepEqual(raw.reproduction, { status: 'unreproduced', attempts: 0 });
  assert.equal(raw.target, '/a');
  assert.equal(raw.check.target, 'Итого 42');
}));

test('reportCandidate refuses a finished run', () => withStateDir(async (stateDir) => {
  const runDir = join(stateDir, 'runs', 'finished-run');
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'run.json'), `${JSON.stringify({
    id: 'finished-run',
    scope: 'target',
    targets: ['/a'],
    status: 'finished',
    stages: { explore: 'done', reproduce: 'done', triage: 'done', export: 'done' },
    targetStages: { '/a': 'done' },
    createdAt: '2026-11-19T00:00:00.000Z',
    updatedAt: '2026-11-19T00:10:00.000Z',
  })}\n`);
  await assert.rejects(() => reportCandidate({
    runId: 'finished-run', sessionId: 'sess-1', target: '/a', title: 'т', expected: 'е', actual: 'а',
    steps: [], signalIds: [], check, stateDir,
  }), /RUN_FINISHED/);
  await assert.rejects(readdir(join(runDir, 'candidates')), { code: 'ENOENT' });
}));

test('a signal-backed oracle candidate stores the raw signal signature next to the composite one', () => withStateDir(async (stateDir) => {
  const { candidateId } = await reportCandidate({
    runId: 'run-1', sessionId: 'sess-1', target: '/a', title: 'т', expected: 'е', actual: 'а',
    steps: [], signalIds: ['s1'], signalSignature: 'raw-signal', check, stateDir,
  });
  const raw = JSON.parse(await readFile(join(stateDir, 'runs', 'run-1', 'candidates', `${candidateId}.json`), 'utf8'));
  assert.equal(raw.signalSignature, 'raw-signal');
  assert.match(raw.signature, /^[0-9a-f]{64}$/);
  assert.notEqual(raw.signature, 'raw-signal');
}));

test('the same signal with a different oracle is a different bug', () => withStateDir(async (stateDir) => {
  const base = {
    runId: 'run-1', sessionId: 'sess-1', target: '/a', title: 'т', expected: 'е', actual: 'а',
    steps: [], signalIds: ['s1'], signalSignature: 'raw-signal', stateDir,
  };
  const first = await reportCandidate({ ...base, check });
  const firstRaw = JSON.parse(await readFile(join(stateDir, 'runs', 'run-1', 'candidates', `${first.candidateId}.json`), 'utf8'));
  await writeMemory(stateDir, 'known-bugs.json', [{ id: 'bug-1', signature: firstRaw.signature, sourceCandidate: first.candidateId }]);

  const same = await reportCandidate({ ...base, check });
  assert.equal(same.duplicateOf, 'bug-1', 'тот же сигнал и тот же оракул — дубль');

  const different = await reportCandidate({ ...base, check: { ...check, expected: 'другое' } });
  assert.equal(different.duplicateOf, undefined, 'тот же сигнал с другим оракулом — отдельный баг');
}));

test('a known or suppressed signature is marked as a duplicate', () => withStateDir(async (stateDir) => {
  await writeMemory(stateDir, 'known-bugs.json', [{ id: 'bug-7', signature: 'sig-known', sourceCandidate: 'cand-old' }]);
  const known = await reportCandidate({
    runId: 'run-1', sessionId: 'sess-1', target: '/a', title: 'т', expected: 'е', actual: 'а',
    steps: [], signalIds: ['s1'], signalSignature: 'sig-known', stateDir,
  });
  assert.equal(known.duplicateOf, 'bug-7');

  await writeMemory(stateDir, 'suppressions.json', [{ id: 'sup-1', signature: 'sig-suppressed', reason: 'легально' }]);
  const suppressed = await reportCandidate({
    runId: 'run-1', sessionId: 'sess-2', target: '/a', title: 'т', expected: 'е', actual: 'а',
    steps: [], signalIds: ['s2'], signalSignature: 'sig-suppressed', stateDir,
  });
  assert.equal(suppressed.duplicateOf, 'sup-1');
}));

test('artifacts are attached to every candidate of the session', () => withStateDir(async (stateDir) => {
  const first = await reportCandidate({
    runId: 'run-1', sessionId: 'sess-1', target: '/a', title: 'т', expected: 'е', actual: 'а',
    steps: [], signalIds: [], check, stateDir,
  });
  await attachCandidateArtifacts({
    runId: 'run-1',
    candidateIds: [first.candidateId],
    artifacts: ['runs/run-1/artifacts/a/trace.zip'],
    stateDir,
  });
  const raw = JSON.parse(await readFile(join(stateDir, 'runs', 'run-1', 'candidates', `${first.candidateId}.json`), 'utf8'));
  assert.deepEqual(raw.artifacts, ['runs/run-1/artifacts/a/trace.zip']);
}));

test('attachCandidateArtifacts merges with existing artifacts', () => withStateDir(async (stateDir) => {
  const first = await reportCandidate({
    runId: 'run-1', sessionId: 'sess-1', target: '/a', title: 'т', expected: 'е', actual: 'а',
    steps: [], signalIds: [], check, stateDir,
  });
  const path = join(stateDir, 'runs', 'run-1', 'candidates', `${first.candidateId}.json`);
  const stored = JSON.parse(await readFile(path, 'utf8')) as { artifacts: string[] };
  stored.artifacts = ['runs/run-1/replay-x/trace.zip'];
  await writeFile(path, JSON.stringify(stored));
  await attachCandidateArtifacts({
    runId: 'run-1',
    candidateIds: [first.candidateId],
    artifacts: ['runs/run-1/artifacts/a/trace.zip'],
    stateDir,
  });
  const raw = JSON.parse(await readFile(path, 'utf8')) as { artifacts: string[] };
  assert.deepEqual(raw.artifacts, ['runs/run-1/replay-x/trace.zip', 'runs/run-1/artifacts/a/trace.zip']);
}));
