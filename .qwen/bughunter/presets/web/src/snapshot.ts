import type { Snapshot } from '@bughunter/core';

/**
 * Локатор элемента — внутренность пресета: модель выбирает элемент по `id` снимка, а селектор
 * в ответе только расходует контекст и провоцирует переносить его в тест руками.
 */
export const webSnapshot: Snapshot = {
  compact: (value) => {
    if (value === null || typeof value !== 'object') return value;
    const state = value as { elements?: unknown };
    if (!Array.isArray(state.elements)) return value;
    return {
      ...state,
      elements: state.elements.map((element) => {
        const { locator: _locator, ...visible } = element as Record<string, unknown>;
        return visible;
      }),
    };
  },
};
