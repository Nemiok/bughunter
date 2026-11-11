import { expect, test } from 'vitest';
import './missing-module.ts';

test('missing import', () => { expect(1).toBe(1); });
