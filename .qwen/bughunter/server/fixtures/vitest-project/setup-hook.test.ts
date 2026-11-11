import { beforeEach, expect, test } from 'vitest';

beforeEach(() => { throw new Error('setup hook exploded'); });

test('setup hook assertion', () => { expect(1).toBe(1); });
