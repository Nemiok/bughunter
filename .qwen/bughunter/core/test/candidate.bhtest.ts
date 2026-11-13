import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { attachCandidateArtifacts, candidateSignature, reportCandidate } from '../src/candidate.ts';
import type { Check } from '../src/types.ts';

const check: Check = { kind: 'visibleText', target: 'Итого 42' };

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

test('signature prefers the signal, falls back to the check, and demands an oracle', () => {
  assert.equal(candidateSignature({ signalSignature: 'from-signal', check, target: '/a' }), 'from-signal');
  const fromCheck = candidateSignature({ check, target: '/a' });
  assert.match(fromCheck, /^[0-9a-f]{64}$/);
  assert.equal(fromCheck, candidateSignature({ check, target: '/a' }), 'сигнатура устойчива');
  assert.notEqual(fromCheck, candidateSignature({ check, target: '/b' }), 'цель входит в сигнатуру');
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
