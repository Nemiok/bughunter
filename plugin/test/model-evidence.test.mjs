import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { recordModelGate } from './record-model-evidence.mjs';
import { persistFixture, validFixture } from './model-evidence-fixture.mjs';

test('valid model evidence is sanitized and written', async () => {
  const input = await validFixture();
  const path = await recordModelGate(input);
  const evidence = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(evidence.status, 'passed');
  assert.equal(evidence.runId, 'run-1');
  assert.equal(evidence.pending, 0);
  assert.equal(evidence.confirmedFalse, 0);
  assert.equal(evidence.red.failedAssertions, 1);
  assert.equal('transcriptPath' in evidence, false);
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
