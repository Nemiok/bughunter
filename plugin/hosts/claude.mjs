import { defineHostDescriptor } from './descriptor.mjs';

export const claudeHost = defineHostDescriptor({
  id: 'claude',
  pluginId: 'bughunter',
  outDir: 'dist/claude/bughunter',
  pluginRoot: '${CLAUDE_PLUGIN_ROOT}',
  optInPath: '.claude/bughunter.json',
  stateRoot: '.claude/bughunter/state',
  mcpToolPrefix: 'mcp__plugin_bughunter_bughunter__',
  skillNamespace: 'bughunter:',
  agentNamespace: 'bughunter:',
  reloadInstruction: '/reload-plugins',
  refreshInstruction: '`/reload-plugins`',
  entryInvocation: '/bughunter:bughunter',
  clients: ['cli', 'desktop'],
});

export const host = claudeHost;

export function claudeManifest(version) {
  return {
    name: 'bughunter',
    displayName: 'Bughunter',
    version,
    description: 'Evidence-based bug hunting with reproduction and red regression tests.',
    author: { name: 'Bughunter' },
    skills: [
      './skills/bughunter', './skills/bughunter-oracles', './skills/bughunter-red-test',
      './skills/bughunter-preset-card-web', './skills/bughunter-preset-card-node',
      './skills/bughunter-preset-guide', './skills/bughunter-core-contract',
    ],
    agents: [
      './agents/bh-explorer.md', './agents/bh-reviewer.md', './agents/bh-test-writer.md',
      './agents/bh-explorer-node.md', './agents/bh-reviewer-node.md', './agents/bh-test-writer-node.md',
    ],
    mcpServers: {
      bughunter: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server/mcp.mjs'] },
    },
  };
}
