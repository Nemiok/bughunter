import { expect, it } from 'vitest';
import { SEED_VERSION, dataset } from './mocks/seed.ts';
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
});
