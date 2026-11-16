import { createHash } from 'node:crypto';

import type { Check } from '@bughunter/core';

export type CliCheck = Check & { kind: string; pointer?: string };

/**
 * Сигнатура оракула с учётом `pointer`: core хеширует только `kind`, `target` и `expected`,
 * поэтому два `stdoutOccurrences` с разными иглами схлопнулись бы в один кандидат.
 */
export function cliCheckSignature(check: CliCheck, target: string): string {
  const canonical = JSON.stringify([
    'check', check.kind, check.target, check.pointer ?? null, check.expected ?? null, target,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}
