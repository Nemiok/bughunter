import { z } from 'zod';

import {
  commonConfigSchema,
  ensureConfig as ensureCoreConfig,
  loadConfig as loadCoreConfig,
} from '@bughunter/core';

import { defaultStateDir } from './paths.ts';
import type { NodeScenario } from './types.ts';

const scenarioNames = ['valid', 'empty', 'invalid', 'boundary'] as const;

const nodeScenarioSchema = z.strictObject({
  name: z.enum(scenarioNames),
  request: z.strictObject({
    method: z.string().min(1),
    path: z.string().startsWith('/'),
    body: z.unknown().optional(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
  expect: z.strictObject({
    status: z.number().int().positive().optional(),
    jsonPath: z.array(z.strictObject({
      pointer: z.string().startsWith('/'),
      expected: z.unknown(),
    })).optional(),
  }).optional(),
});

/**
 * Цель node-пресета — «МЕТОД /путь»: опечатка в карте целей иначе молча расширила бы `diff`-прогон
 * до всего инвентаря, потому что ни одна цель не совпала бы со списком из профиля.
 */
const targetPattern = /^[A-Z]{3,7} \//;

/**
 * Поля node-пресета поверх общей схемы core: адрес стенда, разрешённые хосты, объявленные
 * сценарии обхода и способ сброса состояния. Механика чтения, валидации и создания файла — в core.
 */
export const nodeConfigSchema = commonConfigSchema.extend({
  baseUrl: z.url(),
  allowedHosts: z.array(z.string().min(1)).min(1),
  // Инвентарь node-пресета — это профиль: без него нечего исследовать и нечего обходить.
  profile: z.string().min(1),
  scenarios: z.array(nodeScenarioSchema).min(1),
  reset: z.strictObject({
    method: z.string().min(1),
    path: z.string().startsWith('/'),
  }).nullable(),
  requestTimeoutMs: z.number().int().positive().max(60_000).optional(),
  targetMap: z.record(z.string(), z.array(z.string().regex(targetPattern, 'цель — «МЕТОД /путь»'))),
  detectors: z.strictObject({
    anomalyTexts: z.array(z.string().min(1)),
    ignoreStatuses: z.array(z.number().int()).optional(),
  }),
});

export type NodeConfig = z.infer<typeof nodeConfigSchema>;

const longId = '9'.repeat(32);
const longQuery = 'ы'.repeat(64);

/**
 * Сценарии учебного стенда `fixtures/node-api-app`: четыре формы запроса на каждый из пяти
 * эндпоинтов. `expect` — объявленный контракт приложения, поэтому обход находит нарушение
 * без модели: N1 (500 вместо 400), N2 (200 вместо 400), N3 (200 вместо 404), N6 (502 вместо 200).
 * `/health` — контроль: все четыре сценария обязаны пройти без находок.
 */
function fixtureScenarios(): NodeScenario[] {
  return [
    {
      name: 'valid',
      request: { method: 'GET', path: '/health' },
      expect: { status: 200, jsonPath: [{ pointer: '/status', expected: 'ok' }] },
    },
    {
      name: 'empty',
      request: { method: 'GET', path: '/health?' },
      expect: { status: 200, jsonPath: [{ pointer: '/status', expected: 'ok' }] },
    },
    {
      name: 'invalid',
      request: { method: 'GET', path: '/health', headers: { Accept: 'text/plain' } },
      expect: { status: 200, jsonPath: [{ pointer: '/status', expected: 'ok' }] },
    },
    {
      name: 'boundary',
      request: { method: 'GET', path: `/health?trace=${longQuery}` },
      expect: { status: 200, jsonPath: [{ pointer: '/status', expected: 'ok' }] },
    },

    { name: 'valid', request: { method: 'GET', path: '/orders' }, expect: { status: 200 } },
    { name: 'empty', request: { method: 'GET', path: '/orders?filter=' }, expect: { status: 200 } },
    { name: 'invalid', request: { method: 'GET', path: '/orders?filter[]=x' }, expect: { status: 200 } },
    { name: 'boundary', request: { method: 'GET', path: '/orders?limit=-1' }, expect: { status: 200 } },

    {
      name: 'valid',
      request: { method: 'GET', path: '/orders/ord-1' },
      expect: { status: 200, jsonPath: [{ pointer: '/id', expected: 'ord-1' }] },
    },
    { name: 'empty', request: { method: 'GET', path: '/orders/0' }, expect: { status: 404 } },
    { name: 'invalid', request: { method: 'GET', path: '/orders/ord-unknown' }, expect: { status: 404 } },
    { name: 'boundary', request: { method: 'GET', path: `/orders/${longId}` }, expect: { status: 404 } },

    {
      name: 'valid',
      request: { method: 'POST', path: '/orders', body: { qty: 3 } },
      expect: { status: 200, jsonPath: [{ pointer: '/totalCents', expected: 3600 }] },
    },
    { name: 'empty', request: { method: 'POST', path: '/orders', body: {} }, expect: { status: 400 } },
    {
      name: 'invalid',
      request: { method: 'POST', path: '/orders', body: { qty: 'abc' } },
      expect: { status: 400 },
    },
    {
      name: 'boundary',
      request: { method: 'POST', path: '/orders', body: { qty: -5 } },
      expect: { status: 400 },
    },

    {
      name: 'valid',
      request: {
        method: 'POST',
        path: '/payments',
        body: { orderId: 'ord-1', amountCents: 1000, idempotencyKey: 'bh_sweep_valid' },
      },
      expect: { status: 200 },
    },
    { name: 'empty', request: { method: 'POST', path: '/payments', body: {} }, expect: { status: 400 } },
    {
      name: 'invalid',
      request: {
        method: 'POST',
        path: '/payments',
        body: { orderId: 'ord-1', amountCents: 'много', idempotencyKey: 'bh_sweep_invalid' },
      },
      expect: { status: 400 },
    },
    {
      name: 'boundary',
      request: {
        method: 'POST',
        path: '/payments',
        body: { orderId: 'ord-1', amountCents: 1, idempotencyKey: 'bh_sweep_boundary' },
      },
      expect: { status: 200 },
    },
  ];
}

export function nodeConfigTemplate(): NodeConfig {
  return {
    baseUrl: 'http://127.0.0.1:3000',
    allowedHosts: ['127.0.0.1', 'localhost'],
    profile: 'node-api-app',
    scenarios: fixtureScenarios(),
    reset: { method: 'POST', path: '/__reset' },
    requestTimeoutMs: 10_000,
    targetMap: {
      'fixtures/node-api-app/src/**': [
        'GET /health', 'GET /orders', 'POST /orders', 'GET /orders/:id', 'POST /payments',
      ],
    },
    baseBranch: 'main',
    limits: { stepsPerSession: 60, candidatesPerRun: 20 },
    safety: { forbiddenActionText: ['DELETE', 'drop', 'truncate'], readOnly: false },
    testDataPrefix: 'bh_',
    detectors: {
      anomalyTexts: ['undefined', 'NaN', '[object Object]', 'ECONNREFUSED', 'at Object.<anonymous>'],
      ignoreStatuses: [],
    },
    tests: { unit: { command: 'npx vitest run' }, generated: { dir: 'test/bughunter' } },
  };
}

export async function loadNodeConfig(stateDir?: string): Promise<NodeConfig> {
  return loadCoreConfig(stateDir ?? defaultStateDir, nodeConfigSchema);
}

export async function ensureNodeConfig(stateDir?: string): Promise<{ config?: NodeConfig; createdPath?: string }> {
  return ensureCoreConfig(stateDir ?? defaultStateDir, nodeConfigSchema, nodeConfigTemplate());
}
