import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { qwenHost } from '../hosts/qwen.mjs';
import { runSetupCli } from '../setup-cli-core.mjs';

const serverRoot = resolve(import.meta.dirname, '../../.qwen/bughunter');
const noMissing = async () => [];
const silent = () => {};

function args(action, projectRoot, preset = 'web') {
  return ['--action', action, '--project-root', projectRoot, '--preset', preset];
}

test('create prints CONFIG_CREATED and preserves an existing config on repeat', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'bh-setup-cli-create-'));
  const first = await runSetupCli(args('create', projectRoot), {
    host: qwenHost, serverRoot, preflight: noMissing, log: silent,
  });
  assert.equal(first.code, 'CONFIG_CREATED');
  assert.equal(JSON.parse(await readFile(first.configPath, 'utf8')).baseUrl, 'https://dev-stand.example.local');
  await writeFile(first.configPath, '{"sentinel":true}\n');
  const second = await runSetupCli(args('create', projectRoot), {
    host: qwenHost, serverRoot, preflight: noMissing, log: silent,
  });
  assert.equal(second.code, 'SETUP_READY');
  assert.equal(await readFile(first.configPath, 'utf8'), '{"sentinel":true}\n');
});

test('print returns paths without creating project state', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'bh-setup-cli-print-'));
  const result = await runSetupCli(args('print', projectRoot, 'node'), {
    host: qwenHost, serverRoot, preflight: noMissing, log: silent,
  });
  assert.equal(result.code, 'SETUP_PATHS');
  assert.equal(result.optInPath, join(projectRoot, '.qwen', 'bughunter.json'));
  assert.equal(result.configPath, join(projectRoot, '.qwen', 'bughunter', 'state', 'node', 'config.json'));
  assert.equal(existsSync(join(projectRoot, '.qwen')), false);
});

test('CLI rejects unknown actions and relative project roots', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'bh-setup-cli-args-'));
  await assert.rejects(
    runSetupCli(['--action', 'unknown', '--project-root', projectRoot, '--preset', 'web'], {
      host: qwenHost, serverRoot, preflight: noMissing, log: silent,
    }),
    /SETUP_ACTION_INVALID/,
  );
  await assert.rejects(
    runSetupCli(['--action', 'print', '--project-root', 'relative', '--preset', 'web'], {
      host: qwenHost, serverRoot, preflight: noMissing, log: silent,
    }),
    /SETUP_PROJECT_ABSOLUTE_REQUIRED/,
  );
});
