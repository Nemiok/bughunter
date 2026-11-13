import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { commonConfigSchema, loadConfig } from '../src/config.ts';
import { createRun, readRun, writeJsonAtomic } from '../src/run-store.ts';
import type { Config } from '../src/types.ts';

const config = { targetMap: {}, baseBranch: 'main' } as unknown as Config;

async function withStateDir(run: (stateDir: string) => Promise<void>): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), 'bh-core-config-'));
  try {
    await run(stateDir);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

test('config with a legacy field name is rejected naming the field', () => withStateDir(async (stateDir) => {
  const file = join(stateDir, 'config.json');
  await writeJsonAtomic(file, {
    baseBranch: 'main',
    targetMap: {},
    limits: { stepsPerSession: 60, candidatesPerRun: 20 },
    safety: { forbiddenActionText: [], readOnly: false },
    testDataPrefix: 'bh_',
    // Прежнее имя каталога сгенерированных тестов: разрыв схемы однократный, шеймов нет.
    tests: { unit: { command: null }, e2e: { dir: 'e2e/bughunter' } },
  });

  await assert.rejects(loadConfig(stateDir, commonConfigSchema), (error) => {
    const message = String(error);
    assert.ok(message.includes(`CONFIG_INVALID: ${file}:`), message);
    assert.match(message, /Unrecognized key: "e2e"/);
    assert.match(message, /tests\.generated/);
    return true;
  });
}));

test('run.json with legacy targetStages is not silently accepted', () => withStateDir(async (stateDir) => {
  const run = await createRun('full', undefined, { config, projectRoot: stateDir, stateDir, personas: ['p'], targets: ['/a'] });
  const file = join(stateDir, 'runs', run.id, 'run.json');
  const stored = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  await writeJsonAtomic(file, { ...stored, routeStages: stored.targetStages ?? {}, targetStages: undefined });

  await assert.rejects(readRun(run.id, stateDir), /RUN_SCHEMA_INVALID: routeStages/);
}));
