import { test } from 'vitest';

test('never completes', () => new Promise(() => {}));
