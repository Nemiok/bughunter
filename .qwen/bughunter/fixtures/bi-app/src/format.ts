/**
 * Форматирование проекций. Явная зона Europe/Moscow нужна, чтобы фикстура вела себя
 * одинаково на любой машине: иначе результаты приёмки зависели бы от часового пояса хоста.
 */

export const DISPLAY_TIME_ZONE = 'Europe/Moscow';

export function formatNumber(value: number): string {
  return value.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatAbbreviated(value: number): string {
  if (Math.abs(value) < 1000) return formatNumber(value);
  return `${(value / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}K`;
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Invalid Date';
  return date.toLocaleDateString('ru-RU', { timeZone: DISPLAY_TIME_ZONE });
}

export function formatShare(part: number, base: number): string {
  if (base === 0) return '—';
  return `${Math.round((part / base) * 100)}%`;
}

/** L4: округление до копеек — легальная трансформация, а не потеря точности. */
export function roundToCents(value: number): number {
  const shifted = Number(`${value}e2`);
  return Number(`${Math.round(shifted)}e-2`);
}
