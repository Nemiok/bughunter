import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';

const sourceRoot = join(import.meta.dirname, '../src');

/**
 * Слова, которыми говорит пресет. В core их быть не должно: иначе второй пресет
 * не сможет переиспользовать ядро и будет править его под свой домен.
 */
const domainTokens = [
  'playwright', 'konva', 'three', 'msw', 'browser', 'chrome', 'dom', 'locator', 'viewport',
  'click', 'hover', 'scroll', 'screen', 'route', 'endpoint', 'http', 'e2e', 'spec',
];

const presetImportPatterns = [/from\s+'[^']*presets\//, /from\s+'@bughunter\/web/];

async function sourceFiles(): Promise<string[]> {
  const entries = await readdir(sourceRoot, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

async function sourceLines(): Promise<Array<{ location: string; line: string; text: string }>> {
  const files = await sourceFiles();
  const lines: Array<{ location: string; line: string; text: string }> = [];
  for (const file of files) {
    const contents = (await readFile(file, 'utf8')).split('\n');
    contents.forEach((text, index) => {
      lines.push({ location: `${relative(sourceRoot, file)}:${index + 1}`, line: String(index + 1), text });
    });
  }
  return lines;
}

test('core sources contain no domain lexicon', async () => {
  const violations: string[] = [];
  for (const { location, text } of await sourceLines()) {
    for (const token of domainTokens) {
      if (new RegExp(`\\b${token}\\b`, 'i').test(text)) violations.push(`${location}:${token}`);
    }
  }
  assert.deepEqual(violations, [], `доменная лексика в core (файл:строка:токен): ${violations.join(', ')}`);
});

test('core does not import presets', async () => {
  const violations: string[] = [];
  for (const { location, text } of await sourceLines()) {
    for (const pattern of presetImportPatterns) {
      if (pattern.test(text)) violations.push(`${location}: ${text.trim()}`);
    }
  }
  assert.deepEqual(violations, [], `core зависит от пресета: ${violations.join(' | ')}`);
});
