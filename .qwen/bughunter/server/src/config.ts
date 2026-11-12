import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { writeJsonAtomic } from './run-store.ts';
import type { Config } from './types.ts';

const defaultStateDir = resolve(import.meta.dirname, '../../state');

const configSchema: z.ZodType<Config> = z.strictObject({
  baseUrl: z.url(),
  allowedOrigins: z.array(z.url()).min(1),
  routes: z.array(z.string().startsWith('/')).min(1),
  routeMap: z.record(z.string(), z.array(z.string().startsWith('/'))),
  baseBranch: z.string().min(1),
  profile: z.string().min(1).optional(),
  browser: z.strictObject({
    launchArgs: z.array(z.string().min(1)).max(64).optional(),
    proxy: z.string().min(1).optional(),
    ignoreHTTPSErrors: z.boolean().optional(),
  }).optional(),
  limits: z.strictObject({
    stepsPerSession: z.number().int().positive(),
    candidatesPerRun: z.number().int().positive(),
  }),
  safety: z.strictObject({
    forbiddenActionText: z.array(z.string()),
    readOnly: z.boolean(),
  }),
  testDataPrefix: z.string(),
  detectors: z.strictObject({
    ignoreConsole: z.array(z.string()),
    ignoreRequests: z.array(z.string()),
    anomalyTexts: z.array(z.string()),
    errorBoundarySelector: z.string().min(1),
  }),
  tests: z.strictObject({
    unit: z.strictObject({ command: z.string().nullable() }),
    e2e: z.strictObject({ dir: z.string().min(1) }),
  }),
});

function configTemplate(): Config {
  return {
    baseUrl: 'https://dev-stand.example.local',
    allowedOrigins: ['https://dev-stand.example.local'],
    routes: ['/', '/orders', '/orders/new', '/profile'],
    routeMap: { 'src/pages/orders/**': ['/orders', '/orders/new'] },
    baseBranch: 'main',
    limits: { stepsPerSession: 60, candidatesPerRun: 20 },
    safety: { forbiddenActionText: ['удалить', 'delete', 'оплатить'], readOnly: false },
    testDataPrefix: 'bh_',
    detectors: {
      ignoreConsole: [],
      ignoreRequests: [],
      anomalyTexts: ['undefined', 'NaN', '[object Object]', 'Invalid Date'],
      errorBoundarySelector: '[data-error-boundary]',
    },
    tests: { unit: { command: null }, e2e: { dir: 'e2e/bughunter' } },
  };
}

function configPath(stateDir: string | undefined): string {
  return join(stateDir ?? defaultStateDir, 'config.json');
}

export async function loadConfig(stateDir?: string): Promise<Config> {
  const file = configPath(stateDir);
  let source: string;
  try {
    source = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`CONFIG_NOT_FOUND: ${file}`);
    }
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`CONFIG_INVALID: ${file}: ${message}`);
  }

  const result = configSchema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new Error(`CONFIG_INVALID: ${file}: ${issues}`);
  }
  return result.data;
}

export async function ensureConfig(stateDir?: string): Promise<{ config?: Config; createdPath?: string }> {
  const file = configPath(stateDir);
  try {
    return { config: await loadConfig(stateDir) };
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('CONFIG_NOT_FOUND:')) {
      throw error;
    }
  }
  await writeJsonAtomic(file, configTemplate());
  return { createdPath: file };
}
