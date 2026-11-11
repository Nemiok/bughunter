import { expect, it } from 'vitest';
import { validateOrder } from './App';

it('accepts a positive order quantity', () => {
  expect(validateOrder(2)).toBe(true);
});
