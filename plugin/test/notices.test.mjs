import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { generateNotices } from '../notices.mjs';

test('notices contain sorted package versions, licenses and license texts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bh-notices-'));
  for (const [name, version, license, text] of [
    ['z-package', '2.0.0', 'Apache-2.0', 'Apache license text'],
    ['@scope/a-package', '1.0.0', 'MIT', 'MIT license text'],
  ]) {
    const dir = join(root, 'node_modules', name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version, license }));
    await writeFile(join(dir, 'LICENSE'), text);
  }
  const out = join(root, 'THIRD_PARTY_NOTICES.md');
  await generateNotices({ nodeModules: join(root, 'node_modules'), out });
  const result = await readFile(out, 'utf8');
  assert.ok(result.indexOf('@scope/a-package@1.0.0') < result.indexOf('z-package@2.0.0'));
  assert.match(result, /MIT license text/);
  assert.match(result, /Apache license text/);
});
