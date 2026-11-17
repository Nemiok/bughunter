import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

const pluginRoot = join(import.meta.dirname, '..');
const repoRoot = join(pluginRoot, '..');

test('launcher and preset runtime contain no hard-coded host directory', async () => {
  const launcher = await readFile(join(pluginRoot, 'launcher.mjs'), 'utf8');
  assert.ok(!launcher.includes("'.qwen'"));
  for (const preset of ['web', 'node']) {
    const entry = await readFile(join(repoRoot, '.qwen', 'bughunter', 'presets', preset, 'src', 'index.ts'), 'utf8');
    assert.ok(!entry.includes('cli-host.ts'));
    assert.ok(!entry.includes('cd .qwen/'));
  }
});
