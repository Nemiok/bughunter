import { defineHostDescriptor } from './descriptor.mjs';

export const kimiHost = defineHostDescriptor({
  id: 'kimi',
  pluginId: 'bughunter',
  outDir: 'dist/kimi/bughunter',
  pluginRoot: '${KIMI_PLUGIN_ROOT}',
  optInPath: '.kimi-code/bughunter.json',
  stateRoot: '.kimi-code/bughunter/state',
  mcpToolPrefix: 'mcp__bughunter__',
  skillNamespace: 'bughunter:',
  agentNamespace: 'bughunter:',
  reloadInstruction: '/reload',
  entryInvocation: '/skill:bughunter:bughunter',
  clients: ['cli', 'desktop'],
});

export const host = kimiHost;

export function kimiManifest(version) {
  return {
    name: 'bughunter',
    version,
    description: 'Доказательный поиск багов с воспроизведением и красными регрессионными тестами.',
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
      bughunter: { command: 'node', args: ['${KIMI_PLUGIN_ROOT}/server/mcp.mjs'] },
    },
    interface: {
      displayName: 'Bughunter',
      shortDescription: 'Evidence-based bug hunting with red regression tests.',
    },
  };
}
