import { z } from 'zod';

import {
  commonConfigSchema,
  ensureConfig as ensureCoreConfig,
  loadConfig as loadCoreConfig,
} from '@bughunter/core';

import { defaultStateDir } from './paths.ts';

/** Сколько элементов снимка видит модель за вызов, если конфиг не задаёт своё значение. */
export const defaultElementsPerSnapshot = 120;

/**
 * Поля веб-пресета поверх общей схемы core: адрес стенда, разрешённые origins, список
 * маршрутов, браузер и детекторы. Механика чтения, валидации и создания файла — в core.
 */
export const webConfigSchema = commonConfigSchema.extend({
  baseUrl: z.url(),
  allowedOrigins: z.array(z.url()).min(1),
  routes: z.array(z.string().startsWith('/')).min(1),
  // Цель в веб-пресете — путь, начинающийся с `/`: опечатка в карте иначе молча расширила бы
  // `diff`-прогон до всего инвентаря, потому что ни одна цель не совпала бы с `routes`.
  targetMap: z.record(z.string(), z.array(z.string().startsWith('/'))),
  browser: z.strictObject({
    launchArgs: z.array(z.string().min(1)).max(64).optional(),
    proxy: z.string().min(1).optional(),
    ignoreHTTPSErrors: z.boolean().optional(),
  }).optional(),
  limits: z.strictObject({
    stepsPerSession: z.number().int().positive(),
    candidatesPerRun: z.number().int().positive(),
    elementsPerSnapshot: z.number().int().positive().max(2000).optional(),
    responseSettleMs: z.number().int().nonnegative().max(60_000).optional(),
    screensPerSweep: z.number().int().positive().max(2000).optional(),
  }),
  detectors: z.strictObject({
    ignoreConsole: z.array(z.string()),
    ignoreRequests: z.array(z.string()),
    anomalyTexts: z.array(z.string()),
    errorBoundarySelector: z.string().min(1),
  }),
});

export type WebConfig = z.infer<typeof webConfigSchema>;

function configTemplate(): WebConfig {
  return {
    baseUrl: 'https://dev-stand.example.local',
    allowedOrigins: ['https://dev-stand.example.local'],
    routes: ['/', '/orders', '/orders/new', '/profile'],
    targetMap: { 'src/pages/orders/**': ['/orders', '/orders/new'] },
    baseBranch: 'main',
    limits: { stepsPerSession: 60, candidatesPerRun: 20, elementsPerSnapshot: defaultElementsPerSnapshot },
    safety: { forbiddenActionText: ['удалить', 'delete', 'оплатить'], readOnly: false },
    testDataPrefix: 'bh_',
    detectors: {
      ignoreConsole: [],
      ignoreRequests: [],
      anomalyTexts: ['undefined', 'NaN', '[object Object]', 'Invalid Date'],
      errorBoundarySelector: '[data-error-boundary]',
    },
    tests: { unit: { command: null }, generated: { dir: 'e2e/bughunter' } },
  };
}

export async function loadConfig(stateDir?: string): Promise<WebConfig> {
  return loadCoreConfig(stateDir ?? defaultStateDir, webConfigSchema);
}

export async function ensureConfig(stateDir?: string): Promise<{ config?: WebConfig; createdPath?: string }> {
  return ensureCoreConfig(stateDir ?? defaultStateDir, webConfigSchema, configTemplate());
}
