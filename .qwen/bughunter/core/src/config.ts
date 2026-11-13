import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import { writeJsonAtomic } from './run-store.ts';

/**
 * Общие поля `config.json`. Пресет расширяет схему своими полями (`commonConfigSchema.extend`)
 * и передаёт её сюда: механика чтения, валидации и создания файла одна на все пресеты,
 * а состав полей — знание пресета.
 */
export const commonConfigSchema = z.strictObject({
  baseBranch: z.string().min(1),
  profile: z.string().min(1).optional(),
  targetMap: z.record(z.string(), z.array(z.string().min(1))),
  limits: z.strictObject({
    stepsPerSession: z.number().int().positive(),
    candidatesPerRun: z.number().int().positive(),
  }),
  safety: z.strictObject({
    forbiddenActionText: z.array(z.string()),
    readOnly: z.boolean(),
  }),
  testDataPrefix: z.string(),
  tests: z.strictObject({
    unit: z.strictObject({ command: z.string().nullable() }),
    generated: z.strictObject({ dir: z.string().min(1) }),
  }),
});

export function configPath(stateDir: string): string {
  return join(stateDir, 'config.json');
}

export async function loadConfig<T>(stateDir: string, schema: z.ZodType<T>): Promise<T> {
  const file = configPath(stateDir);
  let source: string;
  try {
    source = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`CONFIG_NOT_FOUND: ${file}`);
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`CONFIG_INVALID: ${file}: ${message}`);
  }

  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new Error(`CONFIG_INVALID: ${file}: ${issues}`);
  }
  return result.data;
}

export async function ensureConfig<T>(
  stateDir: string,
  schema: z.ZodType<T>,
  template: T,
): Promise<{ config?: T; createdPath?: string }> {
  const file = configPath(stateDir);
  try {
    return { config: await loadConfig(stateDir, schema) };
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('CONFIG_NOT_FOUND:')) throw error;
  }
  await writeJsonAtomic(file, template);
  return { createdPath: file };
}
