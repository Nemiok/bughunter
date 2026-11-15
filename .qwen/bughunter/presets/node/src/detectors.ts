import { randomUUID } from 'node:crypto';

import { signalSignature } from '@bughunter/core';
import type { Detectors, SessionHandle, Signal } from '@bughunter/core';

import type { NodeConfig } from './config.ts';
import type { CapturedResponse, NodeSessionHandle } from './session.ts';

/** Виды симптомов node-пресета: статус, внутренности в теле, аномальные токены. */
export const nodeDetectorKinds = ['status', 'stack', 'anomaly'] as const;

/** Признаки того, что приложение отдало наружу внутренности: стек или код системной ошибки. */
const stackMarkers = ['\n    at ', 'at Object.<anonymous>', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'];

const maximumStackInSignal = 2_000;
const maximumMessageLength = 200;

/** Строковые значения тела: стек и аномальные токены прячутся внутри полей ответа. */
function stringValues(value: unknown, found: string[] = []): string[] {
  if (typeof value === 'string') found.push(value);
  else if (Array.isArray(value)) for (const item of value) stringValues(item, found);
  else if (value !== null && typeof value === 'object') for (const item of Object.values(value)) stringValues(item, found);
  return found;
}

function firstLine(text: string): string {
  const line = text.split('\n')[0]!.trim();
  return line.length > maximumMessageLength ? `${line.slice(0, maximumMessageLength)}…` : line;
}

/**
 * Симптомы одного ответа. Таймаут и сетевая ошибка — тоже симптом `status`: для приложения,
 * которое не отвечает, это такой же дефект, как 5xx.
 */
export function scanResponse(response: CapturedResponse, config: NodeConfig): Signal[] {
  const target = `${response.method} ${response.path.split('?')[0]}`;
  const signals: Signal[] = [];
  const add = (kind: string, message: string, stack?: string): void => {
    signals.push({
      id: randomUUID(),
      kind,
      message,
      signature: signalSignature({ kind, message, target, ...(stack === undefined ? {} : { stack }) }),
      target,
      timestamp: new Date().toISOString(),
      ...(response.status === 0 ? {} : { status: response.status }),
    });
  };

  if (response.error !== undefined) {
    add('status', response.error);
  } else if (response.status >= 400 && !(config.detectors.ignoreStatuses ?? []).includes(response.status)) {
    add('status', `HTTP ${response.status}`);
  }

  // В JSON-теле переводы строк экранированы, поэтому стек ищется и в разобранных строках,
  // и в сыром тексте с возвращёнными переводами.
  const texts = [...stringValues(response.body), response.raw.replaceAll('\\n', '\n')];
  const stack = texts.find((text) => stackMarkers.some((marker) => text.includes(marker)));
  if (stack !== undefined) add('stack', firstLine(stack), stack.slice(0, maximumStackInSignal));

  for (const token of config.detectors.anomalyTexts) {
    if (texts.some((text) => text.includes(token))) add('anomaly', token);
  }
  return signals;
}

/**
 * Сканирование отдаёт то, что запросы сессии уже накопили, и опустошает буфер: каждый симптом
 * попадает к потребителю один раз.
 */
export const nodeDetectors: Detectors = {
  kinds: [...nodeDetectorKinds],
  scan: async (handle: SessionHandle): Promise<Signal[]> => (handle as NodeSessionHandle).drainSignals(),
};
