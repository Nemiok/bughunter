import type { TargetInventory } from '@bughunter/core';

import { loadNodeConfig } from './config.ts';
import { loadNodeProfile } from './profile.ts';
import type { EndpointEntry } from './types.ts';

/** Сегмент, похожий на идентификатор записи: hex-uuid, числа, длинные цифры. */
export const nodeIdSegmentPattern = '^[0-9a-fA-F]{8,}$|^\\d+$';

const withMethod = /^([A-Za-z]{3,7}) +(\S+)$/;

/**
 * Цель node-пресета — «МЕТОД /шаблон»: один путь бывает целью двух эндпоинтов
 * (`GET /orders` и `POST /orders`), поэтому метод входит в идентификатор цели.
 */
export function endpointTarget(entry: Pick<EndpointEntry, 'method' | 'template'>): string {
  return `${entry.method.toUpperCase()} ${entry.template}`;
}

/**
 * `/orders/7f3ab4c9` и `/orders/12` — один эндпоинт `/orders/:id`. Без шаблонизации инвентарь
 * сервиса с миллионами записей состоял бы из миллиона целей и не годился бы для обхода.
 */
export function templatisedPath(path: string, idSegmentPattern: string = nodeIdSegmentPattern): string {
  const matcher = new RegExp(idSegmentPattern);
  return path
    .split('/')
    .map((segment) => (segment.length > 0 && matcher.test(segment) ? ':id' : segment))
    .join('/');
}

/** Путь из цели, адреса или URL: метод отбрасывается, query не участвует в шаблоне. */
function pathOf(value: string): string {
  const reference = withMethod.exec(value)?.[2] ?? value;
  if (reference.startsWith('/')) return reference.split('?')[0]!;
  try {
    return new URL(reference).pathname;
  } catch {
    return reference;
  }
}

export const nodeInventory: TargetInventory = {
  /** Инвентарь — это профиль: автообхода роутеров и OpenAPI в учебном пресете нет. */
  list: async (stateDir) => {
    const config = await loadNodeConfig(stateDir);
    const profile = await loadNodeProfile(stateDir, config.profile);
    return profile.endpoints.map(endpointTarget);
  },
  templateOf: (value) => {
    const templated = templatisedPath(pathOf(value.trim()));
    const method = withMethod.exec(value.trim())?.[1];
    return method === undefined ? templated : `${method.toUpperCase()} ${templated}`;
  },
};
