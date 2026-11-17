import { createHash } from 'node:crypto';

import type { Check } from '@bughunter/core';

/**
 * Сигнатура кандидата-оракула с учётом `pointer`. Core хеширует только `kind`, `target`,
 * `expected` и цель, поэтому два jsonPath-оракула на одну цель с одинаковым ожиданием, но разными
 * указателями схлопнулись бы в один кандидат. Точка входа передаёт эту сигнатуру как `checkSignature`;
 * core склеивает её с сигнатурой симптома, если кандидат опирается на оба источника.
 */
export function nodeCheckSignature(check: Check & { pointer?: string }, target: string): string {
  const canonical = JSON.stringify([
    'check', check.kind, check.target, check.pointer ?? null, check.expected ?? null, target,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}
