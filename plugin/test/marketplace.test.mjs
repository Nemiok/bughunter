import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildQwenMarketplace } from '../marketplace.mjs';

test('qwen marketplace contains a self-contained relative plugin source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bh-qwen-market-'));
  const pluginDir = join(root, 'plugin');
  const marketplaceRoot = join(root, 'marketplace');
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(join(pluginDir, '.claude-plugin'), { recursive: true });
  await writeFile(join(pluginDir, '.claude-plugin', 'plugin.json'), '{"name":"bughunter","version":"0.1.0"}\n');
  await buildQwenMarketplace({ pluginDir, marketplaceRoot, version: '0.1.0' });
  const catalog = JSON.parse(await readFile(join(marketplaceRoot, '.claude-plugin', 'marketplace.json'), 'utf8'));
  assert.equal(catalog.name, 'bughunter-market');
  assert.deepEqual(catalog.plugins[0].source, './plugins/bughunter');
  assert.equal(catalog.plugins[0].version, '0.1.0');
  assert.equal(existsSync(join(marketplaceRoot, 'plugins', 'bughunter', '.claude-plugin', 'plugin.json')), true);
});
