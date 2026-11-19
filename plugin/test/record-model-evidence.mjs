import assert from 'node:assert/strict';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

async function readCandidates(runDir) {
  const directory = join(runDir, 'candidates');
  let entries;
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('MODEL_EVIDENCE_CANDIDATES_REQUIRED');
    throw error;
  }
  const candidates = [];
  for (const entry of entries.filter((name) => name.endsWith('.json')).sort()) {
    let candidate;
    try {
      candidate = JSON.parse(await readFile(join(directory, entry), 'utf8'));
    } catch {
      throw new Error(`MODEL_EVIDENCE_CANDIDATE_INVALID: ${entry}`);
    }
    candidates.push(candidate);
  }
  return candidates;
}

export async function recordModelGate(input) {
  const {
    host, surface, gate, clientVersion, sourceCommit, runId, runDir,
    redCommand, redResult, orchestration, evidenceDir,
  } = input;
  assert.match(sourceCommit, /^[a-f0-9]{40}$/);
  assert.ok(clientVersion);
  assert.equal(basename(runDir), runId);
  const run = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8'));
  assert.equal(run.id, runId);
  assert.equal(run.status, 'finished');
  assert.equal(Object.values(run.stages).every((stage) => stage === 'done'), true);
  assert.equal(Object.values(run.targetStages).every((stage) => stage === 'done'), true);
  assert.ok(Array.isArray(run.targets), 'MODEL_EVIDENCE_TARGETS');
  assert.deepEqual(Object.keys(run.targetStages).sort(), [...run.targets].sort(), 'MODEL_EVIDENCE_TARGET_STAGES');

  const candidates = await readCandidates(runDir);
  assert.ok(candidates.length > 0, 'MODEL_EVIDENCE_CANDIDATES_REQUIRED');
  assert.ok(candidates.every((candidate) => candidate.runId === runId), 'MODEL_EVIDENCE_RUN_MISMATCH');
  assert.ok(
    candidates.every((candidate) => ['confirmed', 'rejected', 'duplicate'].includes(candidate.status)),
    'MODEL_EVIDENCE_PENDING',
  );
  const pending = candidates.filter((candidate) =>
    !['confirmed', 'rejected', 'duplicate'].includes(candidate.status)).length;
  const confirmed = candidates.filter((candidate) => candidate.status === 'confirmed');
  assert.ok(confirmed.length > 0, 'MODEL_EVIDENCE_CONFIRMED_REQUIRED');
  const confirmedFalse = confirmed.filter((candidate) =>
    !run.targets.includes(candidate.target)
    || candidate.review?.status !== 'confirmed'
    || candidate.reproduction?.status !== 'reproduced').length;
  assert.equal(confirmedFalse, 0, 'MODEL_EVIDENCE_FALSE_CONFIRMATION');
  if (host === 'qwen' && surface === 'cli' && ['target', 'resume'].includes(gate)) {
    assert.ok(run.targets.includes('/orders/new'), 'MODEL_EVIDENCE_WEB_TARGET_REQUIRED');
  }

  assert.ok(Number.isInteger(redResult.failedAssertions) && redResult.failedAssertions >= 1);
  assert.equal(orchestration.nativeForegroundAgents, true);
  assert.equal(orchestration.singleExplorer, true);
  assert.equal(orchestration.mainRestrictedTools, 0);
  await access(orchestration.transcriptPath);
  const evidence = {
    host, surface, gate, clientVersion, sourceCommit, runId,
    status: 'passed', afterHostRefactor: true,
    finished: run.status === 'finished', pending, confirmedFalse,
    nativeForegroundAgents: true, singleExplorer: true, mainRestrictedTools: 0,
    red: { command: redCommand, failedAssertions: redResult.failedAssertions },
  };
  const directory = surface === 'extension'
    ? join(evidenceDir, host, 'extension')
    : join(evidenceDir, host);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${gate}.json`);
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  return path;
}
