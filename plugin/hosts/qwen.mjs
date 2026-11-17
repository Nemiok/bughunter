import { defineHostDescriptor } from './descriptor.mjs';

export const qwenHost = defineHostDescriptor({
  id: 'qwen',
  pluginId: 'bughunter',
  outDir: 'dist/bughunter',
  pluginRoot: '${CLAUDE_PLUGIN_ROOT}',
  optInPath: '.qwen/bughunter.json',
  stateRoot: '.qwen/bughunter/state',
  mcpToolPrefix: 'mcp__bughunter__',
  skillNamespace: 'bughunter:',
  agentNamespace: 'bughunter:',
  reloadInstruction: '/plugins reload',
  entryInvocation: '/bughunter:bughunter',
  clients: ['cli'],
});

export const host = qwenHost;
