import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { loadConfig } from '../config.ts';
import type { Profile } from './types.ts';

const profileSchema: z.ZodType<Profile> = z.strictObject({
  name: z.string().min(1),
  extractors: z.array(z.strictObject({
    name: z.string().min(1),
    widget: z.string().min(1),
    kind: z.enum(['table', 'chart', 'scene', 'dom']),
    script: z.string().min(1),
  })),
  oracles: z.array(z.strictObject({
    urlPattern: z.string().min(1),
    widget: z.string().min(1),
    fields: z.array(z.string().min(1)),
  })),
  contract: z.array(z.strictObject({
    path: z.string().min(1),
    format: z.enum(['number', 'string', 'date']).optional(),
    unit: z.string().optional(),
    rounding: z.number().int().nonnegative().optional(),
    timezone: z.string().optional(),
    aggregation: z.enum(['sum', 'avg', 'count', 'none']).optional(),
  })).optional(),
  reset: z.strictObject({
    kind: z.enum(['storage-flag', 'mock-endpoint']),
    key: z.string().min(1).optional(),
    url: z.string().min(1).optional(),
  }).optional(),
  navigation: z.strictObject({ idSegmentPattern: z.string().min(1) }).optional(),
  testData: z.strictObject({ dir: z.string().min(1) }).optional(),
  interactions: z.strictObject({ resolvePoint: z.string().min(1).optional() }).optional(),
  responseSource: z.enum(['playwright', 'page-hook']).optional(),
  browser: z.strictObject({ launchArgs: z.array(z.string()).max(64) }).optional(),
});

const safeProfileName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function profileEntryPath(stateDir: string, name: string): string {
  if (!safeProfileName.test(name)) throw new Error(`PROFILE_NOT_FOUND: ${name}`);
  return resolve(join(stateDir, 'profiles', name, 'index.ts'));
}

export async function loadProfile(stateDir: string, name: string): Promise<Profile> {
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
    throw new Error(`PROFILE_INVALID: ${name}: ${error instanceof Error ? error.message : String(error)}`);
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

export async function loadActiveProfile(stateDir: string): Promise<Profile | null> {
  const config = await loadConfig(stateDir);
  if (config.profile === undefined) return null;
  return loadProfile(stateDir, config.profile);
}

/**
 * Файл загрузки резолвится строго внутри `profile.testData.dir`: модель не должна уметь
 * прочитать произвольный файл машины действием `upload`.
 */
export function resolveTestDataFile(profile: Profile | null, file: string): string {
  const directory = profile?.testData?.dir;
  if (directory === undefined) throw new Error(`UPLOAD_FILE_NOT_FOUND: ${file}`);
  const root = resolve(directory);
  const resolved = resolve(root, file);
  if (resolved !== root && !resolved.startsWith(root + sep)) throw new Error(`UPLOAD_FILE_NOT_FOUND: ${file}`);
  return resolved;
}
