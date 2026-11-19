import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const EXPLORERS = new Set(['bughunter:bh-explorer', 'bughunter:bh-explorer-node']);
const BUGHUNTER_AGENTS = new Set([
  'bh-explorer',
  'bh-reviewer',
  'bh-test-writer',
  'bh-explorer-node',
  'bh-reviewer-node',
  'bh-test-writer-node',
]);
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
    event?.type === 'host'
    || (event?.type === 'system' && event?.subtype === 'init')
    || contentBlocks(event).length > 0);
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

function isBughunterSkill(name) {
  return name === 'bughunter' || name.startsWith('bughunter-') || name.startsWith('bughunter:');
}

function isBughunterAgent(name) {
  return name.startsWith('bughunter:') || BUGHUNTER_AGENTS.has(name);
}

function requireInit(init) {
  if (init?.type !== 'system' || init?.subtype !== 'init') throw new Error('TRANSCRIPT_INIT_REQUIRED');
  if (!Array.isArray(init.tools) || !Array.isArray(init.skills) || !Array.isArray(init.agents)) {
    throw new Error('TRANSCRIPT_INIT_REQUIRED');
  }
  return init;
}

export function inspectQwenComponents(init) {
  requireInit(init);
  const tools = init.tools.filter((name) => typeof name === 'string' && name.startsWith('mcp__bughunter__'));
  const skills = init.skills.filter((name) => typeof name === 'string' && isBughunterSkill(name));
  const agents = init.agents.filter((name) => typeof name === 'string' && isBughunterAgent(name));
  const mcpConnected = Array.isArray(init.mcp_servers)
    && init.mcp_servers.some((server) => server?.name === 'bughunter' && server?.status === 'connected');
  return {
    toolCount: tools.length,
    skillCount: skills.length,
    agentCount: agents.length,
    mcpConnected,
    dormantOnly: tools.length === 1 && tools[0] === 'mcp__bughunter__bh_setup',
  };
}

function findInit(events, missingCode) {
  const event = events.find((entry) => entry?.type === 'system' && entry?.subtype === 'init');
  if (event === undefined) throw new Error(missingCode);
  return event;
}

function projectInit(events, projectRoot, openingIndex) {
  if (typeof projectRoot !== 'string' || projectRoot.trim() === '') {
    throw new Error('TRANSCRIPT_PROJECT_ROOT_REQUIRED');
  }
  const init = events.find((entry, index) => index < openingIndex
    && entry?.type === 'system'
    && entry?.subtype === 'init'
    && typeof entry.cwd === 'string'
    && resolve(entry.cwd) === resolve(projectRoot));
  if (init === undefined) throw new Error('TRANSCRIPT_PROJECT_INIT_REQUIRED');
  return init;
}

function bughunterPlugin(init) {
  return Array.isArray(init.plugins)
    ? init.plugins.find((plugin) => plugin?.name === 'bughunter')
    : undefined;
}

function samePath(first, second) {
  if (typeof first !== 'string' || typeof second !== 'string') return false;
  return resolve(first) === resolve(second);
}

function setupValidateTool(beforeUses) {
  return beforeUses.find((tool) => {
    if (tool.name !== 'Bash') return false;
    const command = tool.input?.command;
    return typeof command === 'string'
      && /setup-cli\.mjs/.test(command)
      && /--action\s+validate/.test(command)
      && /--preset\s+web/.test(command);
  });
}

