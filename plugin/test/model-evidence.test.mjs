import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { recordModelGate } from './record-model-evidence.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bh-model-evidence-'));
  const runDir = join(root, 'run-1');
  const transcriptPath = join(root, 'transcript.jsonl');
  await mkdir(runDir, { recursive: true });
  await writeFile(transcriptPath, '{}\n');
  const run = {
    id: 'run-1', status: 'finished',
    stages: { explore: 'done', reproduce: 'done', triage: 'done', export: 'done' },
    targetStages: { '/orders/new': 'done' },
  };
  await writeFile(join(runDir, 'run.json'), JSON.stringify(run));
  return {
    root, runDir, run,
    input: {
      host: 'qwen', surface: 'cli', gate: 'target', clientVersion: '1.0.0-preview.1',
      sourceCommit: 'a'.repeat(40), runId: 'run-1', runDir,
      redCommand: 'npx playwright test e2e/bughunter --workers=1',
      redResult: { failedAssertions: 1 }, evidenceDir: join(root, 'evidence'),
      orchestration: {
        nativeForegroundAgents: true, singleExplorer: true,
        mainRestrictedTools: 0, confirmedFalse: 0, transcriptPath,
      },
    },
  };
}

test('valid model evidence is sanitized and written', async () => {
  const { input } = await fixture();
  const path = await recordModelGate(input);
  const evidence = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(evidence.status, 'passed');
  assert.equal(evidence.runId, 'run-1');
  assert.equal('transcriptPath' in evidence, false);
});

test('invalid model and orchestration inputs are rejected', async () => {
  for (const patch of [
    { runId: 'other' },
    { redResult: { failedAssertions: 0 } },
    { orchestration: { nativeForegroundAgents: false } },
    { orchestration: { singleExplorer: false } },
    { orchestration: { mainRestrictedTools: 1 } },
    { orchestration: { confirmedFalse: 1 } },
  ]) {
    const { input } = await fixture();
    const invalid = {
      ...input,
      ...patch,
      ...(patch.orchestration
        ? { orchestration: { ...input.orchestration, ...patch.orchestration } }
        : {}),
    };
    await assert.rejects(recordModelGate(invalid));
  }
});

test('unfinished run and pending stages are rejected', async () => {
  for (const patch of [{ status: 'writing_tests' }, { stages: { explore: 'pending' } }]) {
    const { input, run, runDir } = await fixture();
    const invalid = { ...run, ...patch };
    if (patch.stages) invalid.stages = { ...run.stages, ...patch.stages };
    await writeFile(join(runDir, 'run.json'), JSON.stringify(invalid));
    await assert.rejects(recordModelGate(input));
  }
});
