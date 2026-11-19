import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const MODEL_COMMIT = 'a'.repeat(40);

export async function validFixture() {
  const root = await mkdtemp(join(tmpdir(), 'bh-model-evidence-'));
  const runId = 'run-1';
  const runDir = join(root, 'runs', runId);
  const evidenceDir = join(root, 'evidence');
  const transcriptPath = join(root, 'transcript.jsonl');
  await mkdir(join(runDir, 'candidates'), { recursive: true });

  const run = {
    id: runId,
    scope: 'target',
    targets: ['/orders/new'],
    status: 'finished',
    stages: { explore: 'done', reproduce: 'done', triage: 'done', export: 'done' },
    targetStages: { '/orders/new': 'done' },
    createdAt: '2026-11-19T00:00:00.000Z',
    updatedAt: '2026-11-19T00:10:00.000Z',
  };

  const candidate = {
    id: 'bug-1',
    runId,
    sessionId: 'session-1',
    target: '/orders/new',
    title: 'Total is NaN on first paint',
    expected: 'Numeric total',
    actual: 'Total: NaN',
    signalIds: ['signal-1'],
    signature: 'signature-1',
    steps: [],
    artifacts: [],
    status: 'confirmed',
    createdAt: '2026-11-19T00:05:00.000Z',
    reproduction: { status: 'reproduced', attempts: 1 },
    review: { status: 'confirmed', reason: 'reproduced on /orders/new' },
    tests: { e2e: 'e2e/bughunter/orders-new.spec.ts' },
    verdicts: { e2e: 'red' },
  };

  const input = {
    root,
    host: 'qwen',
    surface: 'cli',
    gate: 'target',
    clientVersion: '1.0.0-preview.2',
    sourceCommit: MODEL_COMMIT,
    runId,
    runDir,
    redCommand: 'npx playwright test e2e/bughunter/orders-new.spec.ts --workers=1',
    redResult: { failedAssertions: 1 },
    evidenceDir,
    orchestration: {
      nativeForegroundAgents: true,
      singleExplorer: true,
      mainRestrictedTools: 0,
      confirmedFalse: 0,
      transcriptPath,
    },
    run,
    candidate,
    expectedEvidencePath: join(evidenceDir, 'qwen', 'target.json'),
  };

  await persistFixture(input);
  await writeFile(transcriptPath, `${JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'mcp__bughunter__bh_start_run', input: { runId } }] },
  })}\n`);
  return input;
}

export async function persistFixture(input) {
  await mkdir(input.runDir, { recursive: true });
  await writeFile(join(input.runDir, 'run.json'), `${JSON.stringify(input.run, null, 2)}\n`);
  await rm(join(input.runDir, 'candidates'), { recursive: true, force: true });
  await mkdir(join(input.runDir, 'candidates'), { recursive: true });
  if (input.candidate !== undefined) {
    await writeFile(
      join(input.runDir, 'candidates', `${input.candidate.id}.json`),
      `${JSON.stringify(input.candidate, null, 2)}\n`,
    );
  }
}
