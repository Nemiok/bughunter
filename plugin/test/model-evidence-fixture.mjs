import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const MODEL_COMMIT = 'a'.repeat(40);
export const RUN_ID = 'run-1';
export const CANDIDATE_TEST = 'e2e/bughunter/orders-new.spec.ts';

function toolUse(name, input, id) {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  };
}

function toolResult(id, content) {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
  };
}

function userText(text) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
}

async function writeTranscript(path, runId) {
  const reload = { type: 'host', event: 'plugins.reload', command: '/plugins reload', status: 'success' };
  const continuation = userText('Продолжай');
  const start = toolUse('mcp__bughunter__bh_start_run', { scope: 'target', target: '/orders/new' }, 'start-1');
  const startResult = toolResult('start-1', JSON.stringify({ runId, targets: ['/orders/new'] }));
  const lease1 = toolUse('mcp__bughunter__bh_explore_next', { runId, target: '/orders/new' }, 'lease-1');
  const lease1Result = toolResult('lease-1', JSON.stringify({
    status: 'task', leaseId: 'lease-1', target: '/orders/new', persona: 'новичок',
  }));
  const explorer = toolUse('Agent', {
    description: 'explore /orders/new', subagent_type: 'bughunter:bh-explorer', run_in_background: false, prompt: 'explore',
  }, 'agent-1');
  const explorerResult = toolResult('agent-1', 'explored /orders/new');
  const lease2 = toolUse('mcp__bughunter__bh_explore_next', { runId, target: '/orders/new' }, 'lease-2');
  const lease2Done = toolResult('lease-2', JSON.stringify({ status: 'done' }));
  const resumed = toolUse('mcp__bughunter__bh_resume_run', { runId }, 'resume-1');
  const resumedResult = toolResult('resume-1', JSON.stringify({ runId }));
  const events = [
    reload, continuation, start, startResult,
    lease1, lease1Result, explorer, explorerResult, lease2, lease2Done,
    resumed, resumedResult,
  ];
  await writeFile(path, events.map((event) => `${JSON.stringify(event)}\n`).join(''));
}

export async function validFixture() {
  const root = await mkdtemp(join(tmpdir(), 'bh-model-evidence-'));
  const runId = RUN_ID;
  const runDir = join(root, 'runs', runId);
  const evidenceDir = join(root, 'evidence');
  const transcriptPath = join(root, 'transcript.jsonl');
  const reportPath = join(root, 'playwright-report.json');
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
    tests: { e2e: CANDIDATE_TEST },
    verdicts: { e2e: 'red' },
  };

  const report = {
    suites: [{
      title: 'orders', file: CANDIDATE_TEST, specs: [{
        title: 'total', file: CANDIDATE_TEST, tests: [{
          title: 'renders numeric total',
          results: [{ status: 'failed', error: { message: 'Total: NaN' } }],
        }],
      }],
    }],
    errors: [],
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
    evidenceDir,
    orchestration: { transcriptPaths: [transcriptPath] },
    red: {
      runner: 'playwright',
      cwd: root,
      testPath: CANDIDATE_TEST,
      reportPath,
      spawn: () => ({ status: 1 }),
    },
    run,
    candidate,
    expectedEvidencePath: join(evidenceDir, 'qwen', 'target.json'),
    transcriptPath,
    reportPath,
  };

  await persistFixture(input);
  await writeTranscript(transcriptPath, runId);
  await writeFile(reportPath, JSON.stringify(report));
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
