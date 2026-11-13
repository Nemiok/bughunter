import { expect, it } from 'vitest';
import { formatAbbreviated, formatDate, formatNumber, formatShare, roundToCents } from './format.ts';
import {
  KPI_AVG_CHECK, SEEDED, SHARE, TOTAL_OFFSET, WRONG_TIME_ZONE,
  duplicateOnSecondPage, formatDateWrongZone, roundHalfUp, truncateToCents,
} from './mocks/bugs.ts';
import { SEED_VERSION, dataset, reportSlug } from './mocks/seed.ts';
import { SCENARIOS } from './mocks/scenarios.ts';

it('dataset is deterministic between calls', () => {
  expect(dataset('normal')).toEqual(dataset('normal'));
});

it('every scenario is known and the seed version is dated', () => {
  expect(SCENARIOS).toEqual(['normal', 'latency', 'error500', 'empty', 'big']);
  expect(SEED_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
});

it('big scenario carries at least 5000 table rows', () => {
  expect(dataset('big').widgets.table.rows.length).toBeGreaterThanOrEqual(5000);
});

it('empty scenario has no rows anywhere', () => {
  const empty = dataset('empty');
  expect(empty.dashboards).toEqual([]);
  expect(empty.widgets.table.rows).toEqual([]);
  expect(empty.reports).toEqual([]);
});

it('normal scenario keeps 120 dashboards and 120 report slugs', () => {
  const normal = dataset('normal');
  expect(normal.dashboards).toHaveLength(120);
  expect(normal.reports).toHaveLength(120);
  expect(normal.reports.every((report) => /^r-[a-z0-9]+$/.test(report.slug))).toBe(true);
  expect(new Set(normal.reports.map((report) => report.slug)).size).toBe(120);
  expect(reportSlug(0)).toBe('r-001');
});

it('SEEDED registry holds six data bugs, four legal transforms and three behavioral bugs', () => {
  const entries = Object.entries(SEEDED);
  expect(entries).toHaveLength(13);
  const ofKind = (kind: string) => entries.filter(([, entry]) => entry.kind === kind);
  expect(ofKind('data')).toHaveLength(6);
  expect(ofKind('legal')).toHaveLength(4);
  expect(ofKind('behavior')).toHaveLength(3);
  for (const [id, entry] of entries) {
    expect(entry.screen.startsWith('/'), id).toBe(true);
    expect(entry.expected.length, id).toBeGreaterThan(0);
    expect(entry.actual.length, id).toBeGreaterThan(0);
    expect(['signal', 'oracle', 'none'], id).toContain(entry.detectable);
  }
});

it('every oracle-detectable bug names the oracle shape that catches it', () => {
  for (const [id, entry] of Object.entries(SEEDED)) {
    if (entry.detectable === 'oracle') {
      expect(['response', 'projection', 'request'], id).toContain(entry.oracle);
    } else {
      expect(entry.oracle, id).toBeUndefined();
    }
  }
  expect(SEEDED.D1.oracle).toBe('response');
  expect(SEEDED.D2.oracle).toBe('projection');
  expect(SEEDED.D3.oracle).toBe('projection');
  expect(SEEDED.D4.oracle).toBe('request');
  expect(SEEDED.D5.oracle).toBe('response');
  expect(SEEDED.D6.oracle).toBe('projection');
});

it('D1: dataset total does not equal the sum of its rows', () => {
  const table = dataset('normal').widgets.table;
  const sum = table.rows.reduce((total, row) => total + row.value, 0);
  expect(table.total).not.toBeCloseTo(sum, 2);
  expect(table.total - sum).toBeCloseTo(TOTAL_OFFSET, 2);
});

it('D2: truncation is used where half-up rounding is required', () => {
  expect(KPI_AVG_CHECK).toBe(1234.565);
  expect(roundHalfUp(KPI_AVG_CHECK, 2)).toBe(1234.57);
  expect(truncateToCents(KPI_AVG_CHECK)).toBe(1234.56);
});

it('D3: formatting in the wrong zone shifts the date by a day', () => {
  expect(formatDate('2026-03-01T00:00:00Z')).toBe('01.03.2026');
  expect(formatDateWrongZone('2026-03-01T00:00:00Z')).toBe('28.02.2026');
  expect(WRONG_TIME_ZONE).toBe('America/New_York');
});

it('D5: the second page repeats row id 7', () => {
  const rows = dataset('normal').widgets.table.rows;
  const secondPage = duplicateOnSecondPage(rows);
  const ids = secondPage.map((row) => row.id);
  expect(ids).toContain(7);
  expect(rows.map((row) => row.id)).toContain(7);
  expect(secondPage.length).toBe(6);
});

it('D6: the share is taken from the wrong base', () => {
  expect(SHARE.part / SHARE.correctBase).toBeCloseTo(0.52, 2);
  expect(SHARE.part / SHARE.usedBase).toBeCloseTo(0.37, 2);
  expect(`${Math.round((SHARE.part / SHARE.usedBase) * 100)}%`).toBe('37%');
});

it('D2/D6: the kpi response carries every value a projection oracle needs', () => {
  const kpi = dataset('normal').widgets.kpi;
  expect(kpi).toEqual({
    avgCheck: KPI_AVG_CHECK,
    paid: SHARE.part,
    regionRows: SHARE.correctBase,
    allRows: SHARE.usedBase,
  });
  // Расхождение обязано быть выводимым из этого же ответа, а не зашитым в компонент.
  expect(roundHalfUp(kpi.avgCheck, 2)).not.toBe(truncateToCents(kpi.avgCheck));
  expect(formatShare(kpi.paid, kpi.regionRows)).toBe('52%');
  expect(formatShare(kpi.paid, kpi.allRows)).toBe('37%');
  expect(dataset('empty').widgets.kpi).toEqual(kpi);
});

it('legal transformations are arithmetically correct, not bugs', () => {
  expect(formatAbbreviated(1234)).toMatch(/^1[.,]2K$/);
  expect(formatNumber(1234.5678).replace(/\s/g, ' ')).toBe('1 234,57');
  expect(formatDate('2026-03-01T09:00:00+03:00')).toBe('01.03.2026');
  expect(roundToCents(2400.004)).toBe(2400);
  expect(roundToCents(2400.006)).toBe(2400.01);
});
