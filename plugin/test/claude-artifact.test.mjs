import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

const repoRoot = resolve(dirname(import.meta.dirname), '..');
const out = join(repoRoot, 'plugin', 'dist', 'claude', 'bughunter');

test('claude artifact uses native root, state and MCP tool names', async () => {
  const manifest = JSON.parse(await readFile(`${out}/.claude-plugin/plugin.json`, 'utf8'));
  assert.equal(manifest.name, 'bughunter');
  assert.equal(manifest.mcpServers.bughunter.args[0], '${CLAUDE_PLUGIN_ROOT}/server/mcp.mjs');
  const entry = await readFile(`${out}/skills/bughunter/SKILL.md`, 'utf8');
  assert.ok(entry.includes('.claude/bughunter.json'));
  assert.ok(entry.includes('/reload-plugins'));
  assert.ok(!entry.includes('.qwen/'));
  assert.ok(!entry.includes('.kimi-code/'));
  const explorer = await readFile(`${out}/agents/bh-explorer.md`, 'utf8');
  assert.ok(explorer.includes('mcp__plugin_bughunter_bughunter__bh_open'));
  assert.ok(!explorer.includes('mcp__bughunter__'));
  const reviewer = await readFile(`${out}/agents/bh-reviewer.md`, 'utf8');
  assert.ok(reviewer.includes('.claude/bughunter/state/web/runs/'));
  assert.ok(!reviewer.includes('mcp__bughunter__'));
});

test('claude artifact rewrites MCP tool names inside the YAML frontmatter, not only the body', async () => {
  const explorer = await readFile(`${out}/agents/bh-explorer.md`, 'utf8');
  const end = explorer.indexOf('\n---', 3);
  const frontmatter = explorer.slice(0, end);
  assert.ok(frontmatter.includes('- mcp__plugin_bughunter_bughunter__bh_open'));
  assert.ok(!frontmatter.includes('mcp__bughunter__'));
});
