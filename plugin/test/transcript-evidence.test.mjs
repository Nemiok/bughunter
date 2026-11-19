import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { inspectQwenTranscript } from './transcript-evidence.mjs';

const RUN_ID = 'run-1';

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

const reload = { type: 'host', event: 'plugins.reload', command: '/plugins reload', status: 'success' };
const continuation = userText('Продолжай');
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

const targetFlow = [reload, continuation, start, startResult, lease1, lease1Result, explorer, explorerResult, lease2, lease2Done];
const resumeFlow = [start, startResult, lease1, lease1Result, explorer, explorerResult, lease2, lease2Done, resumed, resumedResult];

async function transcript(lines) {
  const root = await mkdtemp(join(tmpdir(), 'bh-transcript-'));
  const path = join(root, 'qwen.jsonl');
  await writeFile(path, lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
  return path;
}

test('qwen target transcript proves reload, continuation, foreground explorer and a single lease', async () => {
  const path = await transcript(targetFlow);
  assert.deepEqual(await inspectQwenTranscript({ transcriptPaths: [path], runId: RUN_ID, gate: 'target' }), {
    nativeForegroundAgents: true, singleExplorer: true, mainRestrictedTools: 0, reloadVerified: true,
  });
});

test('qwen resume transcript requires resume_run but not reload', async () => {
  const path = await transcript(resumeFlow);
  assert.deepEqual(await inspectQwenTranscript({ transcriptPaths: [path], runId: RUN_ID, gate: 'resume' }), {
    nativeForegroundAgents: true, singleExplorer: true, mainRestrictedTools: 0, reloadVerified: false,
  });
});

test('qwen foreground explorer may omit run_in_background', async () => {
  const implicit = toolUse('Agent', {
    description: 'explore /orders/new', subagent_type: 'bughunter:bh-explorer', prompt: 'explore',
  }, 'agent-1');
  const path = await transcript(targetFlow.map((line) => line === explorer ? implicit : line));
  assert.deepEqual(await inspectQwenTranscript({ transcriptPaths: [path], runId: RUN_ID, gate: 'target' }), {
    nativeForegroundAgents: true, singleExplorer: true, mainRestrictedTools: 0, reloadVerified: true,
  });
});

test('qwen node explorer alias is accepted', async () => {
  const nodeExplorer = toolUse('Agent', {
    description: 'explore', subagent_type: 'bughunter:bh-explorer-node', prompt: 'explore',
  }, 'agent-1');
  const path = await transcript([start, startResult, lease1, lease1Result, nodeExplorer, explorerResult, lease2, lease2Done]);
  assert.deepEqual(await inspectQwenTranscript({ transcriptPaths: [path], runId: RUN_ID, gate: 'node-target' }), {
    nativeForegroundAgents: true, singleExplorer: true, mainRestrictedTools: 0, reloadVerified: false,
  });
});

test('qwen transcript rejects empty input', async () => {
  const path = await transcript([{}]);
  await assert.rejects(inspectQwenTranscript({ transcriptPaths: [path], runId: RUN_ID, gate: 'target' }), /TRANSCRIPT_EMPTY/);
});

test('qwen init is a meaningful event for activation parsing', async () => {
  const path = await transcript([{ type: 'system', subtype: 'init', session_id: 'session-1', tools: [] }]);
  await assert.rejects(
    inspectQwenTranscript({ transcriptPaths: [path], runId: RUN_ID, gate: 'node-target' }),
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

test('qwen target transcript rejects a missing reload acknowledgement', async () => {
  const path = await transcript(targetFlow.filter((line) => line !== reload));
  await assert.rejects(inspectQwenTranscript({ transcriptPaths: [path], runId: RUN_ID, gate: 'target' }), /TRANSCRIPT_RELOAD_REQUIRED/);
});

test('qwen target transcript rejects a missing continuation', async () => {
  const path = await transcript(targetFlow.filter((line) => line !== continuation));
  await assert.rejects(inspectQwenTranscript({ transcriptPaths: [path], runId: RUN_ID, gate: 'target' }), /TRANSCRIPT_CONTINUATION_REQUIRED/);
});

test('qwen target transcript rejects continuation before reload', async () => {
  const path = await transcript([continuation, reload, ...targetFlow.filter((line) => line !== reload && line !== continuation)]);
  await assert.rejects(inspectQwenTranscript({ transcriptPaths: [path], runId: RUN_ID, gate: 'target' }), /TRANSCRIPT_CONTINUATION_REQUIRED/);
});

test('RELOAD_READY and a user request are not host acknowledgement', async () => {
  for (const fake of [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'RELOAD_READY' }] } },
    userText('/plugins reload'),
    { type: 'system', subtype: 'init' },
  ]) {
    const path = await transcript([fake, continuation, ...targetFlow.filter((line) => line !== reload && line !== continuation)]);
    await assert.rejects(inspectQwenTranscript({ transcriptPaths: [path], runId: RUN_ID, gate: 'target' }), /TRANSCRIPT_RELOAD_REQUIRED/);
  }
});
