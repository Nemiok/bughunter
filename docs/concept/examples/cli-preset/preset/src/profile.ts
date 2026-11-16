import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

import type { ProfileSchema } from '@bughunter/core';

import type { CliCommand } from './types.ts';

/** Профиль CLI-пресета: инвентарь команд и, опционально, каталог тестовых данных. */
export type CliProfile = {
  commands: CliCommand[];
  testDataDir?: string;
};

const profileSchema: z.ZodType<CliProfile> = z.strictObject({
  commands: z.array(z.strictObject({
    command: z.string().min(1),
    template: z.string().min(1),
    sampleArgv: z.array(z.string()).min(1),
    description: z.string().min(1).optional(),
    mutates: z.boolean().optional(),
  })).min(1),
  testDataDir: z.string().min(1).optional(),
});

const safeProfileName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function profileEntryPath(stateDir: string, name: string): string {
  if (!safeProfileName.test(name)) throw new Error(`PROFILE_NOT_FOUND: ${name}`);
  return resolve(stateDir, 'profiles', name, 'index.ts');
}

export async function loadCliProfile(stateDir: string, name: string): Promise<CliProfile> {
  const entry = profileEntryPath(stateDir, name);
  let loaded: unknown;
  try {
    const module = await import(pathToFileURL(entry).href) as { default?: unknown };
    loaded = module.default;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? '';
    if (['ERR_MODULE_NOT_FOUND', 'ENOENT', 'ENOTDIR', 'ERR_UNSUPPORTED_DIR_IMPORT'].includes(code)) {
      throw new Error(`PROFILE_NOT_FOUND: ${name}`);
    }
    throw new Error(`PROFILE_INVALID: ${name}: ${messageOf(error)}`);
  }
  if (loaded === undefined) throw new Error(`PROFILE_INVALID: ${name}: модуль не имеет default-экспорта`);
  const parsed = profileSchema.safeParse(loaded);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'неизвестная ошибка схемы';
    throw new Error(`PROFILE_INVALID: ${name}: ${where}`);
  }
  return parsed.data;
}

function resolveTestDataFile(profile: CliProfile | null, relativePath: string): string {
  const directory = profile?.testDataDir;
  if (directory === undefined) throw new Error(`TEST_DATA_PATH_UNSAFE: ${relativePath}`);
  const root = resolve(directory);
  const resolved = resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(root + sep)) throw new Error(`TEST_DATA_PATH_UNSAFE: ${relativePath}`);
  return resolved;
}

export const cliProfile: ProfileSchema = {
  load: loadCliProfile,
  testDataFile: (profile, relativePath) => resolveTestDataFile(profile as CliProfile | null, relativePath),
};

/**
 * Каталог приложения. Абсолютный путь берётся как есть; относительный ищется от текущего каталога
 * вверх до границы проекта (`.git`), потому что сервер может быть запущен как из корня копии, так
 * и из `toolkit/` или из каталога воркспейса. Если выше подняться нельзя, остаётся каталог
 * состояния. Это нужно и после установки `toolkit/` в `.qwen/bughunter/`, когда фикстура остаётся
 * в корне.
 */
export function appDirectory(appDir: string, stateDir: string): string {
  if (isAbsolute(appDir)) return resolve(appDir);
  let directory = resolve(process.cwd());
  while (true) {
    const candidate = resolve(directory, appDir);
    if (existsSync(candidate)) return candidate;
    if (existsSync(resolve(directory, '.git'))) break;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return resolve(stateDir, appDir);
}
