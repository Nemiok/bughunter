import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

import type { ProfileSchema } from '@bughunter/core';

import type { EndpointEntry } from './types.ts';

/** Профиль node-пресета: инвентарь эндпоинтов и, опционально, каталог тестовых данных. */
export type NodeProfile = {
  endpoints: EndpointEntry[];
  testDataDir?: string;
};

const profileSchema: z.ZodType<NodeProfile> = z.strictObject({
  endpoints: z.array(z.strictObject({
    template: z.string().startsWith('/'),
    method: z.string().min(1),
    samplePath: z.string().startsWith('/'),
    description: z.string().min(1).optional(),
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

export async function loadNodeProfile(stateDir: string, name: string): Promise<NodeProfile> {
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

/**
 * Файл тестовых данных резолвится строго внутри `profile.testDataDir`: запрос не должен уметь
 * прочитать произвольный файл машины.
 */
export function resolveTestDataFile(profile: NodeProfile | null, relativePath: string): string {
  const directory = profile?.testDataDir;
  if (directory === undefined) throw new Error(`TEST_DATA_PATH_UNSAFE: ${relativePath}`);
  const root = resolve(directory);
  const resolved = resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(root + sep)) throw new Error(`TEST_DATA_PATH_UNSAFE: ${relativePath}`);
  return resolved;
}

export const nodeProfile: ProfileSchema = {
  load: loadNodeProfile,
  testDataFile: (profile, relativePath) => resolveTestDataFile(profile as NodeProfile | null, relativePath),
};
