import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { assertSinglePreset } from '@bughunter/core';

import { ensureCliConfig, loadCliConfig } from '../src/config.ts';
import { ownTemporaryDirectory } from './harness.ts';

test('ensureCliConfig creates a schema-valid template exactly once', async () => {
  const stateDir = await ownTemporaryDirectory('config-');
  try {
    const ensured = await ensureCliConfig(stateDir);
    assert.equal(ensured.createdPath, join(stateDir, 'config.json'));
    // При создании core возвращает только путь: `config` заполняется лишь при повторном вызове.
    assert.equal(ensured.config, undefined);
    const loaded = await loadCliConfig(stateDir);
    assert.equal(loaded.appEntry, 'src/cli.js');
    assert.equal(loaded.profile, 'cli-app');
    assert.ok(loaded.scenarios.length >= 4);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('a broken config is rejected with the field name, not patched silently', async () => {
  const stateDir = await ownTemporaryDirectory('config-broken-');
  try {
    await ensureCliConfig(stateDir);
    const path = join(stateDir, 'config.json');
    const original = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    await writeFile(path, JSON.stringify({ ...original, appEntry: 42 }), 'utf8');
    await assert.rejects(loadCliConfig(stateDir), /CONFIG_INVALID|appEntry/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('a missing config is reported as CONFIG_NOT_FOUND', async () => {
  const stateDir = await ownTemporaryDirectory('config-missing-');
  try {
    await assert.rejects(loadCliConfig(stateDir), /CONFIG_NOT_FOUND/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('one state directory refuses a second preset', async () => {
  const stateDir = await ownTemporaryDirectory('preset-conflict-');
  try {
    await assertSinglePreset(stateDir, 'cli');
    await assertSinglePreset(stateDir, 'cli');
    await assert.rejects(assertSinglePreset(stateDir, 'node'), /PRESET_CONFLICT/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
