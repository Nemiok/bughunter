import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

const repoRoot = resolve(dirname(import.meta.dirname), '..');
const out = join(repoRoot, 'plugin', 'dist', 'kimi', 'bughunter');

test('kimi artifact has native manifest and no Qwen paths', async () => {
  const manifest = JSON.parse(await readFile(join(out, 'kimi.plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'bughunter');
  assert.equal(manifest.mcpServers.bughunter.args[0], '${KIMI_PLUGIN_ROOT}/server/mcp.mjs');
  assert.equal(manifest.skills.length, 7);
  assert.equal(manifest.agents.length, 6);
  assert.equal(existsSync(join(out, '.claude-plugin', 'plugin.json')), false);
  const entry = await readFile(join(out, 'skills', 'bughunter', 'SKILL.md'), 'utf8');
  assert.ok(entry.includes('.kimi-code/bughunter.json'));
  assert.ok(entry.includes('.kimi-code/bughunter/state/<preset>/'));
  assert.ok(entry.includes('/reload'));
  assert.ok(!entry.includes('.qwen/'));
});

test('kimi marketplace is version 2 and targets CLI and desktop', async () => {
  const catalog = JSON.parse(await readFile(join(repoRoot, 'plugin', 'dist', 'kimi-marketplace.json'), 'utf8'));
  assert.equal(catalog.version, '2');
  assert.deepEqual(catalog.plugins[0].clients, ['cli', 'desktop']);
  assert.equal(catalog.plugins[0].id, 'bughunter');
  assert.equal(catalog.plugins[0].source, join(repoRoot, 'plugin', 'dist', 'kimi', 'bughunter'));
});
