import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';

const packageRoot = join(import.meta.dirname, '..');
const coreSource = join(packageRoot, 'src');
const presetsRoot = join(packageRoot, '..', 'presets');

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name));
}

async function presetSourceRoots(): Promise<string[]> {
  const entries = await readdir(presetsRoot, { withFileTypes: true });
  const roots: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const root = join(presetsRoot, entry.name, 'src');
    if ((await stat(root).catch(() => undefined)) !== undefined) roots.push(root);
  }
  return roots;
}

/** Имена интерфейсов, из которых собран `Preset`: тот же разбор, что в `prompts-core.bhtest.ts`. */
function contractInterfaces(source: string): string[] {
  const exported = [...source.matchAll(/^export type (\w+)/gm)].map((match) => match[1]!);
  const declaration = source.match(/^export type Preset = \{([\s\S]*?)^\};/m);
  assert.ok(declaration, 'в core/src/preset.ts нет `export type Preset`');
  return [...declaration[1]!.matchAll(/^\s+\w+: (\w+);/gm)]
    .map((match) => match[1]!)
    .filter((name) => exported.includes(name));
}

test('every contract hook has a consumer', async () => {
  const interfaces = contractInterfaces(await readFile(join(coreSource, 'preset.ts'), 'utf8'));
  assert.ok(interfaces.length >= 16, `разобрано интерфейсов контракта: ${interfaces.length}`);

  const roots = [coreSource, ...await presetSourceRoots()];
  const files = (await Promise.all(roots.map(sourceFiles))).flat()
    // Файл сборки перечисляет все имена по определению: потребитель ищется вне него.
    .filter((file) => !file.endsWith(`${sep}preset.ts`));
  assert.ok(files.length > 0, 'не найдено ни одного исходника core или пресетов');

  const sources = await Promise.all(files.map((file) => readFile(file, 'utf8')));
  const orphans = interfaces.filter((name) => !sources.some((source) => new RegExp(`\\b${name}\\b`).test(source)));
  assert.deepEqual(orphans, [], `интерфейсы контракта без потребителя: ${orphans.join(', ')}`);
});

test('shipped presets wire every hook of the contract', async () => {
  const roots = await presetSourceRoots();
  const assemblyFiles: string[] = [];
  for (const root of roots) {
    const file = join(root, 'preset.ts');
    if (await stat(file).catch(() => undefined)) assemblyFiles.push(file);
  }
  assert.ok(assemblyFiles.length >= 1, 'не найден ни один presets/*/src/preset.ts');

  const offenders: string[] = [];
  for (const file of assemblyFiles) {
    const lines = (await readFile(file, 'utf8')).split('\n');
    lines.forEach((line, index) => {
      if (line.includes('pending(') || line.includes('PRESET_HOOK_NOT_WIRED')) {
        offenders.push(`${relative(packageRoot, file)}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `заглушки в поставляемом пресете:\n${offenders.join('\n')}`);
});
