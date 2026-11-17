import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';

const sourceRoot = join(import.meta.dirname, '../src');
const testRoot = import.meta.dirname;

/**
 * Слова, которыми говорит пресет. В core их быть не должно: иначе второй пресет
 * не сможет переиспользовать ядро и будет править его под свой домен.
 * Формы заданы шаблонами: лексика протекает и в косвенных формах («endpoints», «навигация»).
 */
const domainLexicon = [
  'playwright', 'konva', 'three', 'msw', 'browsers?', 'chrome', 'dom', 'locators?', 'viewports?',
  'clicks?', 'hovers?', 'scrolls?', 'screens?', 'routes?', 'endpoints?', 'https?', 'e2e', 'specs?',
  'navigat[a-z]*', 'probes?', 'urls?', 'widgets?',
];
const domainStems = [
  'маршрут[а-яё]*', 'эндпоинт[а-яё]*', 'браузер[а-яё]*', 'виджет[а-яё]*',
  'навигац[а-яё]*', 'страниц[а-яё]*', 'клик[а-яё]*', 'веб[а-яё-]*',
  'экран(?:а|у|ом|е|ы|ов|ам|ами|ах|ный|ная|ное|ные|ных)?',
];

const presetImportPatterns = [/from\s+'[^']*presets\//, /from\s+'@bughunter\/web/];

/**
 * Совместимость с записанным состоянием прежней схемы: core обязан узнать эти имена, чтобы
 * прочитать старый прогон или отвергнуть его. Это не знание домена, поэтому строки с маркером
 * `legacy-envelope` и миграционный guard исключены из лексиконной проверки.
 */
const legacySchemaGuard = /const retiredRunFields =|legacy-envelope/;

/** Оракулы и виды проверок принадлежат пресету: core-тесты не должны закреплять их имена. */
const presetCheckKindPattern = /\bkind:\s*'(?:status|jsonPath|headerContains|pointer|visibleText|elementCount)'/;

async function linesUnder(root: string): Promise<Array<{ location: string; text: string }>> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  const lines: Array<{ location: string; text: string }> = [];
  for (const file of entries.filter((entry) => entry.isFile() && entry.name.endsWith('.ts')).map((entry) => join(entry.parentPath, entry.name))) {
    const contents = (await readFile(file, 'utf8')).split('\n');
    contents.forEach((text, index) => lines.push({ location: `${relative(root, file)}:${index + 1}`, text }));
  }
  return lines;
}

function mentions(text: string, pattern: string): boolean {
  return new RegExp(`(?<![a-zа-яё])(?:${pattern})(?![a-zа-яё])`, 'i').test(text);
}

test('core sources contain no domain lexicon', async () => {
  const violations: string[] = [];
  for (const { location, text } of await linesUnder(sourceRoot)) {
    if (legacySchemaGuard.test(text)) continue;
    for (const pattern of [...domainLexicon, ...domainStems]) {
      if (mentions(text, pattern)) violations.push(`${location}:${pattern}`);
    }
  }
  assert.deepEqual(violations, [], `доменная лексика в core (файл:строка:токен): ${violations.join(', ')}`);
});

test('core does not import presets', async () => {
  const violations: string[] = [];
  for (const { location, text } of await linesUnder(sourceRoot)) {
    for (const pattern of presetImportPatterns) {
      if (pattern.test(text)) violations.push(`${location}: ${text.trim()}`);
    }
  }
  assert.deepEqual(violations, [], `core зависит от пресета: ${violations.join(' | ')}`);
});

test('core tests do not pin preset check kinds', async () => {
  const violations: string[] = [];
  for (const { location, text } of await linesUnder(testRoot)) {
    if (location.startsWith('boundary.bhtest.ts')) continue;
    if (presetCheckKindPattern.test(text)) violations.push(location);
  }
  assert.deepEqual(violations, [], `имена оракулов пресета закреплены в core-тестах: ${violations.join(', ')}`);
});
