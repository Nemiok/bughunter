import type { Errors } from '@bughunter/core';

/**
 * Доменные коды веб-пресета: их бросает пресет, а точка входа распознаёт как код ошибки,
 * а не как общую аварию. Нейтральные коды core объявлены там, где их бросают.
 */
export const webDomainCodes = [
  'CHECK_INVALID',
  'DRAG_TARGET_REQUIRED',
  'POINT_TARGET_UNRESOLVED',
  'SCREENS_STORE_CORRUPT',
  'SCREEN_NOT_FOUND',
  'SCROLL_INVALID',
  'UPLOAD_FILE_NOT_FOUND',
] as const;

export const webErrors: Errors = {
  /**
   * Нейтральный код core → код в словаре пресета. Перевод нужен, если ошибка доходит до
   * модели в обход обёртки пресета: модель видит экраны, а не «цели».
   */
  codes: {
    INVENTORY_EMPTY: 'SCREEN_NOT_FOUND',
    TARGETS_EMPTY: 'SCREEN_NOT_FOUND',
  },
};
