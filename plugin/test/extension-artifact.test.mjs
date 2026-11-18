import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { extensionHostFromCapabilities, extensionManifest } from '../hosts/extension.mjs';
import { hostPaths } from '../hosts/descriptor.mjs';

const tools = {
  Read: 'read_file', Write: 'write_file', Edit: 'edit', Bash: 'run_shell_command',
  Agent: 'task', Skill: 'skill', Grep: 'grep_search', Glob: 'glob',
};

function report(host) {
  return {
    host, channel: 'extensions', status: 'passed', sourceCommit: 'a'.repeat(40),
    clientVersion: 'fixture', manifest: host === 'qwen' ? 'qwen-extension.json' : 'gigacode-extension.json',
    components: { mcp: true, skills: true, agents: true },
    extensionRootExpression: '${extensionPath}', workspaceExpression: '${workspacePath}',
    mcpToolPrefix: 'mcp__bughunter__', skillNamespace: 'bughunter:', agentNamespace: 'bughunter:',
    reloadInstruction: '/reload-plugins', refreshInstruction: '`/reload-plugins`',
    entryInvocation: '/bughunter:bughunter', tools,
  };
}

test('gigacode descriptor keeps state separate and uses observed tools', () => {
  const host = extensionHostFromCapabilities(report('gigacode'));
  assert.equal(host.id, 'gigacode');
  assert.equal(host.manifestName, 'gigacode-extension.json');
  assert.equal(host.toolNames.Read, 'read_file');
  assert.equal(hostPaths(host, '/tmp/project', 'web').optIn, join('/tmp/project', '.gigacode', 'bughunter.json'));
  assert.equal(hostPaths(host, '/tmp/project', 'web').stateDir, join('/tmp/project', '.gigacode', 'bughunter', 'state', 'web'));
});

test('native extension manifest uses extension root and workspace expressions', () => {
  const host = extensionHostFromCapabilities(report('qwen'));
  const manifest = extensionManifest({ ...host, version: '0.2.0' });
  assert.equal(manifest.version, '0.2.0');
  assert.deepEqual(manifest.mcpServers.bughunter, {
    command: 'node',
    args: ['${extensionPath}${/}server${/}mcp.mjs'],
    cwd: '${workspacePath}',
  });
  assert.equal(manifest.agents, 'agents');
  assert.equal(manifest.skills, 'skills');
});
