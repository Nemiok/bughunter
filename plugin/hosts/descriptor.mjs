import { isAbsolute, join } from 'node:path';

const fields = [
  'id', 'pluginId', 'outDir', 'pluginRoot', 'optInPath', 'stateRoot',
  'mcpToolPrefix', 'skillNamespace', 'agentNamespace', 'reloadInstruction',
  'refreshInstruction',
];

export function defineHostDescriptor(value) {
  for (const field of fields) {
    if (typeof value?.[field] !== 'string' || value[field].length === 0) {
      throw new Error(`HOST_DESCRIPTOR_INVALID: ${field}`);
    }
  }
  for (const field of ['optInPath', 'stateRoot']) {
    const parts = value[field].split(/[\\/]/);
    if (isAbsolute(value[field]) || parts.includes('..')) {
      throw new Error(`HOST_DESCRIPTOR_INVALID: ${field}`);
    }
  }
  if (!/^mcp__[a-z0-9_-]+__$/.test(value.mcpToolPrefix)) {
    throw new Error('HOST_DESCRIPTOR_INVALID: mcpToolPrefix');
  }
  if (value.entryInvocation !== undefined
    && (typeof value.entryInvocation !== 'string' || value.entryInvocation.length === 0)) {
    throw new Error('HOST_DESCRIPTOR_INVALID: entryInvocation');
  }
  if (value.clients !== undefined
    && (!Array.isArray(value.clients) || value.clients.some((client) => typeof client !== 'string' || client.length === 0))) {
    throw new Error('HOST_DESCRIPTOR_INVALID: clients');
  }
  return Object.freeze({ ...value });
}

export function hostPaths(host, projectRoot, preset) {
  if (!['web', 'node'].includes(preset)) throw new Error(`BUGHUNTER_PRESET_INVALID: ${preset}`);
  const stateDir = join(projectRoot, host.stateRoot, preset);
  return {
    optIn: join(projectRoot, host.optInPath),
    stateDir,
    configPath: join(stateDir, 'config.json'),
  };
}

export function mcpToolName(host, tool) {
  if (!/^bh_[a-z_]+$/.test(tool)) throw new Error(`MCP_TOOL_INVALID: ${tool}`);
  return `${host.mcpToolPrefix}${tool}`;
}
