import { writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BUGHUNTER_AGENTS,
  BUGHUNTER_SKILLS,
  BUGHUNTER_WEB_TOOLS,
} from './activation-fixture.mjs';

export const MODEL_COMMIT = 'a'.repeat(40);
export const RUN_ID = 'run-1';
export const CANDIDATE_TEST = 'e2e/bughunter/orders-new.spec.ts';
export const NODE_CANDIDATE_TEST = 'test/bughunter/orders.api.test.ts';
export const NODE_TOOLS = BUGHUNTER_WEB_TOOLS.slice(0, 16);

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

export function modelInit(projectRoot, preset = 'web', patch = {}) {
  return {
    type: 'system',
    subtype: 'init',
    session_id: `session-${preset}`,
    cwd: projectRoot,
    tools: preset === 'node' ? [...NODE_TOOLS] : [...BUGHUNTER_WEB_TOOLS],
    skills: [...BUGHUNTER_SKILLS],
    agents: [...BUGHUNTER_AGENTS],
    mcp_servers: [{ name: 'bughunter', status: 'connected' }],
    plugins: [{ name: 'bughunter', path: '/plugin' }],
    ...patch,
  };
}

export async function writeTranscript(path, runId, projectRoot, options = {}) {
  const target = options.target ?? '/orders/new';
  const init = options.includeInit === false
    ? undefined
    : modelInit(options.initCwd ?? projectRoot, options.preset ?? 'web', options.initPatch);
  const start = toolUse('mcp__bughunter__bh_start_run', { scope: 'target', target }, 'start-1');
  const startResult = toolResult('start-1', JSON.stringify({ runId, targets: [target] }));
  const lease1 = toolUse('mcp__bughunter__bh_explore_next', { runId, target }, 'lease-1');
  const lease1Result = toolResult('lease-1', JSON.stringify({
    status: 'task', leaseId: 'lease-1', target, persona: 'новичок',
  }));
  const explorer = toolUse('Agent', {
    description: `explore ${target}`, subagent_type: 'bughunter:bh-explorer', run_in_background: false, prompt: 'explore',
  }, 'agent-1');
  const explorerResult = toolResult('agent-1', `explored ${target}`);
  const lease2 = toolUse('mcp__bughunter__bh_explore_next', { runId, target }, 'lease-2');
  const lease2Done = toolResult('lease-2', JSON.stringify({ status: 'done' }));
  const resumed = toolUse('mcp__bughunter__bh_resume_run', { runId }, 'resume-1');
  const resumedResult = toolResult('resume-1', JSON.stringify({ runId }));
  const events = [
    init, start, startResult,
    lease1, lease1Result, explorer, explorerResult, lease2, lease2Done,
    resumed, resumedResult,
  ].filter(Boolean);
  await writeFile(path, events.map((event) => `${JSON.stringify(event)}\n`).join(''));
}

function playwrightReport(testPath) {
  return {
    suites: [{
      title: 'orders', file: testPath, specs: [{
        title: 'total', file: testPath, tests: [{
          title: 'renders numeric total',
          results: [{ status: 'failed', error: { message: 'Total: NaN' } }],
        }],
      }],
    }],
    errors: [],
  };
}

function vitestReport(testPath) {
  return {
    numFailedTests: 1,
    testResults: [{
      name: testPath,
      assertionResults: [{ status: 'failed', title: 'returns orders' }],
    }],
  };
}

export async function validFixture({
  gate = 'target',
  target = '/orders/new',
  preset = 'web',
  candidateTest = CANDIDATE_TEST,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bh-model-evidence-'));
  const runId = RUN_ID;
  const runDir = join(root, 'runs', runId);
  const evidenceDir = join(root, 'evidence');
  const transcriptPath = join(root, 'transcript.jsonl');
  const reportPath = join(root, 'red-report.json');
  await mkdir(join(runDir, 'candidates'), { recursive: true });

  const run = {
    id: runId,
    scope: 'target',
    targets: [target],
    status: 'finished',
    stages: { explore: 'done', reproduce: 'done', triage: 'done', export: 'done' },
    targetStages: { [target]: 'done' },
    createdAt: '2026-11-19T00:00:00.000Z',
    updatedAt: '2026-11-19T00:10:00.000Z',
  };

  const candidate = {
    id: 'bug-1',
    runId,
    sessionId: 'session-1',
    target,
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
    review: { status: 'confirmed', reason: `reproduced on ${target}` },
    tests: preset === 'node' ? { api: candidateTest } : { e2e: candidateTest },
    verdicts: preset === 'node' ? { api: 'red' } : { e2e: 'red' },
  };

  const report = preset === 'node' ? vitestReport(candidateTest) : playwrightReport(candidateTest);
  const input = {
    root,
    host: 'qwen',
    surface: 'cli',
    gate,
    clientVersion: '1.0.0-preview.2',
    sourceCommit: MODEL_COMMIT,
    runId,
    runDir,
    evidenceDir,
    orchestration: { transcriptPaths: [transcriptPath] },
    red: {
      runner: preset === 'node' ? 'vitest' : 'playwright',
      cwd: root,
      testPath: candidateTest,
      reportPath,
      spawn: () => {
        writeFileSync(reportPath, JSON.stringify(report));
        return { status: 1 };
      },
    },
    run,
    candidate,
    expectedEvidencePath: join(evidenceDir, 'qwen', `${gate}.json`),
    transcriptPath,
    reportPath,
    preset,
    target,
  };

  await persistFixture(input);
  await writeTranscript(transcriptPath, runId, root, { preset, target });
  await writeFile(reportPath, JSON.stringify(report));
  return input;
}

export async function validNodeFixture() {
  return validFixture({
    gate: 'node-target',
    target: 'GET /orders',
    preset: 'node',
    candidateTest: NODE_CANDIDATE_TEST,
  });
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
