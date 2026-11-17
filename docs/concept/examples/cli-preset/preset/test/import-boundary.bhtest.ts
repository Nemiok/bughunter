import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';

import { presetRoot } from './harness.ts';

const importPattern = /\b(?:from|import)\s*(?:\(\s*)?['"]([^'"]+)['"]/g;

function isForbiddenImport(
  specifier: string,
  importer = join(presetRoot, 'src', 'index.ts'),
): boolean {
  if (specifier.startsWith('@bughunter/')) {
    return specifier !== '@bughunter/core' && !specifier.startsWith('@bughunter/core/');
  }
  if (!specifier.startsWith('.')) return false;
  if (specifier.split('/').includes('presets')) return true;
  const outside = relative(presetRoot, resolve(dirname(importer), specifier));
  return outside === '..' || outside.startsWith(`..${sep}`);
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry): Promise<string[]> => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && /\.[cm]?ts$/.test(entry.name) ? [path] : [];
  }));
  return nested.flat();
}

test('the import boundary rejects other presets and accepts core and local modules', () => {
  for (const specifier of [
    '../../web/src/preset.ts',
    '../../web/src/index.ts',
    '../../presets/web/src/preset.ts',
    '@bughunter/web',
    '@bughunter/node/src/index.ts',
  ]) {
    assert.equal(isForbiddenImport(specifier), true, specifier);
  }
  for (const specifier of [
    '@bughunter/core',
    '@bughunter/core/preset.ts',
    './preset.ts',
    './session.ts',
    '../shared/types.ts',
    'node:fs',
    'zod',
  ]) {
    assert.equal(isForbiddenImport(specifier), false, specifier);
  }
});

test('the preset sources do not import another preset', async () => {
  const files = await sourceFiles(join(presetRoot, 'src'));
  assert.ok(files.length > 0, 'src must contain TypeScript sources');
  const violations: string[] = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(importPattern)) {
      if (isForbiddenImport(match[1], file)) violations.push(`${file}: ${match[1]}`);
    }
  }
  assert.deepEqual(violations, []);
});
