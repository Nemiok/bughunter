import type { Errors } from '@bughunter/core';

/**
 * Доменные коды веб-пресета: их бросает пресет, а точка входа распознаёт как код ошибки,
 * а не как общую аварию. Нейтральные коды core объявлены там, где их бросают.
 */
export const webDomainCodes = [
  'CHECK_INVALID',
  'DRAG_TARGET_REQUIRED',
  'PERSONA_UNKNOWN',
  'POINT_TARGET_UNRESOLVED',
  'SCREENS_STORE_CORRUPT',
  'SCREEN_NOT_FOUND',
  'SCROLL_INVALID',
  'TARGET_NOT_ALLOWED',
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

/** Ошибка, код которой точка входа обязана отдать модели как есть, а не как общую аварию. */
export class ToolError extends Error {}

/**
 * Код ошибки для модели. Свои коды пресета и переведённые нейтральные коды core проходят как есть,
 * неизвестная авария становится `TOOL_FAILED`: словарь пресета объявлен выше, а не в точке входа.
 */
export function errorCode(error: unknown): { code: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ToolError) return { code: error.message.split(':')[0] ?? 'TOOL_FAILED', message };
  if (message.startsWith('CONFIG_INVALID:') || message.startsWith('CONFIG_NOT_FOUND:')) {
    return { code: 'CONFIG_INVALID', message };
  }
  if (message === 'LIMIT_REACHED') return { code: 'LIMIT_REACHED', message };
  if (message === 'FORBIDDEN_ACTION' || message.startsWith('FORBIDDEN_ACTION:') || message === 'FORM_SUBMISSION_BLOCKED') {
    return { code: 'FORBIDDEN_ACTION', message };
  }
  if (message.startsWith('CANDIDATE_UNREPRODUCED:')) return { code: 'CANDIDATE_UNREPRODUCED', message };
  if (message.startsWith('RUN_INCOMPLETE:')) return { code: 'RUN_INCOMPLETE', message };
  if (/^LEASE_(REQUIRED|UNKNOWN|MISMATCH):/.test(message)) return { code: message.split(':')[0] ?? 'LEASE_UNKNOWN', message };
  const token = message.split(':')[0] ?? '';
  // Словарь пресета объявлен в его реестре: нейтральные коды core переводятся, свои проходят как есть.
  const translated = webErrors.codes[token];
  if (translated !== undefined) return { code: translated, message };
  if ((webDomainCodes as readonly string[]).includes(token)) return { code: token, message };
  // Эти коды бросает core (фасад сессии, обход, находки), поэтому сопоставляются по префиксу.
  if (/^(EXPLORER_BUSY|FINDING_NOT_CANDIDATE|FINDING_NOT_FOUND|FINDING_KIND_INVALID|SWEEP_SCOPE_REQUIRED|RESET_UNSUPPORTED|REPLAY_FAILED)\b/.test(message)) {
    return { code: token || 'TOOL_FAILED', message };
  }
  if (message.includes('NOT_FOUND:')) return { code: 'NOT_FOUND', message };
  if (message === 'NAVIGATION_NOT_ALLOWED' || message.startsWith('NAVIGATION_NOT_ALLOWED:') || message === 'FORBIDDEN_ORIGIN') {
    return { code: 'FORBIDDEN_ORIGIN', message };
  }
  return { code: 'TOOL_FAILED', message };
}
