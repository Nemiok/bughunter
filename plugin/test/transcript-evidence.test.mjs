import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { inspectQwenTranscript } from './transcript-evidence.mjs';

const RUN_ID = 'run-1';
const PROJECT_ROOT = '/project';
const NODE_TOOLS = Array.from({ length: 16 }, (_, index) => `mcp__bughunter__node_tool_${index}`);

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

function initEvent({ projectRoot = PROJECT_ROOT, tools = NODE_TOOLS, sessionId = 'session-node' } = {}) {
  return {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    cwd: projectRoot,
    tools,
    skills: ['bughunter'],
    agents: ['bh-explorer'],
    mcp_servers: [{ name: 'bughunter', status: 'connected' }],
    plugins: [{ name: 'bughunter', path: '/plugin' }],
  };
}

const start = toolUse('mcp__bughunter__bh_start_run', { scope: 'target', target: '/orders/new' }, 'start-1');
const startResult = toolResult('start-1', JSON.stringify({ runId: RUN_ID, targets: ['/orders/new'] }));
const lease1 = toolUse('mcp__bughunter__bh_explore_next', { runId: RUN_ID, target: '/orders/new' }, 'lease-1');
const lease1Result = toolResult('lease-1', JSON.stringify({
  status: 'task', leaseId: 'lease-1', target: '/orders/new', persona: 'новичок',
}));
const explorer = toolUse('Agent', {
  description: 'explore /orders/new', subagent_type: 'bughunter:bh-explorer', run_in_background: false, prompt: 'explore',
}, 'agent-1');
const explorerResult = toolResult('agent-1', 'explored /orders/new');
const lease2 = toolUse('mcp__bughunter__bh_explore_next', { runId: RUN_ID, target: '/orders/new' }, 'lease-2');
const lease2Done = toolResult('lease-2', JSON.stringify({ status: 'done' }));
const resumed = toolUse('mcp__bughunter__bh_resume_run', { runId: RUN_ID }, 'resume-1');
const resumedResult = toolResult('resume-1', JSON.stringify({ runId: RUN_ID }));

const targetFlow = [start, startResult, lease1, lease1Result, explorer, explorerResult, lease2, lease2Done];
const resumeFlow = [...targetFlow, resumed, resumedResult];
const nodeFlow = [initEvent(), ...targetFlow];

