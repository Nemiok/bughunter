import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

// npm test runs from plugin/, the brief command from the repo root: anchor the
// artifact path to the repo root so both invocations read the same files.
const out = join(resolve(import.meta.dirname, '..', '..'), 'plugin/dist/qwen/bughunter-mcp');

test('Agent Plugins v1 MCP-only artifact has only portable fields', async () => {
  const manifest = JSON.parse(await readFile(`${out}/plugin.json`, 'utf8'));
  assert.deepEqual(Object.keys(manifest).sort(), ['$schema', 'description', 'name', 'version'].sort());
  assert.equal(manifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.equal(manifest.name, 'bughunter-mcp');
  const mcp = JSON.parse(await readFile(`${out}/mcp.json`, 'utf8'));
  assert.deepEqual(mcp.mcpServers.bughunter, {
    type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/server/mcp.mjs'],
  });
  assert.equal(existsSync(`${out}/agents`), false);
  assert.equal(existsSync(`${out}/.claude-plugin`), false);
  assert.equal(existsSync(`${out}/skills/bughunter`), false);
  const readme = await readFile(`${out}/README.md`, 'utf8');
  assert.ok(readme.includes('MCP-only; full workflow not certified'));
  assert.ok(readme.includes('BUGHUNTER_PROJECT_UNKNOWN'), 'README must stop on BUGHUNTER_PROJECT_UNKNOWN');
  const skill = await readFile(`${out}/skills/bughunter-setup/SKILL.md`, 'utf8');
  assert.ok(skill.includes('BUGHUNTER_PROJECT_UNKNOWN'), 'setup skill must stop on BUGHUNTER_PROJECT_UNKNOWN');
  assert.ok(skill.includes('не сертифицирована'), 'skill must not certify host project setup');
});
