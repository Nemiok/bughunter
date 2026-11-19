import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { runIndependentRed } from './independent-red.mjs';
import { inspectQwenTranscript } from './transcript-evidence.mjs';

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

async function transcriptDigests(transcriptPaths) {
  const digests = [];
  for (const path of transcriptPaths) {
    digests.push({ sha256: createHash('sha256').update(await readFile(path)).digest('hex') });
  }
  return digests;
}

export async function recordModelGate(input) {
  const {
    host, surface, gate, clientVersion, sourceCommit, runId, runDir,
    red, orchestration, evidenceDir,
  } = input;
  assert.match(sourceCommit, /^[a-f0-9]{40}$/);
  assert.ok(clientVersion);
  if (host !== 'qwen') throw new Error('TRANSCRIPT_HOST_UNSUPPORTED');
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
    assert.ok(
      confirmed.every((candidate) => candidate.target === '/orders/new'),
      'MODEL_EVIDENCE_WEB_TARGET_REQUIRED',
    );
  }
  if (gate === 'node-target') {
    assert.ok(run.targets.includes('GET /orders'), 'MODEL_EVIDENCE_NODE_TARGET_REQUIRED');
    assert.ok(
      confirmed.every((candidate) => candidate.target === 'GET /orders'),
      'MODEL_EVIDENCE_NODE_TARGET_REQUIRED',
    );
  }

  const orchestrationResult = await inspectQwenTranscript({
    transcriptPaths: orchestration?.transcriptPaths,
    runId,
    gate,
    projectRoot: red?.cwd,
  });
  const transcripts = await transcriptDigests(orchestration.transcriptPaths);

  const candidateTest = confirmed[0].tests?.e2e ?? confirmed[0].tests?.unit ?? confirmed[0].tests?.api;
  assert.ok(
    typeof candidateTest === 'string' && candidateTest.trim() !== '',
    'MODEL_EVIDENCE_TEST_PATH_REQUIRED',
  );
  if (red?.testPath !== undefined && resolve(red.cwd, red.testPath) !== resolve(red.cwd, candidateTest)) {
    throw new Error('MODEL_EVIDENCE_TEST_PATH_MISMATCH');
  }
  const redResult = await runIndependentRed({
    runner: red?.runner,
    cwd: red?.cwd,
    testPath: candidateTest,
    reportPath: red?.reportPath,
    spawn: red?.spawn,
  });

  const nodeEvidence = gate === 'node-target'
    ? {
      activeToolsVerified: orchestrationResult.activeToolsVerified,
      preset: orchestrationResult.preset,
      toolCount: orchestrationResult.toolCount,
    }
    : {};
  const evidence = {
    host, surface, gate, clientVersion, sourceCommit, runId,
    status: 'passed', afterHostRefactor: true,
    finished: run.status === 'finished', pending, confirmedFalse,
    nativeForegroundAgents: orchestrationResult.nativeForegroundAgents,
    singleExplorer: orchestrationResult.singleExplorer,
    mainRestrictedTools: orchestrationResult.mainRestrictedTools,
    ...nodeEvidence,
    transcripts,
    red: {
      command: [redResult.command, ...redResult.args].join(' '),
      failedAssertions: redResult.failedAssertions,
      reportSha256: redResult.reportSha256,
    },
  };
  const directory = surface === 'extension'
    ? join(evidenceDir, host, 'extension')
    : join(evidenceDir, host);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${gate}.json`);
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  return path;
}
