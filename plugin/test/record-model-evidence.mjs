import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

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
  assert.ok(Number.isInteger(redResult.failedAssertions) && redResult.failedAssertions >= 1);
  assert.equal(orchestration.nativeForegroundAgents, true);
  assert.equal(orchestration.singleExplorer, true);
  assert.equal(orchestration.mainRestrictedTools, 0);
  assert.equal(orchestration.confirmedFalse, 0);
  await access(orchestration.transcriptPath);
  const evidence = {
    host, surface, gate, clientVersion, sourceCommit, runId,
    status: 'passed', afterHostRefactor: true,
    finished: true, pending: 0, confirmedFalse: 0,
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
