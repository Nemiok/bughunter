import { readFile } from 'node:fs/promises';

const EXPLORER = 'bughunter:bh-explorer';
const RESTRICTED_MAIN_TOOLS = new Set([
  'mcp__bughunter__bh_reproduce',
  'mcp__bughunter__bh_triage',
  'mcp__bughunter__bh_export_test',
  'mcp__bughunter__bh_verify_red',
]);

function contentBlocks(event) {
  return Array.isArray(event?.message?.content) ? event.message.content : [];
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (typeof block === 'string' ? block : typeof block?.text === 'string' ? block.text : ''))
    .join('');
}

function parseJsonContent(content) {
  const text = textFromContent(content).trim();
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isReloadAcknowledgement(event) {
  if (event?.type !== 'host') return false;
  const command = event.command ?? event.event;
  const succeeded = event.status === 'success' || event.result === 'success' || event.ok === true;
  return succeeded && (command === '/plugins reload' || event.event === 'plugins.reload');
}

async function readEvents(transcriptPaths) {
  if (!Array.isArray(transcriptPaths) || transcriptPaths.length === 0) throw new Error('TRANSCRIPT_EMPTY');
  const events = [];
  for (const path of transcriptPaths) {
    let raw;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      throw new Error(`TRANSCRIPT_READ_FAILED: ${path}`);
    }
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim() === '') continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        throw new Error(`TRANSCRIPT_INVALID: ${path}`);
      }
    }
  }
  const meaningful = events.some((event) =>
    event?.type === 'host' || contentBlocks(event).length > 0);
  if (!meaningful) throw new Error('TRANSCRIPT_EMPTY');
  return events;
}

function toolUses(events) {
  const uses = [];
  events.forEach((event, index) => {
    for (const block of contentBlocks(event)) {
      if (block?.type === 'tool_use' && typeof block.name === 'string') {
        uses.push({ index, id: block.id, name: block.name, input: block.input ?? {} });
      }
    }
  });
  return uses;
}

function toolResults(events) {
  const results = new Map();
  events.forEach((event, index) => {
    for (const block of contentBlocks(event)) {
      if (block?.type === 'tool_result') {
        results.set(block.tool_use_id, { index, content: block.content, isError: block.is_error === true });
      }
    }
  });
  return results;
}

function userTexts(events) {
  const texts = [];
  events.forEach((event, index) => {
    if (event?.message?.role !== 'user') return;
    for (const block of contentBlocks(event)) {
      if (block?.type === 'text' && typeof block.text === 'string') texts.push({ index, text: block.text });
    }
  });
  return texts;
}

function runIdFromResult(results, toolId) {
  const result = results.get(toolId);
  if (result === undefined) return undefined;
  const value = parseJsonContent(result.content);
  return typeof value?.runId === 'string' ? value.runId : undefined;
}

function requireRunId(results, tool, runId, code) {
  const actual = runIdFromResult(results, tool.id);
  if (actual !== runId) throw new Error(`${code}: expected ${runId}, got ${actual ?? 'missing'}`);
}

export async function inspectQwenTranscript({ transcriptPaths, runId, gate }) {
  const events = await readEvents(transcriptPaths);
  const uses = toolUses(events);
  const results = toolResults(events);
  const texts = userTexts(events);

  const restricted = uses.find((tool) => RESTRICTED_MAIN_TOOLS.has(tool.name));
  if (restricted !== undefined) throw new Error(`TRANSCRIPT_MAIN_RESTRICTED_TOOL: ${restricted.name}`);

  const startUses = uses.filter((tool) => tool.name === 'mcp__bughunter__bh_start_run');
  const resumeUses = uses.filter((tool) => tool.name === 'mcp__bughunter__bh_resume_run');
  let opening;
  let reloadVerified = false;

  if (gate === 'target') {
    const reload = events.findIndex((event) => isReloadAcknowledgement(event));
    if (reload < 0) throw new Error('TRANSCRIPT_RELOAD_REQUIRED');
    const continuation = texts.find((item) => item.index > reload && /продолжай/i.test(item.text));
    if (continuation === undefined) throw new Error('TRANSCRIPT_CONTINUATION_REQUIRED');
    opening = startUses.find((tool) => tool.index > continuation.index);
    if (opening === undefined) throw new Error('TRANSCRIPT_START_REQUIRED');
    reloadVerified = true;
  } else if (gate === 'resume') {
    opening = resumeUses[0];
    if (opening === undefined) throw new Error('TRANSCRIPT_RESUME_REQUIRED');
  } else {
    opening = startUses[0];
    if (opening === undefined) throw new Error('TRANSCRIPT_START_REQUIRED');
  }

  requireRunId(results, opening, runId, 'TRANSCRIPT_START_RUN_MISMATCH');

  const exploreUses = uses.filter((tool) => tool.name === 'mcp__bughunter__bh_explore_next');
  for (const tool of exploreUses) {
    if (tool.input.runId !== runId) throw new Error('TRANSCRIPT_RUN_MISMATCH: bh_explore_next');
  }
  for (const tool of resumeUses) {
    if (tool.input.runId !== undefined && tool.input.runId !== runId) {
      throw new Error('TRANSCRIPT_RUN_MISMATCH: bh_resume_run');
    }
    requireRunId(results, tool, runId, 'TRANSCRIPT_RESUME_RUN_MISMATCH');
  }

  let pendingLeaseId;
  let pendingAgentId;
  let awaitingAgent = false;
  let explorerAgents = 0;
  for (const event of events) {
    for (const block of contentBlocks(event)) {
      if (block?.type === 'tool_use') {
        if (block.name === 'mcp__bughunter__bh_explore_next') {
          if (pendingAgentId !== undefined || awaitingAgent) throw new Error('TRANSCRIPT_EXPLORER_OVERLAP');
          if (pendingLeaseId !== undefined) throw new Error('TRANSCRIPT_EXPLORE_INCOMPLETE');
          pendingLeaseId = block.id;
        } else if (block.name === 'Agent') {
          if (block.input?.run_in_background !== false) throw new Error('TRANSCRIPT_AGENT_BACKGROUND');
          if (block.input?.subagent_type === EXPLORER) {
            if (pendingAgentId !== undefined || awaitingAgent === false) {
              throw new Error('TRANSCRIPT_EXPLORER_OVERLAP');
            }
            pendingAgentId = block.id;
            awaitingAgent = false;
            explorerAgents += 1;
          }
        }
      } else if (block?.type === 'tool_result') {
        if (block.tool_use_id === pendingLeaseId) {
          const lease = parseJsonContent(block.content);
          if (lease?.status === 'task') awaitingAgent = true;
          else if (lease?.status === 'done') awaitingAgent = false;
          else throw new Error('TRANSCRIPT_LEASE_INVALID');
          pendingLeaseId = undefined;
        }
        if (block.tool_use_id === pendingAgentId) pendingAgentId = undefined;
      }
    }
  }
  if (pendingLeaseId !== undefined || pendingAgentId !== undefined || awaitingAgent) {
    throw new Error('TRANSCRIPT_EXPLORE_INCOMPLETE');
  }
  if (explorerAgents === 0) throw new Error('TRANSCRIPT_EXPLORER_REQUIRED');

  return {
    nativeForegroundAgents: true,
    singleExplorer: true,
    mainRestrictedTools: 0,
    reloadVerified,
  };
}
