import { validateRuntimeCapabilities } from '../capabilities.mjs';
import { defineHostDescriptor } from './descriptor.mjs';

export function extensionHostFromCapabilities(value) {
  const report = validateRuntimeCapabilities(value, value?.host);
  const qwen = report.host === 'qwen';
  return defineHostDescriptor({
    id: qwen ? 'qwen-extension' : 'gigacode',
    pluginId: 'bughunter',
    outDir: qwen ? 'dist/qwen-extension/bughunter' : 'dist/gigacode/bughunter',
    pluginRoot: report.extensionRootExpression,
    optInPath: qwen ? '.qwen/bughunter.json' : '.gigacode/bughunter.json',
    stateRoot: qwen ? '.qwen/bughunter/state' : '.gigacode/bughunter/state',
    mcpToolPrefix: report.mcpToolPrefix,
    skillNamespace: report.skillNamespace,
    agentNamespace: report.agentNamespace,
    reloadInstruction: report.reloadInstruction,
    refreshInstruction: report.refreshInstruction,
    entryInvocation: report.entryInvocation,
    clients: ['cli'],
    channel: 'extensions',
    manifestName: report.manifest,
    workspaceExpression: report.workspaceExpression,
    toolNames: report.tools,
    setupMode: 'cli',
    runtimeSourceCommit: report.sourceCommit,
  });
}

export function extensionManifest(host) {
  return {
    name: 'bughunter',
    version: host.version,
    description: 'Evidence-based bug hunting with reproduction and red regression tests.',
    skills: 'skills',
    agents: 'agents',
    mcpServers: {
      bughunter: {
        command: 'node',
        args: [`${host.pluginRoot}\${/}server\${/}mcp.mjs`],
        cwd: host.workspaceExpression,
      },
    },
  };
}
