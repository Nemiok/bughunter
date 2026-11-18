import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

const projectRoot = join(import.meta.dirname, '../../../..');
const coreRoot = join(import.meta.dirname, '..');

/**
 * Восемь инструментов взаимодействия веб-пресета. Entry-скилл один на инструмент и
 * принадлежит core, поэтому имён пресета в нём нет: их называет карта пресета.
 */
const presetInteractionTools = [
  'bh_open', 'bh_state', 'bh_act', 'bh_navigate', 'bh_probe', 'bh_crawl', 'bh_sweep', 'bh_close',
];

async function skill(relativePath: string): Promise<{ frontmatter: string; body: string }> {
  const source = await readFile(join(projectRoot, relativePath), 'utf8');
  const match = source.match(/^---\n([\s\S]*?)\n---\n?/);
  assert.ok(match, `${relativePath}: frontmatter is required`);
  return { frontmatter: match[1], body: source.slice(match[0].length) };
}

test('the entry skill states the orchestration contract without naming preset tools', async () => {
  const { frontmatter, body } = await skill('.qwen/skills/bughunter/SKILL.md');
  assert.match(frontmatter, /^name: bughunter$/m);
  assert.match(frontmatter, /^disable-model-invocation: true$/m);

  // Оркестрация: один вызов на сообщение и цикл lease.
  assert.match(body, /ровно один tool\/agent вызов/i);
  assert.match(body, /без batch/i);
  assert.ok(body.includes('bh_explore_next'), 'lease cycle must name the queue tool');
  assert.ok(body.includes('leaseId'), 'lease cycle must pass the lease through');
  assert.ok(body.includes('Skill'), 'the entry skill must reach the preset card through Skill');

  for (const tool of presetInteractionTools) {
    assert.ok(!body.includes(tool), `entry skill names a preset tool: ${tool}`);
  }
});

test('canonical prompt sources carry no host-specific branches', async () => {
  // Хост-специфика живёт в plugin/hosts/ и рендерится в артефакты (это проверяют plugin-тесты).
  // Канонические промпты .qwen/ остаются хост-нейтральными: Kimi/Claude-веток в них быть не должно.
  const hostTokens = [
    'kimi', 'claude', 'mcp__plugin-', '.kimi-code', '.claude/',
    'KIMI_PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT', '/reload-plugins', 'plugins marketplace',
  ];
  const files: string[] = [];
  for (const directory of ['.qwen/skills', '.qwen/agents']) {
    for (const entry of await readdir(join(projectRoot, directory), { withFileTypes: true, recursive: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) files.push(join(entry.parentPath, entry.name));
    }
  }
  assert.ok(files.length >= 4, `canonical prompts not found: ${files.length} files`);
  for (const file of files) {
    const body = await readFile(file, 'utf8');
    for (const token of hostTokens) {
      assert.ok(
        !body.toLowerCase().includes(token.toLowerCase()),
        `host-specific token «${token}» in canonical prompt ${file}`,
      );
    }
  }
});

test('the contract skill names all sixteen interfaces', async () => {
  const source = await readFile(join(coreRoot, 'src/preset.ts'), 'utf8');
  const exported = [...source.matchAll(/^export type (\w+)/gm)].map((match) => match[1]);
  const presetType = source.match(/^export type Preset = \{([\s\S]*?)^\};/m);
  assert.ok(presetType, 'core/src/preset.ts must declare `export type Preset`');
  const interfaces = [...presetType[1].matchAll(/^\s+\w+: (\w+);/gm)]
    .map((match) => match[1])
    .filter((type) => exported.includes(type));
  assert.ok(
    interfaces.length >= 16,
    `parsing Preset gave ${interfaces.length} interfaces, expected at least 16`,
  );

  const { body } = await skill('.qwen/skills/bughunter-core-contract/SKILL.md');
  for (const name of interfaces) {
    assert.ok(body.includes(name), `contract skill does not name the interface: ${name}`);
  }
  assert.match(body, /ноль правок core/i);
  assert.match(body, /пять вопросов/i);
  const invariants = body.match(/^\d+\.\s/gm) ?? [];
  assert.ok(invariants.length >= 7, `contract skill states ${invariants.length} invariants, expected 7`);
});

test('the preset guide states the copy-the-example-depend-on-core rule', async () => {
  const { body } = await skill('.qwen/skills/bughunter-preset-guide/SKILL.md');
  assert.match(body, /пример копируй, core подключай/i);
  assert.match(body, /ноль правок core/i);
  assert.ok(body.includes('@bughunter/core'), 'the guide must depend on core by package name');
  assert.ok(body.includes('presets/web'), 'the guide must start from a copy of the example preset');
  // Автору пресета не нужны наши фикстуры: минимальное целевое приложение он берёт из гайда.
  assert.match(body, /минимальн/i);
  assert.ok(body.includes('```'), 'the guide must carry a copy-paste snippet of a target application');
});
