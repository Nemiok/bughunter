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
  'TARGET_NOT_ALLOWED',
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

/** Ошибка, код которой точка входа обязана отдать модели как есть, а не как общую аварию. */
export class ToolError extends Error {}

/**
 * Код ошибки для модели. Свои коды пресета и переведённые нейтральные коды core проходят как есть,
 * неизвестная авария становится `TOOL_FAILED`: словарь пресета объявлен выше, а не в точке входа.
 */
export function errorCode(error: unknown): { code: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ToolError) return { code: message.split(':')[0] ?? 'TOOL_FAILED', message };
  if (message.startsWith('CONFIG_INVALID:') || message.startsWith('CONFIG_NOT_FOUND:')) {
    return { code: 'CONFIG_INVALID', message };
  }
  if (message === 'LIMIT_REACHED') return { code: 'LIMIT_REACHED', message };
  if (message.startsWith('FORBIDDEN_ACTION')) return { code: 'FORBIDDEN_ACTION', message };
  if (message.startsWith('CANDIDATE_UNREPRODUCED:')) return { code: 'CANDIDATE_UNREPRODUCED', message };
  if (message.startsWith('RUN_INCOMPLETE:')) return { code: 'RUN_INCOMPLETE', message };
  if (/^LEASE_(REQUIRED|UNKNOWN|MISMATCH):/.test(message)) return { code: message.split(':')[0] ?? 'LEASE_UNKNOWN', message };
  const token = message.split(':')[0] ?? '';
  const translated = nodeErrors.codes[token];
  if (translated !== undefined) return { code: translated, message };
  if ((nodeDomainCodes as readonly string[]).includes(token)) return { code: token, message };
  // Эти коды бросает core (очередь исследования, обход, находки), поэтому сопоставляются по префиксу.
  if (/^(EXPLORER_BUSY|FINDING_NOT_CANDIDATE|FINDING_NOT_FOUND|FINDING_KIND_INVALID|SWEEP_SCOPE_REQUIRED)\b/.test(message)) {
    return { code: token || 'TOOL_FAILED', message };
  }
  if (message.includes('NOT_FOUND:')) return { code: 'NOT_FOUND', message };
  return { code: 'TOOL_FAILED', message };
}
