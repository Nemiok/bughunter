import { z } from 'zod';

import {
  commonConfigSchema,
  ensureConfig as ensureCoreConfig,
  loadConfig as loadCoreConfig,
} from '@bughunter/core';

import { defaultStateDir } from './paths.ts';
import type { CliScenario } from './types.ts';

const scenarioNames = ['valid', 'empty', 'invalid', 'boundary'] as const;

const cliScenarioSchema = z.strictObject({
  name: z.enum(scenarioNames),
  target: z.string().min(1),
  argv: z.array(z.string()).min(1),
  setup: z.array(z.strictObject({ argv: z.array(z.string()).min(1) })).optional(),
  expect: z.strictObject({
    exitCode: z.number().int().nonnegative(),
    stdoutContains: z.array(z.string()).optional(),
    stdoutNotContains: z.array(z.string()).optional(),
    stderrContains: z.array(z.string()).optional(),
    stderrNotContains: z.array(z.string()).optional(),
  }),
});

/**
 * Поля CLI-пресета поверх общей схемы core. Цель — шаблон команды, действие — запуск процесса
 * без оболочки: аргументы передаются массивом, поэтому пробелы и кавычки не становятся инъекцией.
 */
export const cliConfigSchema = commonConfigSchema.extend({
  /** Каталог приложения: абсолютный или относительно каталога состояния. */
  appDir: z.string().min(1),
  /** Точка входа относительно `appDir`, запускаемая текущим `node`. */
  appEntry: z.string().min(1),
  /** Файл базы, который получает приложение через `DB_FILE`. */
  databaseFile: z.string().min(1),
  profile: z.string().min(1),
  scenarios: z.array(cliScenarioSchema).min(1),
  reset: z.strictObject({ kind: z.literal('delete-db') }).nullable(),
  timeoutMs: z.number().int().positive().max(60_000).optional(),
  detectors: z.strictObject({
    allowedExitCodes: z.array(z.number().int()),
    anomalyTexts: z.array(z.string().min(1)),
  }),
});

export type CliConfig = z.infer<typeof cliConfigSchema>;

/**
 * Сценарии мини-фикстуры. `expect` — объявленный контракт приложения, поэтому обход находит C1,
 * C2 и C4 без модели. C3 (повторный `add`) требует двух мутаций и `list` в одной сессии; одного
 * сценария на цель для него мало, поэтому он оставлен модельному исследованию.
 */
function fixtureScenarios(): CliScenario[] {
  return [
    {
      name: 'valid',
      target: 'add <name> <qty>',
      argv: ['add', 'apple', '3'],
      expect: { exitCode: 0, stdoutContains: ['ok apple total=300'] },
    },
    {
      name: 'invalid',
      target: 'add <name> <qty>',
      argv: ['add', 'x', 'abc'],
      expect: { exitCode: 2, stdoutNotContains: ['NaN'], stderrContains: ['количество'] },
    },
    {
      name: 'boundary',
      target: 'add <name> <qty>',
      argv: ['add', 'banana', '-5'],
      expect: { exitCode: 2, stdoutNotContains: ['total=-500'], stderrContains: ['количество'] },
    },

    {
      name: 'valid',
      target: 'show <name>',
      setup: [{ argv: ['add', 'apple', '3'] }],
      argv: ['show', 'apple'],
      expect: { exitCode: 0, stdoutContains: ['300'] },
    },
    {
      name: 'invalid',
      target: 'show <name>',
      argv: ['show', 'missing'],
      expect: { exitCode: 2, stderrNotContains: ['    at '] },
    },

    {
      name: 'valid',
      target: 'list',
      argv: ['list'],
      expect: { exitCode: 0, stdoutContains: ['[]'] },
    },
    {
      name: 'empty',
      target: 'list',
      setup: [{ argv: ['add', 'apple', '3'] }],
      argv: ['list'],
      expect: { exitCode: 0, stdoutContains: ['"name":"apple"', '"qty":3', '"total":300'] },
    },
    {
      name: 'boundary',
      target: 'list',
      argv: ['list', 'extra'],
      expect: { exitCode: 0, stdoutContains: ['[]'] },
    },
  ];
}

export function cliConfigTemplate(): CliConfig {
  return {
    // Относительный путь ищется от текущего каталога сервера, затем от state: установка
    // переносит toolkit в `.qwen/bughunter`, а фикстура остаётся в корне проекта.
    appDir: 'cli-app',
    appEntry: 'src/cli.js',
    databaseFile: 'orders.json',
    profile: 'cli-app',
    scenarios: fixtureScenarios(),
    reset: { kind: 'delete-db' },
    timeoutMs: 10_000,
    targetMap: {
      'cli-app/src/**': ['add <name> <qty>', 'show <name>', 'list'],
    },
    baseBranch: 'main',
    limits: { stepsPerSession: 40, candidatesPerRun: 20 },
    safety: { forbiddenActionText: [], readOnly: false },
    testDataPrefix: 'bh_',
    detectors: {
      allowedExitCodes: [0, 2],
      anomalyTexts: ['NaN', 'undefined', '[object Object]'],
    },
    tests: { unit: { command: 'node --test' }, generated: { dir: 'test/bughunter' } },
  };
}

export async function loadCliConfig(stateDir?: string): Promise<CliConfig> {
  return loadCoreConfig(stateDir ?? defaultStateDir, cliConfigSchema);
}

export async function ensureCliConfig(stateDir?: string): Promise<{ config?: CliConfig; createdPath?: string }> {
  return ensureCoreConfig(stateDir ?? defaultStateDir, cliConfigSchema, cliConfigTemplate());
}
