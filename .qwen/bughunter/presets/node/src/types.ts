import type { StepBase } from '@bughunter/core';

/**
 * Шаг журнала node-пресета: один HTTP-запрос и его исход. Форма плоская, как у веб-`Step`:
 * core хранит шаги как есть и не знает доменных полей.
 */
export type NodeStep = StepBase & {
  method?: string;
  path?: string;
  body?: unknown;
  status?: number;
  durationMs?: number;
};

/** Запись инвентаря: один эндпоинт приложения и пример его конкретного адреса. */
export type EndpointEntry = {
  template: string;
  method: string;
  samplePath: string;
  description?: string;
};

/** Объявленный сценарий обхода: конкретный запрос и, опционально, ожидаемый исход. */
export type NodeScenario = {
  name: 'valid' | 'empty' | 'invalid' | 'boundary';
  request: { method: string; path: string; body?: unknown; headers?: Record<string, string> };
  expect?: { status?: number; jsonPath?: Array<{ pointer: string; expected: unknown }> };
};
