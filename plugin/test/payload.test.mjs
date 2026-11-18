import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { copyPresets } from '../payload.mjs';

test('preset copy keeps presets when an ancestor directory is named state, test or node_modules', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bh-payload-'));
  // Adversarial ancestor names: the copy filter must decide on the path
  // relative to presets/, never on absolute path segments.
  const presets = join(root, 'state', 'test', 'node_modules', 'workspace', 'presets');
  await mkdir(join(presets, 'web', 'src'), { recursive: true });
  await writeFile(join(presets, 'web', 'src', 'preset.ts'), 'export {}\n');
  await mkdir(join(presets, 'node', 'src'), { recursive: true });
  await writeFile(join(presets, 'node', 'src', 'preset.ts'), 'export {}\n');
  await mkdir(join(presets, 'web', 'state', 'runs'), { recursive: true });
  await writeFile(join(presets, 'web', 'state', 'runs', 'run.json'), '{}\n');
  await mkdir(join(presets, 'web', 'node_modules'), { recursive: true });
  await writeFile(join(presets, 'web', 'node_modules', 'dep.js'), 'module.exports = {}\n');
  await mkdir(join(presets, 'web', 'test'), { recursive: true });
  await writeFile(join(presets, 'web', 'test', 'preset.bhtest.ts'), 'export {}\n');

  const target = join(root, 'out');
  await copyPresets(presets, target);

  assert.ok(existsSync(join(target, 'web', 'src', 'preset.ts')), 'web preset source must be retained');
  assert.ok(existsSync(join(target, 'node', 'src', 'preset.ts')), 'node preset source must be retained');
  assert.ok(!existsSync(join(target, 'web', 'state')), 'preset runtime state must stay out of the payload');
  assert.ok(!existsSync(join(target, 'web', 'node_modules')), 'preset dependencies must stay out of the payload');
  assert.ok(!existsSync(join(target, 'web', 'test')), 'preset tests must stay out of the payload');
});
