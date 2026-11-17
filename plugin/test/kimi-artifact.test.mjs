import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

import { kimiHost } from '../hosts/kimi.mjs';

const repoRoot = resolve(dirname(import.meta.dirname), '..');
const out = join(repoRoot, 'plugin', 'dist', 'kimi', 'bughunter');

test('kimi artifact has native manifest and no Qwen paths', async () => {
  const manifest = JSON.parse(await readFile(join(out, 'kimi.plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'bughunter');
  // Runtime-verified on Kimi 2.5.3: args are not variable-expanded, the MCP
  // server runs with cwd = plugin root, so the script path must be relative.
  assert.equal(manifest.mcpServers.bughunter.args[0], './server/mcp.mjs');
  assert.equal(manifest.skills.length, 7);
  // agents/ is auto-discovered; declaring agent files is a diagnostic.
  assert.equal(manifest.agents, undefined);
  assert.equal((await readdir(join(out, 'agents'))).filter((file) => file.endsWith('.md')).length, 6);
  // SessionStart hook bridges the workspace cwd into the sandboxed MCP server.
  assert.deepEqual(manifest.hooks, [{ event: 'SessionStart', command: 'node ./hooks/session-start.mjs' }]);
  assert.ok(existsSync(join(out, 'hooks', 'session-start.mjs')));
  assert.equal(existsSync(join(out, '.claude-plugin', 'plugin.json')), false);
  const entry = await readFile(join(out, 'skills', 'bughunter', 'SKILL.md'), 'utf8');
  assert.ok(entry.includes('.kimi-code/bughunter.json'));
  assert.ok(entry.includes('.kimi-code/bughunter/state/<preset>/'));
  assert.ok(entry.includes('/reload'));
  assert.ok(!entry.includes('.qwen/'));
});

test('kimi marketplace is version 2 and consumes the host descriptor', async () => {
  const catalog = JSON.parse(await readFile(join(repoRoot, 'plugin', 'dist', 'kimi-marketplace.json'), 'utf8'));
  assert.equal(catalog.version, '2');
  assert.deepEqual(catalog.plugins[0].clients, kimiHost.clients);
  assert.equal(catalog.plugins[0].id, 'bughunter');
  assert.equal(catalog.plugins[0].source, join(repoRoot, 'plugin', 'dist', 'kimi', 'bughunter'));
  // The README shipped in the artifact must carry the rendered entry invocation.
  const readme = await readFile(join(out, 'README.md'), 'utf8');
  assert.ok(readme.includes(kimiHost.entryInvocation));
  assert.ok(!readme.includes('<entryInvocation>'));
});

test('kimi artifact renders the runtime MCP prefix into entry, agents and setup prompt', async () => {
  const entry = await readFile(join(out, 'skills', 'bughunter', 'SKILL.md'), 'utf8');
  const explorer = await readFile(join(out, 'agents', 'bh-explorer.md'), 'utf8');
  assert.ok(entry.includes('mcp__plugin-bughunter_bughunter__bh_setup'), 'rendered entry must name the setup tool with the verified prefix');
  for (const text of [entry, explorer]) {
    assert.ok(text.includes('mcp__plugin-bughunter_bughunter__'), 'rendered text must carry the verified prefix');
    assert.ok(!text.includes('mcp__bughunter__'), 'the Qwen prefix must not leak into the Kimi artifact');
  }
  // The setup prompt must demand a real refresh for Kimi, not "open a new session".
  assert.ok(entry.includes('/reload'));
  assert.ok(!/открой новую сессию/.test(entry));
});
