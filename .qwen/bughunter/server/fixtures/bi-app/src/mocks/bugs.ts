import { formatDate } from '../format.ts';
import type { TableRow } from './seed.ts';

export type SeededKind = 'data' | 'legal' | 'behavior';

/**
 * `detectable` — чем баг находится сегодня: `signal` — существующим детектором,
 * `oracle` — только оракулом сверки данных (фаза 2), `none` — не находится ничем.
 */
export type SeededEntry = {
  kind: SeededKind;
  screen: string;
  widget?: string;
  expected: string;
  actual: string;
  detectable: 'signal' | 'oracle' | 'none';
};

export type SeededId =
  | 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6'
  | 'L1' | 'L2' | 'L3' | 'L4'
  | 'N1' | 'N2' | 'N3';

export const SEEDED: Record<SeededId, SeededEntry> = {
  D1: {
    kind: 'data', screen: '/dashboard/:id', widget: 'table',
    expected: 'Итого равен сумме строк таблицы', actual: 'Итого больше суммы строк на 10',
    detectable: 'oracle',
  },
  D2: {
    kind: 'data', screen: '/dashboard/:id', widget: 'kpi',
    expected: 'Средний чек 1 234,57 (округление half-up)', actual: 'Средний чек 1 234,56 (усечение)',
    detectable: 'oracle',
  },
  D3: {
    kind: 'data', screen: '/dashboard/:id',
    expected: 'Обновлён: 01.03.2026 (Europe/Moscow)', actual: 'Обновлён: 28.02.2026 (America/New_York)',
    detectable: 'oracle',
  },
  D4: {
    kind: 'data', screen: '/dashboard/:id', widget: 'line',
    expected: 'Фильтр региона применён ко всем виджетам экрана', actual: 'Таблица фильтруется, линейный график — нет',
    detectable: 'oracle',
  },
  D5: {
    kind: 'data', screen: '/dashboard/:id', widget: 'table',
    expected: 'Вторая страница таблицы продолжает первую без повторов', actual: 'Строка id 7 отдаётся повторно',
    detectable: 'oracle',
  },
  D6: {
    kind: 'data', screen: '/dashboard/:id', widget: 'kpi',
    expected: 'Доля 52% (база 1000)', actual: 'Доля 37% (база 1405 — все строки вместо отфильтрованных)',
    detectable: 'oracle',
  },
  L1: {
    kind: 'legal', screen: '/clean',
    expected: 'Сокращение 1,2K для 1234 допустимо', actual: '1,2K',
    detectable: 'none',
  },
  L2: {
    kind: 'legal', screen: '/clean',
    expected: 'Локальный формат 1 234,57 для 1234.5678 допустим', actual: '1 234,57',
    detectable: 'none',
  },
  L3: {
    kind: 'legal', screen: '/clean',
    expected: 'Дата 01.03.2026 для 2026-03-01T09:00:00+03:00 допустима', actual: '01.03.2026',
    detectable: 'none',
  },
  L4: {
    kind: 'legal', screen: '/clean',
    expected: 'Итог 2 400,00, округлённый до копеек, допустим', actual: '2 400,00',
    detectable: 'none',
  },
  N1: {
    kind: 'behavior', screen: '/settings',
    expected: 'Экспорт CSV сообщает об отсутствии данных', actual: 'Необработанное исключение при клике',
    detectable: 'signal',
  },
  N2: {
    kind: 'behavior', screen: '/dashboard/:id', widget: 'line',
    expected: 'При быстрой смене фильтра применяется ответ актуального фильтра', actual: 'Применяется устаревший ответ',
    detectable: 'signal',
  },
  N3: {
    kind: 'behavior', screen: '/wizard',
    expected: 'Повторная отправка отчёта заблокирована', actual: 'Два клика создают два отчёта, сигналов нет',
    detectable: 'none',
  },
};

/** D1: на сколько итог расходится с суммой строк. */
export const TOTAL_OFFSET = 10;

/** D2: значение KPI и два способа округления — требуемый и фактический. */
export const KPI_AVG_CHECK = 1234.565;

export function roundHalfUp(value: number, digits: number): number {
  // Сдвиг через строку: 1234.565 * 100 в double даёт 123456.49999…, и половина потерялась бы.
  const shifted = Number(`${value}e${digits}`);
  return Number(`${Math.round(shifted)}e-${digits}`);
}

export function truncateToCents(value: number): number {
  return Math.trunc(value * 100) / 100;
}

/** D3: зона, в которой приложение ошибочно форматирует дату. */
export const WRONG_TIME_ZONE = 'America/New_York';

export function formatDateWrongZone(iso: string): string {
  return new Date(iso).toLocaleDateString('ru-RU', { timeZone: WRONG_TIME_ZONE });
}

/** D6: доля считается от базы всех строк вместо отфильтрованных. */
export const SHARE = { part: 520, correctBase: 1000, usedBase: 1405 };

/** D5: вторая страница таблицы начинается со строки id 7, которая уже была на первой. */
export function duplicateOnSecondPage(rows: TableRow[]): TableRow[] {
  const duplicated = rows.find((row) => row.id === 7) ?? rows[0];
  if (duplicated === undefined) return [];
  const fresh = rows.slice(0, 5).map((row, index) => ({
    ...row,
    id: row.id + 100,
    label: `${row.label} (стр. 2)`,
  }));
  return [{ ...duplicated }, ...fresh];
}

/** Проверяет, что легальная трансформация действительно легальна: используется тестами фикстуры. */
export function legalTransformations(): Record<'L1' | 'L2' | 'L3' | 'L4', string> {
  return {
    L1: SEEDED.L1.actual,
    L2: SEEDED.L2.actual,
    L3: formatDate('2026-03-01T09:00:00+03:00'),
    L4: SEEDED.L4.actual,
  };
}