export async function inspectQwenActivation({ beforeTranscriptPath, afterTranscriptPath } = {}) {
  if (typeof beforeTranscriptPath !== 'string' || typeof afterTranscriptPath !== 'string') {
    throw new Error('TRANSCRIPT_EMPTY');
  }
  const beforeEvents = await readEvents([beforeTranscriptPath]);
  const afterEvents = await readEvents([afterTranscriptPath]);
  const beforeInit = findInit(beforeEvents, 'TRANSCRIPT_INIT_REQUIRED');
  const afterInit = findInit(afterEvents, 'ACTIVATION_RESTART_REQUIRED');

  if (typeof beforeInit.session_id !== 'string' || typeof afterInit.session_id !== 'string') {
    throw new Error('ACTIVATION_RESTART_REQUIRED');
  }
  if (beforeInit.session_id === afterInit.session_id) throw new Error('ACTIVATION_RESTART_REQUIRED');
  if (!samePath(beforeInit.cwd, afterInit.cwd)) throw new Error('ACTIVATION_CONTEXT_MISMATCH');

  const beforePlugin = bughunterPlugin(beforeInit);
  const afterPlugin = bughunterPlugin(afterInit);
  if (!samePath(beforePlugin?.path, afterPlugin?.path)) throw new Error('ACTIVATION_CONTEXT_MISMATCH');

  const beforeComponents = inspectQwenComponents(beforeInit);
  const afterComponents = inspectQwenComponents(afterInit);
  if (!beforeComponents.dormantOnly) throw new Error('ACTIVATION_DORMANT_REQUIRED');
  if (!afterComponents.mcpConnected) throw new Error('ACTIVATION_TOOLS_INCOMPLETE');
  if (afterComponents.toolCount !== 19
    || afterComponents.skillCount !== 7
    || afterComponents.agentCount !== 6) {
    throw new Error('ACTIVATION_TOOLS_INCOMPLETE');
  }

  const beforeUses = toolUses(beforeEvents);
  const afterUses = toolUses(afterEvents);
  if ([...beforeUses, ...afterUses].some((tool) => tool.name === 'mcp__bughunter__bh_start_run')) {
    throw new Error('ACTIVATION_TARGET_TOO_EARLY');
  }

  const validate = setupValidateTool(beforeUses);
  if (validate === undefined) throw new Error('ACTIVATION_SETUP_REQUIRED');
  const validateResult = toolResults(beforeEvents).get(validate.id);
  if (validateResult === undefined) throw new Error('ACTIVATION_SETUP_REQUIRED');
  if (validateResult.isError || parseJsonContent(validateResult.content)?.code !== 'SETUP_VALID') {
    throw new Error('ACTIVATION_SETUP_FAILED');
  }

  const afterInitIndex = afterEvents.indexOf(afterInit);
  const continuation = userTexts(afterEvents)
    .find((text) => text.index > afterInitIndex && /продолжай/i.test(text.text));
  if (continuation === undefined) throw new Error('ACTIVATION_CONTINUATION_INVALID');
  const inventory = afterUses
    .find((tool) => tool.index > continuation.index && tool.name === 'CodeMode');
  if (inventory === undefined) throw new Error('ACTIVATION_INVENTORY_REQUIRED');

  return {
    projectRoot: resolve(beforeInit.cwd),
    pluginRoot: resolve(afterPlugin.path),
    restartVerified: true,
    newSessionVerified: true,
    sameProjectVerified: true,
    setupValidated: true,
    continuationVerified: true,
    activeToolsVerified: true,
    toolCount: afterComponents.toolCount,
    skillCount: afterComponents.skillCount,
    agentCount: afterComponents.agentCount,
  };
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

export async function inspectQwenTranscript({ transcriptPaths, runId, gate, projectRoot }) {
  const events = await readEvents(transcriptPaths);
  const uses = toolUses(events);
  const results = toolResults(events);

  const restricted = uses.find((tool) => RESTRICTED_MAIN_TOOLS.has(tool.name));
  if (restricted !== undefined) throw new Error(`TRANSCRIPT_MAIN_RESTRICTED_TOOL: ${restricted.name}`);

  const startUses = uses.filter((tool) => tool.name === 'mcp__bughunter__bh_start_run');
  const resumeUses = uses.filter((tool) => tool.name === 'mcp__bughunter__bh_resume_run');
  let opening;

  if (gate === 'resume') {
    opening = resumeUses[0];
    if (opening === undefined) throw new Error('TRANSCRIPT_RESUME_REQUIRED');
  } else {
    opening = startUses[0];
    if (opening === undefined) throw new Error('TRANSCRIPT_START_REQUIRED');
  }

  requireRunId(results, opening, runId, 'TRANSCRIPT_START_RUN_MISMATCH');
  if (gate === 'node-target') {
    const init = projectInit(events, projectRoot, opening.index);
    const components = inspectQwenComponents(init);
    if (!components.mcpConnected || components.toolCount !== 16) {
      throw new Error('TRANSCRIPT_NODE_TOOLS_REQUIRED');
    }
  }

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
          if (block.input?.run_in_background === true) throw new Error('TRANSCRIPT_AGENT_BACKGROUND');
          if (EXPLORERS.has(block.input?.subagent_type)) {
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

  const result = {
    nativeForegroundAgents: true,
    singleExplorer: true,
    mainRestrictedTools: 0,
  };
  if (gate === 'node-target') {
    result.activeToolsVerified = true;
    result.preset = 'node';
    result.toolCount = 16;
  }
  return result;
}
