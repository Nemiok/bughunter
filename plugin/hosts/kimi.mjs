import { defineHostDescriptor } from './descriptor.mjs';

export const kimiHost = defineHostDescriptor({
  id: 'kimi',
  pluginId: 'bughunter',
  outDir: 'dist/kimi/bughunter',
  pluginRoot: '${KIMI_PLUGIN_ROOT}',
  optInPath: '.kimi-code/bughunter.json',
  stateRoot: '.kimi-code/bughunter/state',
  mcpToolPrefix: 'mcp__plugin-bughunter_bughunter__',
  skillNamespace: 'bughunter:',
  agentNamespace: 'bughunter:',
  reloadInstruction: '/reload',
  refreshInstruction: '`/reload` (без него новая сессия продолжит видеть прежний набор инструментов)',
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
    // agents/ is auto-discovered by the Kimi runtime; declaring file paths
    // produces "path is not a directory" diagnostics (verified on 2.5.3).
    mcpServers: {
      bughunter: { command: 'node', args: ['./server/mcp.mjs'] },
    },
    // Records the session workspace under KIMI_CODE_HOME so the MCP server
    // (sandboxed to the plugin root) can resolve the project. See hooks/.
    hooks: [
      { event: 'SessionStart', command: 'node ./hooks/session-start.mjs' },
    ],
    interface: {
      displayName: 'Bughunter',
      shortDescription: 'Evidence-based bug hunting with red regression tests.',
    },
  };
}
