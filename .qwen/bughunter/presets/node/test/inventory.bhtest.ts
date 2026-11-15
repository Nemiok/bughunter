import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { assertSinglePreset, writeJsonAtomic } from '@bughunter/core';

import { nodeConfigTemplate } from '../src/config.ts';
import { nodeInventory } from '../src/inventory.ts';
import { nodeProfile } from '../src/profile.ts';
import type { NodeProfile } from '../src/profile.ts';

const temporaryDirectories: string[] = [];

after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

const endpoints = [
  { method: 'GET', template: '/health', samplePath: '/health' },
  { method: 'GET', template: '/orders', samplePath: '/orders' },
  { method: 'POST', template: '/orders', samplePath: '/orders' },
  { method: 'GET', template: '/orders/:id', samplePath: '/orders/ord-1' },
  { method: 'POST', template: '/payments', samplePath: '/payments' },
];

/** Каталог состояния с конфигом и профилем: профиль — обычный TS-модуль с default-экспортом. */
async function stateWithProfile(extra: Partial<NodeProfile> = {}): Promise<string> {
  const stateDir = await mkdtemp(join(tmpdir(), 'bh-node-inventory-'));
  temporaryDirectories.push(stateDir);
  await writeJsonAtomic(join(stateDir, 'config.json'), { ...nodeConfigTemplate(), profile: 'test-api' });
  await mkdir(join(stateDir, 'profiles', 'test-api'), { recursive: true });
  await writeFile(
    join(stateDir, 'profiles', 'test-api', 'index.ts'),
    `export default ${JSON.stringify({ endpoints, ...extra }, null, 2)};\n`,
    'utf8',
  );
  return stateDir;
}

test('inventory lists endpoint templates from the profile', async () => {
  const stateDir = await stateWithProfile();
  assert.deepEqual(await nodeInventory.list(stateDir), [
    'GET /health', 'GET /orders', 'POST /orders', 'GET /orders/:id', 'POST /payments',
  ]);
});

test('templateOf reduces a concrete id to the template', async () => {
  const stateDir = await stateWithProfile();
  assert.equal(nodeInventory.templateOf('/orders/7f3ab4c9'), '/orders/:id');
  assert.equal(nodeInventory.templateOf('/orders/12'), '/orders/:id');
  assert.equal(nodeInventory.templateOf('GET /orders/7f3ab4c9'), 'GET /orders/:id');
  assert.equal(nodeInventory.templateOf('/health'), '/health');
  assert.equal(nodeInventory.templateOf('/orders/new'), '/orders/new');
  assert.equal(nodeInventory.templateOf('/unknown/path'), '/unknown/path');
  assert.equal(nodeInventory.templateOf('http://127.0.0.1:3000/orders/12'), '/orders/:id');
  assert.ok(stateDir.startsWith('/'), stateDir);
});

test('profile loads endpoints and refuses test data outside its directory', async () => {
  const stateDir = await stateWithProfile({ testDataDir: join(tmpdir(), 'bh-node-test-data') });
  const profile = await nodeProfile.load(stateDir, 'test-api') as NodeProfile;
  assert.equal(profile.endpoints.length, 5);
  assert.equal(
    nodeProfile.testDataFile(profile, 'orders.json'),
    join(profile.testDataDir as string, 'orders.json'),
  );
  assert.throws(() => nodeProfile.testDataFile(profile, '../secret.json'), /TEST_DATA_PATH_UNSAFE/);
  assert.throws(() => nodeProfile.testDataFile(null, 'orders.json'), /TEST_DATA_PATH_UNSAFE/);
  await assert.rejects(() => nodeProfile.load(stateDir, 'нет-такого'), /PROFILE_NOT_FOUND/);
});

test('the node preset refuses a state dir owned by another preset', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'bh-node-preset-'));
  temporaryDirectories.push(stateDir);
  await writeJsonAtomic(join(stateDir, 'preset.json'), { name: 'web' });
  await assert.rejects(assertSinglePreset(stateDir, 'node'), (error) => {
    assert.equal(String(error), `Error: PRESET_CONFLICT: ${stateDir}`);
    return true;
  });
});
