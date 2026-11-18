import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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

test('validate accepts web config and does not create runs or auth', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'bh-setup-cli-web-valid-'));
  const created = await runSetupCli(args('create', projectRoot), {
    host: qwenHost, serverRoot, preflight: noMissing, log: silent,
  });
  const before = await readFile(created.configPath, 'utf8');
  const result = await runSetupCli(args('validate', projectRoot), {
    host: qwenHost, serverRoot, preflight: noMissing, log: silent,
  });
  assert.equal(result.code, 'SETUP_VALID');
  assert.equal(await readFile(created.configPath, 'utf8'), before);
  assert.equal(existsSync(join(created.configPath, '..', 'runs')), false);
  assert.equal(existsSync(join(created.configPath, '..', 'auth')), false);
});

test('validate rejects invalid config without repairing it', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'bh-setup-cli-invalid-'));
  const created = await runSetupCli(args('create', projectRoot), {
    host: qwenHost, serverRoot, preflight: noMissing, log: silent,
  });
  await writeFile(created.configPath, '{"baseUrl":12}\n');
  await assert.rejects(
    runSetupCli(args('validate', projectRoot), {
      host: qwenHost, serverRoot, preflight: noMissing, log: silent,
    }),
    /CONFIG_INVALID/,
  );
  assert.equal(await readFile(created.configPath, 'utf8'), '{"baseUrl":12}\n');
});

test('node validate loads the selected profile', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'bh-setup-cli-node-valid-'));
  const created = await runSetupCli(args('create', projectRoot, 'node'), {
    host: qwenHost, serverRoot, preflight: noMissing, log: silent,
  });
  await assert.rejects(
    runSetupCli(args('validate', projectRoot, 'node'), {
      host: qwenHost, serverRoot, preflight: noMissing, log: silent,
    }),
    /PROFILE_NOT_FOUND: node-api-app/,
  );
  const profileDir = join(projectRoot, '.qwen', 'bughunter', 'state', 'node', 'profiles', 'node-api-app');
  await mkdir(profileDir, { recursive: true });
  await writeFile(join(profileDir, 'index.ts'), `export default {
    endpoints: [{ template: '/health', method: 'GET', samplePath: '/health' }],
  };\n`);
  const result = await runSetupCli(args('validate', projectRoot, 'node'), {
    host: qwenHost, serverRoot, preflight: noMissing, log: silent,
  });
  assert.equal(result.profile, 'node-api-app');
});
