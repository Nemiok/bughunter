import assert from 'node:assert/strict';
import { test } from 'node:test';

import { probeClientCommands, selectInstallCandidate, validateRuntimeCapabilities } from '../capabilities.mjs';

const commit = 'a'.repeat(40);
const validQwen = {
  host: 'qwen', channel: 'extensions', status: 'passed', sourceCommit: commit,
  clientVersion: '0.28.0', manifest: 'qwen-extension.json',
  components: { mcp: true, skills: true, agents: true },
  extensionRootExpression: '${extensionPath}', workspaceExpression: '${workspacePath}',
  mcpToolPrefix: 'mcp__bughunter__', skillNamespace: 'bughunter:', agentNamespace: 'bughunter:',
  reloadInstruction: '/reload-plugins', refreshInstruction: '`/reload-plugins`',
  entryInvocation: '/bughunter:bughunter',
  tools: {
    Read: 'read_file', Write: 'write_file', Edit: 'edit', Bash: 'run_shell_command',
    Agent: 'task', Skill: 'skill', Grep: 'grep_search', Glob: 'glob',
  },
};

test('qwen version does not veto a plugins-capable client', () => {
  assert.deepEqual(
    selectInstallCandidate({ family: 'qwen', binary: 'qwen', commands: { plugins: true, extensions: false } }),
    { family: 'qwen', binary: 'qwen', channel: 'plugins', artifact: 'qwen' },
  );
  assert.deepEqual(
    selectInstallCandidate({ family: 'qwen', binary: 'qwen-next', commands: { plugins: true, extensions: true } }),
    { family: 'qwen', binary: 'qwen-next', channel: 'plugins', artifact: 'qwen' },
  );
});

test('gigacode selects extensions, while unknown clients fail closed', () => {
  assert.deepEqual(
    selectInstallCandidate({ family: 'gigacode', binary: 'gigacode', commands: { plugins: false, extensions: true } }),
    { family: 'gigacode', binary: 'gigacode', channel: 'extensions', artifact: 'gigacode' },
  );
  assert.throws(
    () => selectInstallCandidate({ family: 'unknown', binary: 'fork', commands: { plugins: true } }),
    /CLIENT_CAPABILITY_MISSING: supported client family/,
  );
});

test('runtime report rejects Agent Plugins and missing full components', () => {
  assert.throws(
    () => validateRuntimeCapabilities({ ...validQwen, manifest: 'plugin.json' }, 'qwen'),
    /CLIENT_CAPABILITY_MISSING: native extension manifest/,
  );
  assert.throws(
    () => validateRuntimeCapabilities({
      ...validQwen, components: { mcp: true, skills: true, agents: false },
    }, 'qwen'),
    /CLIENT_CAPABILITY_MISSING: agents/,
  );
  assert.throws(
    () => validateRuntimeCapabilities({ ...validQwen, workspaceExpression: undefined }, 'qwen'),
    /CLIENT_CAPABILITY_MISSING: workspace project cannot be resolved/,
  );
});

test('valid runtime report is returned without losing observed names', () => {
  const result = validateRuntimeCapabilities(validQwen, 'qwen');
  assert.equal(result.tools.Read, 'read_file');
  assert.equal(result.mcpToolPrefix, 'mcp__bughunter__');
});

test('probe passes a bounded timeout and survives ETIMEDOUT', () => {
  const calls = [];
  const timedOut = () => ({ status: null, stdout: '', stderr: '', error: { code: 'ETIMEDOUT' } });
  const result = probeClientCommands({
    binary: 'qwen', family: 'qwen',
    run: (command, args, options) => {
      calls.push({ command, args, options });
      return timedOut();
    },
  });
  assert.deepEqual(result.commands, { plugins: false, extensions: false });
  assert.equal(result.clientVersion, 'unknown');
  assert.equal(calls.length, 3);
  assert.equal(calls[0].options.timeout, 10_000);
  assert.equal(calls[0].options.shell, false);
});

test('probe survives a throwing runner', () => {
  const result = probeClientCommands({
    binary: 'qwen', family: 'qwen',
    run: () => { throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); },
  });
  assert.deepEqual(result.commands, { plugins: false, extensions: false });
  assert.equal(result.clientVersion, 'unknown');
});
