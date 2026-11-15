import type { Snapshot } from '@bughunter/core';

import type { CapturedResponse } from './session.ts';

/** Сколько последних ответов видит модель: полный список на длинной сессии съедает контекст. */
const maximumResponsesInSnapshot = 10;

/** Тело ответа в снимке: достаточно, чтобы прочитать ошибку, и мало, чтобы не утонуть в данных. */
const maximumBodyInSnapshot = 2_048;

/**
 * Что отдавать модели из снимка сессии: инвентарь эндпоинтов, последние ответы с усечёнными телами
 * и новые симптомы. Полные тела остаются в журнале ответов на диске — артефакте кандидата.
 */
export const nodeSnapshot: Snapshot = {
  compact: (value) => {
    if (value === null || typeof value !== 'object') return value;
    const snapshot = value as { responses?: unknown };
    if (!Array.isArray(snapshot.responses)) return value;
    const responses = snapshot.responses as CapturedResponse[];
    return {
      ...snapshot,
      responses: responses.slice(-maximumResponsesInSnapshot).map(trimResponse),
      totalResponses: responses.length,
    };
  },
};

/** Один ответ для модели: тело усекается, факт усечения виден явно. */
export function trimResponse(response: CapturedResponse): CapturedResponse & { truncated?: boolean } {
  const raw = response.raw.length > maximumBodyInSnapshot
    ? response.raw.slice(0, maximumBodyInSnapshot)
    : response.raw;
  const body = JSON.stringify(response.body ?? null).length > maximumBodyInSnapshot ? null : response.body;
  const truncated = raw !== response.raw || body !== response.body;
  return { ...response, raw, body, ...(truncated ? { truncated: true } : {}) };
}
