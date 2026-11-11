import { test } from 'vitest';

test('broken outside assertion', () => { throw new Error('setup exploded'); });
