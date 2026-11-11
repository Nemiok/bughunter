import { expect, test } from 'vitest';
import { sum } from './sum.ts';

test('adds two numbers', () => {
  expect(sum(1, 2)).toBe(3);
});
