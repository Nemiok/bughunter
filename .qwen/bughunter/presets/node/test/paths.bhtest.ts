import assert from 'node:assert/strict';
import { isAbsolute, join } from 'node:path';
import { test } from 'node:test';

import { defaultStateDir } from '../src/paths.ts';

test('состояние node-пресета живёт внутри его пакета, а не в проекте приложения', () => {
  assert.ok(isAbsolute(defaultStateDir), defaultStateDir);
  assert.ok(defaultStateDir.endsWith(join('presets', 'node', 'state')), defaultStateDir);
});
