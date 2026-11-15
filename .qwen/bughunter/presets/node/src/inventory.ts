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
 * Эвристика нужна для значений, у которых под рукой нет профиля; объявленные шаблоны точны
 * и применяются в `targetOfRequest`.
 */
export function templatisedPath(path: string, idSegmentPattern: string = nodeIdSegmentPattern): string {
  const matcher = new RegExp(idSegmentPattern);
  return path
    .split('/')
    .map((segment) => (segment.length > 0 && matcher.test(segment) ? ':id' : segment))
    .join('/');
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Регулярное выражение шаблона эндпоинта: `:id` — любой непустой сегмент пути. */
export function templatePattern(template: string): RegExp {
  const body = template
    .split('/')
    .map((segment) => (segment.startsWith(':') ? '[^/]+' : escapeRegExp(segment)))
    .join('/');
  return new RegExp(`^${body}$`);
}

/**
 * Цель запроса по объявленным шаблонам профиля: `GET /orders/ord-1` → `GET /orders/:id`.
 * Сопоставление точное (профиль — источник правды), поэтому префиксные идентификаторы вроде
 * `ord-1` не приходится угадывать эвристикой. Query в сопоставлении не участвует.
 */
export function targetOfRequest(
  endpoints: readonly EndpointEntry[],
  method: string,
  path: string,
): string | undefined {
  const pathname = path.split('?')[0]!;
  const wanted = method.toUpperCase();
  return endpoints
    .filter((endpoint) => endpoint.method.toUpperCase() === wanted && templatePattern(endpoint.template).test(pathname))
    .map(endpointTarget)[0];
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
