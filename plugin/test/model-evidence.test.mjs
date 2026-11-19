import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { recordModelGate } from './record-model-evidence.mjs';
import { CANDIDATE_TEST, persistFixture, validFixture } from './model-evidence-fixture.mjs';

test('valid model evidence is sanitized and written', async () => {
  const input = await validFixture();
  const path = await recordModelGate(input);
  const evidence = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(evidence.status, 'passed');
  assert.equal(evidence.runId, 'run-1');
  assert.equal(evidence.pending, 0);
  assert.equal(evidence.confirmedFalse, 0);
  assert.equal(evidence.nativeForegroundAgents, true);
  assert.equal(evidence.singleExplorer, true);
  assert.equal(evidence.mainRestrictedTools, 0);
  assert.equal(evidence.reloadVerified, true);
  assert.equal(evidence.red.failedAssertions, 1);
  assert.match(evidence.red.reportSha256, /^[a-f0-9]{64}$/);
  assert.match(evidence.transcripts[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal('transcriptPath' in evidence, false);
  assert.equal('transcriptPaths' in evidence, false);
});

for (const [name, mutate] of Object.entries({
  'no candidates': async (input) => { input.candidate = undefined; },
  'foreign target': async (input) => { input.candidate.target = '/orders'; },
  'false confirmation': async (input) => { input.candidate.reproduction.status = 'unreproduced'; },
  'pending candidate': async (input) => { input.candidate.status = 'pending'; },
  'wrong run target': async (input) => {
    input.run.targets = ['/orders/new'];
    input.run.targetStages = { '/orders': 'done' };
  },
})) {
  test(`recorder rejects ${name}`, async () => {
    const input = await validFixture();
    await mutate(input);
    await persistFixture(input);
    await assert.rejects(recordModelGate(input), /MODEL_EVIDENCE/);
    await assert.rejects(access(input.expectedEvidencePath));
  });
}

test('web target rejects a confirmed candidate outside /orders/new', async () => {
  const input = await validFixture();
  input.run.targets = ['/orders', '/orders/new'];
  input.run.targetStages = { '/orders': 'done', '/orders/new': 'done' };
  input.candidate.target = '/orders';
  await persistFixture(input);
  await assert.rejects(recordModelGate(input), /MODEL_EVIDENCE_WEB_TARGET_REQUIRED/);
  await assert.rejects(access(input.expectedEvidencePath));
});

test('recorder accepts the node preset api test kind', async () => {
  const input = await validFixture();
  input.candidate.tests = { api: CANDIDATE_TEST };
  await persistFixture(input);
  const path = await recordModelGate(input);
  const evidence = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(evidence.red.failedAssertions, 1);
});

test('recorder rejects malformed candidate json', async () => {
  const input = await validFixture();
  await writeFile(join(input.runDir, 'candidates', 'bug-1.json'), '{not json');
  await assert.rejects(recordModelGate(input), /MODEL_EVIDENCE_CANDIDATE/);
  await assert.rejects(access(input.expectedEvidencePath));
});

test('unfinished run and pending stages are rejected', async () => {
  for (const patch of [{ status: 'writing_tests' }, { stages: { explore: 'pending' } }]) {
    const input = await validFixture();
    const invalid = { ...input.run, ...patch };
    if (patch.stages) invalid.stages = { ...input.run.stages, ...patch.stages };
    input.run = invalid;
    await persistFixture(input);
    await assert.rejects(recordModelGate(input));
  }
});

test('qwen resume requires the web target', async () => {
  const input = await validFixture();
  input.gate = 'resume';
  input.expectedEvidencePath = join(input.root, 'evidence', 'qwen', 'resume.json');
  input.run.targets = ['/orders'];
  input.run.targetStages = { '/orders': 'done' };
  input.candidate.target = '/orders';
  await persistFixture(input);
  await assert.rejects(recordModelGate(input), /MODEL_EVIDENCE_WEB_TARGET_REQUIRED/);
  await assert.rejects(access(input.expectedEvidencePath));
});

test('caller-supplied orchestration booleans are ignored', async () => {
  const input = await validFixture();
  input.orchestration.nativeForegroundAgents = false;
  input.orchestration.singleExplorer = false;
  input.orchestration.mainRestrictedTools = 99;
  const path = await recordModelGate(input);
  const evidence = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(evidence.nativeForegroundAgents, true);
  assert.equal(evidence.singleExplorer, true);
  assert.equal(evidence.mainRestrictedTools, 0);
});

test('caller cannot override the red assertion count', async () => {
  const input = await validFixture();
  const green = {
    suites: [{
      title: 'orders', file: CANDIDATE_TEST, specs: [{
        title: 'total', file: CANDIDATE_TEST, tests: [{
          title: 'renders', results: [{ status: 'passed' }],
        }],
      }],
    }],
    errors: [],
  };
  await writeFile(input.reportPath, JSON.stringify(green));
  input.red.spawn = () => {
    writeFileSync(input.reportPath, JSON.stringify(green));
    return { status: 1 };
  };
  input.redResult = { failedAssertions: 99 };
  await assert.rejects(recordModelGate(input), /RED_ASSERTIONS_REQUIRED/);
  await assert.rejects(access(input.expectedEvidencePath));
});

test('empty transcript is rejected even with caller booleans', async () => {
  const input = await validFixture();
  await writeFile(input.transcriptPath, '{}\n');
  input.orchestration.nativeForegroundAgents = true;
  await assert.rejects(recordModelGate(input), /TRANSCRIPT_EMPTY/);
  await assert.rejects(access(input.expectedEvidencePath));
});

test('non-qwen hosts are rejected by the transcript adapter', async () => {
  const input = await validFixture();
  input.host = 'claude';
  await assert.rejects(recordModelGate(input), /TRANSCRIPT_HOST_UNSUPPORTED/);
  await assert.rejects(access(input.expectedEvidencePath));
});

test('candidate test path must match the red input', async () => {
  const input = await validFixture();
  input.red.testPath = 'e2e/bughunter/other.spec.ts';
  await assert.rejects(recordModelGate(input), /MODEL_EVIDENCE_TEST_PATH_MISMATCH/);
  await assert.rejects(access(input.expectedEvidencePath));
});

test('confirmed candidate must carry an e2e or unit test path', async () => {
  const input = await validFixture();
  delete input.candidate.tests;
  await persistFixture(input);
  await assert.rejects(recordModelGate(input), /MODEL_EVIDENCE_TEST_PATH_REQUIRED/);
  await assert.rejects(access(input.expectedEvidencePath));
});
