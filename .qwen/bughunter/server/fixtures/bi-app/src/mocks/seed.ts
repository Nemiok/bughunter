import { TOTAL_OFFSET } from './bugs.ts';
import type { ScenarioName } from './scenarios.ts';

export const SEED_VERSION = '2026-11-12.1';

export type TableRow = { id: number; label: string; region: string; value: number };
export type Dashboard = { id: number; title: string; owner: string; updatedAt: string };
export type ReportMeta = { slug: string; title: string };

export type Dataset = {
  dashboards: Dashboard[];
  reports: ReportMeta[];
  widgets: {
    table: { rows: TableRow[]; total: number };
    line: { points: Array<{ month: string; revenue: number }> };
    bars: { bars: Array<{ month: string; value: number }> };
    scene: { objects: Array<{ name: string; value: number }> };
  };
};

const REGIONS = ['ural', 'siberia', 'northwest', 'south'];
const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const OWNERS = ['Иванова', 'Петров', 'Сидорова', 'Кузнецов'];
const DASHBOARD_COUNT = 120;
const REPORT_COUNT = 120;
const NORMAL_ROWS = 12;
const BIG_ROWS = 5000;

/** Детерминированный ГПСЧ: датасет обязан совпадать между вызовами и между прогонами. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function reportSlug(index: number): string {
  return `r-${(index + 1).toString(36).padStart(3, '0')}`;
}

export function dataset(scenario: ScenarioName): Dataset {
  const random = prng(20261112);
  const empty = scenario === 'empty';
  const dashboards: Dashboard[] = empty
    ? []
    : Array.from({ length: DASHBOARD_COUNT }, (_, index) => ({
      id: index + 1,
      title: `Дашборд ${index + 1}`,
      owner: OWNERS[index % OWNERS.length]!,
      // D3: у первого дашборда дата намеренно на границе суток в UTC —
      // форматирование в неверной зоне сдвигает её на день назад.
      updatedAt: index === 0 ? '2026-03-01T00:00:00Z' : `2026-0${(index % 9) + 1}-1${index % 9}T10:00:00Z`,
    }));
  const reports: ReportMeta[] = empty
    ? []
    : Array.from({ length: REPORT_COUNT }, (_, index) => ({
      slug: reportSlug(index),
      title: `Отчёт ${reportSlug(index)}`,
    }));

  const rowCount = empty ? 0 : scenario === 'big' ? BIG_ROWS : NORMAL_ROWS;
  const rows: TableRow[] = Array.from({ length: rowCount }, (_, index) => ({
    id: index + 1,
    label: `Позиция ${index + 1}`,
    region: REGIONS[index % REGIONS.length]!,
    value: Math.round(random() * 100000) / 100,
  }));
  const total = rows.length === 0
    ? 0
    // D1: итог расходится с суммой строк на фиксированную величину — баг живёт в данных,
    // а не в рендере, поэтому его видно и в ответе API, и в проекции виджета.
    : Math.round((rows.reduce((sum, row) => sum + row.value, 0) + TOTAL_OFFSET) * 100) / 100;

  const months = MONTHS.map((month) => ({ month, value: Math.round(random() * 90000) / 100 }));
  return {
    dashboards,
    reports,
    widgets: {
      table: { rows, total },
      line: { points: months.map(({ month, value }) => ({ month, revenue: value })) },
      bars: { bars: months.map(({ month, value }) => ({ month, value })) },
      scene: { objects: months.slice(0, 6).map(({ month, value }) => ({ name: month, value })) },
    },
  };
}
