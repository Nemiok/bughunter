import type { Errors } from '@bughunter/core';

/**
 * Доменные коды node-пресета: их бросает пресет, а точка входа распознаёт как код ошибки,
 * а не как общую аварию. В словаре только те коды, которые пресет действительно бросает.
 */
export const nodeDomainCodes = [
  'CHECK_INVALID',
  'ENDPOINT_NOT_FOUND',
  'FORBIDDEN_ORIGIN',
  'POINTER_INVALID',
  'POINTER_NOT_FOUND',
  'PROFILE_INVALID',
  'PROFILE_NOT_FOUND',
  'RESET_FAILED',
  'RESET_UNSUPPORTED',
  'SCENARIO_INVALID',
  'SESSION_NOT_FOUND',
  'TARGET_REQUIRED',
  'TEST_DATA_PATH_UNSAFE',
] as const;

export const nodeErrors: Errors = {
  /**
   * Нейтральный код core → код в словаре пресета: модель оперирует эндпоинтами, а не «целями»
   * или «инвентарём», поэтому пустой инвентарь звучит как «эндпоинт не найден».
   */
  codes: {
    INVENTORY_EMPTY: 'ENDPOINT_NOT_FOUND',
    TARGETS_EMPTY: 'ENDPOINT_NOT_FOUND',
  },
};
