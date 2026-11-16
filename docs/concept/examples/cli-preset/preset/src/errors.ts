import type { Errors } from '@bughunter/core';

/** Доменные коды CLI-пресета: их бросает пресет, точка входа отдаёт их модели как есть. */
export const cliDomainCodes = [
  'CHECK_INVALID',
  'COMMAND_NOT_FOUND',
  'EXECUTION_FAILED',
  'EXECUTION_TIMEOUT',
  'FORBIDDEN_ACTION',
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

export const cliErrors: Errors = {
  codes: {
    INVENTORY_EMPTY: 'COMMAND_NOT_FOUND',
    TARGETS_EMPTY: 'COMMAND_NOT_FOUND',
  },
};

export class ToolError extends Error {}

/** Код ошибки для модели: свои коды, переведённые коды core и `TOOL_FAILED` для аварий. */
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
  if (/^LEASE_(REQUIRED|UNKNOWN|MISMATCH):/.test(message)) {
    return { code: message.split(':')[0] ?? 'LEASE_UNKNOWN', message };
  }
  const token = message.split(':')[0] ?? '';
  const translated = cliErrors.codes[token];
  if (translated !== undefined) return { code: translated, message };
  if ((cliDomainCodes as readonly string[]).includes(token)) return { code: token, message };
  if (/^(EXPLORER_BUSY|FINDING_NOT_CANDIDATE|FINDING_NOT_FOUND|FINDING_KIND_INVALID|SWEEP_SCOPE_REQUIRED)\b/.test(message)) {
    return { code: token || 'TOOL_FAILED', message };
  }
  if (message.includes('NOT_FOUND:')) return { code: 'NOT_FOUND', message };
  return { code: 'TOOL_FAILED', message };
}
