/** Форматирование проекций. Легальные трансформации (§5.4) живут здесь же. */

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
  return date.toLocaleDateString('ru-RU');
}

export function formatShare(part: number, base: number): string {
  if (base === 0) return '—';
  return `${Math.round((part / base) * 100)}%`;
}
