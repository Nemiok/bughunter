import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { writeJsonAtomic } from '@bughunter/core';

import { ensureNodeConfig, loadNodeConfig, nodeConfigTemplate } from '../src/config.ts';

const temporaryDirectories: string[] = [];

after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeConfig(root: string, config: unknown): Promise<string> {
  const file = join(root, 'config.json');
  await writeJsonAtomic(file, config);
  return file;
}

test('missing config creates the template without starting a run', async () => {
  const root = await temporaryDirectory('bh-node-config-');
  const result = await ensureNodeConfig(root);
  assert.equal(result.config, undefined);
  assert.equal(result.createdPath, join(root, 'config.json'));

  const config = await loadNodeConfig(root);
  assert.deepEqual(config, nodeConfigTemplate());
  assert.deepEqual(config.allowedHosts, ['127.0.0.1', 'localhost']);
  assert.deepEqual(config.reset, { method: 'POST', path: '/__reset' });
  assert.equal(config.profile, 'node-api-app');
  assert.ok(config.detectors.anomalyTexts.includes('ECONNREFUSED'));
  assert.ok(!(await readdir(root)).includes('runs'), 'создание конфига не должно начинать прогон');

  // Четыре сценария на каждый из пяти эндпоинтов: sweep идёт по инвентарю × сценарии.
  const byName = new Map<string, number>();
  for (const scenario of config.scenarios) {
    byName.set(scenario.name, (byName.get(scenario.name) ?? 0) + 1);
  }
  assert.deepEqual([...byName.entries()].sort(), [
    ['boundary', 5], ['empty', 5], ['invalid', 5], ['valid', 5],
  ]);
});

test('config with an unknown field is rejected naming the field', async () => {
  const root = await temporaryDirectory('bh-node-config-');
  const file = await writeConfig(root, { ...nodeConfigTemplate(), unexpected: true });
  await assert.rejects(loadNodeConfig(root), (error) => {
    assert.ok(String(error).includes(`CONFIG_INVALID: ${file}:`));
    assert.match(String(error), /unexpected|Unrecognized key/);
    return true;
  });
});

test('targetMap value without a leading slash is rejected naming the field', async () => {
  const root = await temporaryDirectory('bh-node-config-');
  const file = await writeConfig(root, { ...nodeConfigTemplate(), targetMap: { 'src/**': ['orders'] } });
  await assert.rejects(loadNodeConfig(root), (error) => {
    assert.ok(String(error).includes(`CONFIG_INVALID: ${file}:`));
    assert.match(String(error), /targetMap/);
    return true;
  });

  // Цель node-пресета — «МЕТОД /путь»: метод без пути так же бесполезен, как путь без метода.
  await writeConfig(root, { ...nodeConfigTemplate(), targetMap: { 'src/**': ['GET orders'] } });
  await assert.rejects(loadNodeConfig(root), /targetMap/);
});

test('allowedHosts must not be empty', async () => {
  const root = await temporaryDirectory('bh-node-config-');
  const file = await writeConfig(root, { ...nodeConfigTemplate(), allowedHosts: [] });
  await assert.rejects(loadNodeConfig(root), (error) => {
    assert.ok(String(error).includes(`CONFIG_INVALID: ${file}:`));
    assert.match(String(error), /allowedHosts/);
    return true;
  });
});

test('profile is required because the inventory comes from it', async () => {
  const root = await temporaryDirectory('bh-node-config-');
  const { profile: _profile, ...withoutProfile } = nodeConfigTemplate();
  await writeConfig(root, withoutProfile);
  await assert.rejects(loadNodeConfig(root), /CONFIG_INVALID.*profile/s);
});
