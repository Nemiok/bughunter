import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeMessage, signalSignature } from '../src/signature.ts';

test('normalization replaces numbers, UUIDs, URL query values, and whitespace', () => {
  assert.equal(
    normalizeMessage('  Order 42 for 550e8400-e29b-41d4-a716-446655440000 failed at /orders/42?page=2&q=abc\nagain  '),
    'Order <number> for <uuid> failed at /orders/<number>?page=<value>&q=<value> again',
  );
});

test('normalization replaces numbers embedded in dynamic identifiers', () => {
  assert.equal(normalizeMessage('Missing orderABC123 in chunk456.js'), 'Missing orderABC<number> in chunk<number>.js');
});

test('signatures ignore dynamic IDs but include signal type and top stack frame', () => {
  const first = signalSignature({
    kind: 'pageerror',
    message: 'Order 42 failed for 550e8400-e29b-41d4-a716-446655440000',
    target: '/orders/42',
    stack: 'Error: Order 42 failed\n    at save (/app.js:10:2)\n    at click (/app.js:20:3)',
  });
  const changedIds = signalSignature({
    kind: 'pageerror',
    message: 'Order 99 failed for 123e4567-e89b-42d3-a456-426614174000',
    target: '/orders/99',
    stack: 'Error: Order 99 failed\n    at save (/app.js:10:2)\n    at other (/other.js:30:4)',
  });
  assert.equal(first, changedIds);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, signalSignature({
    kind: 'console',
    message: 'Order 42 failed for 550e8400-e29b-41d4-a716-446655440000',
    target: '/orders/42',
    stack: 'Error: Order 42 failed\n    at save (/app.js:10:2)',
  }));
  assert.notEqual(first, signalSignature({
    kind: 'pageerror',
    message: 'Order 42 failed for 550e8400-e29b-41d4-a716-446655440000',
    target: '/orders/42',
    stack: 'Error: Order 42 failed\n    at submit (/app.js:10:2)',
  }));
});
