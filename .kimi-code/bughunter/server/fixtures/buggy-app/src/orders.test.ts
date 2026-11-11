import { expect, it } from 'vitest';
import { calculateTotal } from './App';

it('sums known order amounts', () => {
  expect(calculateTotal([{ amount: 10 }, { amount: 15 }])).toBe(25);
});
