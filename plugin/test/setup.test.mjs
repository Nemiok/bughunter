import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { qwenHost } from '../hosts/qwen.mjs';
import { setupProject } from '../setup.mjs';
import { checkPrerequisites } from '../preflight.mjs';

const serverRoot = resolve(import.meta.dirname, '../../.qwen/bughunter');
const noMissing = async () => [];

test('setup creates only selected host state and preserves it on repeat', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'bh-setup-'));
  const first = await setupProject({ host: qwenHost, projectRoot, preset: 'web', serverRoot, preflight: noMissing });
  assert.equal(first.code, 'CONFIG_CREATED');
  const config = JSON.parse(await readFile(first.configPath, 'utf8'));
  assert.equal(config.baseUrl, 'https://dev-stand.example.local');
  assert.ok(!existsSync(join(projectRoot, '.kimi-code')));
  assert.ok(!existsSync(join(projectRoot, '.claude')));
  await writeFile(first.configPath, '{"sentinel":true}\n');
  const second = await setupProject({ host: qwenHost, projectRoot, preset: 'web', serverRoot, preflight: noMissing });
  assert.equal(second.code, 'SETUP_READY');
  assert.equal(await readFile(first.configPath, 'utf8'), '{"sentinel":true}\n');
});

test('setup rejects preset conflict without touching existing files', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'bh-setup-conflict-'));
  const first = await setupProject({ host: qwenHost, projectRoot, preset: 'web', serverRoot, preflight: noMissing });
  await assert.rejects(
    setupProject({ host: qwenHost, projectRoot, preset: 'node', serverRoot, preflight: noMissing }),
    /SETUP_PRESET_CONFLICT/,
  );
  assert.equal(JSON.parse(await readFile(first.configPath, 'utf8')).baseUrl, 'https://dev-stand.example.local');
});

test('setup stops before writes when prerequisites are missing', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'bh-setup-prereq-'));
  await assert.rejects(
    setupProject({
      host: qwenHost, projectRoot, preset: 'web', serverRoot,
      preflight: async () => ['Google Chrome'],
    }),
    /PREREQUISITES_MISSING: Google Chrome/,
  );
  assert.equal(existsSync(join(projectRoot, '.qwen')), false);
});

test('preflight reports outdated Node, missing Git and Chrome in order', async () => {
  const missing = await checkPrerequisites('web', {
    run: () => ({ status: 1 }),
    exists: () => false,
    env: {},
    platform: 'darwin',
    nodeVersion: '22.17.0',
  });
  assert.deepEqual(missing, ['Node.js >=22.18', 'Git', 'Google Chrome']);
});
