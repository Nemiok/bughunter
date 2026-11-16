import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { writeJsonAtomic } from '@bughunter/core';

import { cliConfigTemplate } from '../src/config.ts';
import type { CliConfig } from '../src/config.ts';

export const presetRoot = resolve(import.meta.dirname, '..');
export const copyRoot = resolve(presetRoot, '../../..');
export const fixtureDir = join(copyRoot, 'cli-app');

/** Одноразовый каталог внутри копии: тесты не должны оставлять следов в системном tmp. */
export function ownTemporaryDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(presetRoot, `.test-${prefix}`));
}

export type TestState = {
  stateDir: string;
  config: CliConfig;
  cleanup(): Promise<void>;
};

/**
 * Каталог состояния внутри копии (не в системном tmp): задание запрещает выходить за её корень,
 * а `mkdtemp` рядом с пакетом ещё и не требует прав на чужие каталоги.
 */
export async function stateFor(patch?: (config: CliConfig) => void): Promise<TestState> {
  const stateDir = await mkdtemp(join(presetRoot, '.test-state-'));
  const config = cliConfigTemplate();
  config.appDir = fixtureDir;
  patch?.(config);
  await writeJsonAtomic(join(stateDir, 'config.json'), config);
  await mkdir(join(stateDir, 'profiles', config.profile), { recursive: true });
  await copyFile(
    join(presetRoot, 'state', 'profiles', config.profile, 'index.ts'),
    join(stateDir, 'profiles', config.profile, 'index.ts'),
  );
  return {
    stateDir,
    config,
    cleanup: () => rm(stateDir, { recursive: true, force: true }),
  };
}

/** Копия конфига без записи: для проверок схемы и профиля. */
export function configCopy(patch?: (config: CliConfig) => void): CliConfig {
  const config = cliConfigTemplate();
  config.appDir = fixtureDir;
  patch?.(config);
  return config;
}

export async function writeConfig(stateDir: string, config: unknown): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}