async function transcript(lines) {
  const root = await mkdtemp(join(tmpdir(), 'bh-transcript-'));
  const path = join(root, 'qwen.jsonl');
  await writeFile(path, lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
  return path;
}

test('qwen target transcript proves a foreground explorer and a single lease', async () => {
  const path = await transcript(targetFlow);
  assert.deepEqual(await inspectQwenTranscript({ transcriptPaths: [path], runId: RUN_ID, gate: 'target' }), {
    nativeForegroundAgents: true, singleExplorer: true, mainRestrictedTools: 0,
  });
});

test('qwen resume transcript requires resume_run', async () => {
  const path = await transcript(resumeFlow);
  assert.deepEqual(await inspectQwenTranscript({ transcriptPaths: [path], runId: RUN_ID, gate: 'resume' }), {
    nativeForegroundAgents: true, singleExplorer: true, mainRestrictedTools: 0,
  });
});

test('qwen foreground explorer may omit run_in_background', async () => {
  const implicit = toolUse('Agent', {
    description: 'explore /orders/new', subagent_type: 'bughunter:bh-explorer', prompt: 'explore',
  }, 'agent-1');
  const path = await transcript(targetFlow.map((line) => line === explorer ? implicit : line));
  assert.deepEqual(await inspectQwenTranscript({ transcriptPaths: [path], runId: RUN_ID, gate: 'target' }), {
    nativeForegroundAgents: true, singleExplorer: true, mainRestrictedTools: 0,
  });
});

test('qwen node explorer alias is accepted', async () => {
  const nodeExplorer = toolUse('Agent', {
    description: 'explore', subagent_type: 'bughunter:bh-explorer-node', prompt: 'explore',
  }, 'agent-1');
  const path = await transcript([initEvent(), ...targetFlow.map((line) => line === explorer ? nodeExplorer : line)]);
  assert.deepEqual(await inspectQwenTranscript({
    transcriptPaths: [path], runId: RUN_ID, gate: 'node-target', projectRoot: PROJECT_ROOT,
  }), {
    nativeForegroundAgents: true,
    singleExplorer: true,
    mainRestrictedTools: 0,
    activeToolsVerified: true,
    preset: 'node',
    toolCount: 16,
  });
});

test('qwen node target requires a connected init with sixteen Bughunter tools', async () => {
  const path = await transcript(nodeFlow);
  assert.deepEqual(await inspectQwenTranscript({
    transcriptPaths: [path], runId: RUN_ID, gate: 'node-target', projectRoot: PROJECT_ROOT,
  }), {
    nativeForegroundAgents: true,
    singleExplorer: true,
    mainRestrictedTools: 0,
    activeToolsVerified: true,
    preset: 'node',
    toolCount: 16,
  });
});

for (const [name, init, code] of [
  ['fifteen tools', initEvent({ tools: NODE_TOOLS.slice(0, 15) }), /TRANSCRIPT_NODE_TOOLS_REQUIRED/],
  ['dormant tools', initEvent({ tools: ['mcp__bughunter__bh_setup'] }), /TRANSCRIPT_NODE_TOOLS_REQUIRED/],
  ['another project', initEvent({ projectRoot: '/other-project' }), /TRANSCRIPT_PROJECT_INIT_REQUIRED/],
]) {
  test(`qwen node target rejects ${name}`, async () => {
    const path = await transcript([init, ...targetFlow]);
    await assert.rejects(inspectQwenTranscript({
      transcriptPaths: [path], runId: RUN_ID, gate: 'node-target', projectRoot: PROJECT_ROOT,
    }), code);
  });
}

test('qwen node target rejects a missing init', async () => {
  const path = await transcript(targetFlow);
  await assert.rejects(inspectQwenTranscript({
    transcriptPaths: [path], runId: RUN_ID, gate: 'node-target', projectRoot: PROJECT_ROOT,
  }), /TRANSCRIPT_PROJECT_INIT_REQUIRED/);
});

test('qwen transcript rejects empty input', async () => {
  const path = await transcript([{}]);
  await assert.rejects(inspectQwenTranscript({ transcriptPaths: [path], runId: RUN_ID, gate: 'target' }), /TRANSCRIPT_EMPTY/);
});

test('qwen init is a meaningful event for activation parsing', async () => {
  const path = await transcript([{ type: 'system', subtype: 'init', session_id: 'session-1', tools: [] }]);
  await assert.rejects(
    inspectQwenTranscript({ transcriptPaths: [path], runId: RUN_ID, gate: 'target' }),
    /TRANSCRIPT_START_REQUIRED/,
  );
});

test('qwen target transcript rejects missing start', async () => {
  const path = await transcript(targetFlow.filter((line) => line !== start && line !== startResult));
  await assert.rejects(inspectQwenTranscript({ transcriptPaths: [path], runId: RUN_ID, gate: 'target' }), /TRANSCRIPT_START_REQUIRED/);
});

test('qwen transcript rejects a start result without the runId', async () => {
  const path = await transcript(targetFlow.map((line) => line === startResult ? toolResult('start-1', '{}') : line));
  await assert.rejects(inspectQwenTranscript({ transcriptPaths: [path], runId: RUN_ID, gate: 'target' }), /TRANSCRIPT_START_RUN_MISMATCH/);
});

test('qwen transcript rejects a background explorer', async () => {
  const background = toolUse('Agent', {
    description: 'explore', subagent_type: 'bughunter:bh-explorer', run_in_background: true, prompt: 'explore',
  }, 'agent-1');
  const path = await transcript(targetFlow.map((line) => line === explorer ? background : line));
  await assert.rejects(inspectQwenTranscript({ transcriptPaths: [path], runId: RUN_ID, gate: 'target' }), /TRANSCRIPT_AGENT_BACKGROUND/);
});

test('qwen transcript rejects a second lease before the explorer result', async () => {
  const path = await transcript(targetFlow.filter((line) => line !== explorerResult));
  await assert.rejects(inspectQwenTranscript({ transcriptPaths: [path], runId: RUN_ID, gate: 'target' }), /TRANSCRIPT_EXPLORER_OVERLAP/);
});

test('qwen transcript rejects a lease for another run', async () => {
  const wrongLease = toolUse('mcp__bughunter__bh_explore_next', { runId: 'run-2', target: '/orders/new' }, 'lease-1');
  const path = await transcript(targetFlow.map((line) => line === lease1 ? wrongLease : line));
  await assert.rejects(inspectQwenTranscript({ transcriptPaths: [path], runId: RUN_ID, gate: 'target' }), /TRANSCRIPT_RUN_MISMATCH/);
});

for (const name of [
  'mcp__bughunter__bh_reproduce',
  'mcp__bughunter__bh_triage',
  'mcp__bughunter__bh_export_test',
  'mcp__bughunter__bh_verify_red',
]) {
  test(`qwen transcript rejects main ${name}`, async () => {
    const restricted = toolUse(name, { runId: RUN_ID }, 'restricted-1');
    const path = await transcript([...targetFlow, restricted, toolResult('restricted-1', 'ok')]);
    await assert.rejects(inspectQwenTranscript({ transcriptPaths: [path], runId: RUN_ID, gate: 'target' }), /TRANSCRIPT_MAIN_RESTRICTED_TOOL/);
  });
}

test('qwen target no longer treats a reload acknowledgement as evidence', async () => {
  const reload = { type: 'host', event: 'plugins.reload', command: '/plugins reload', status: 'success' };
  const path = await transcript([reload, ...targetFlow]);
  assert.deepEqual(await inspectQwenTranscript({ transcriptPaths: [path], runId: RUN_ID, gate: 'target' }), {
    nativeForegroundAgents: true, singleExplorer: true, mainRestrictedTools: 0,
  });
});

test('a user reload request and a continuation are not activation evidence for the model inspector', async () => {
  const path = await transcript([
    userText('/plugins reload'),
    userText('Продолжай'),
    ...targetFlow,
  ]);
  assert.deepEqual(await inspectQwenTranscript({ transcriptPaths: [path], runId: RUN_ID, gate: 'target' }), {
    nativeForegroundAgents: true, singleExplorer: true, mainRestrictedTools: 0,
  });
});
