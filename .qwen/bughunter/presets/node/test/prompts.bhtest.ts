import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { NODE_PERSONAS } from '../src/personas.ts';
import { nodeCheckKinds } from '../src/checks.ts';

/**
 * Промпт-слой читается из дерева пакета, а не из `.qwen/`: живая установка автора остаётся
 * веб-пресетом, а раскладку в `.qwen/` собирает установщик.
 */
const presetRoot = join(import.meta.dirname, '..');
const finalResultInstruction = 'последнее сообщение — полный самостоятельный результат для вызывающего агента';

type Frontmatter = Record<string, string | string[]>;

function parseFrontmatter(source: string): { data: Frontmatter; body: string } {
  const match = source.match(/^---\n([\s\S]*?)\n---\n?/);
  assert.ok(match, 'frontmatter is required');
  const data: Frontmatter = {};
  let listKey: string | undefined;
  for (const line of match[1].split('\n')) {
    const item = line.match(/^  - (.+)$/);
    if (item) {
      assert.ok(listKey, `list item without a key: ${line}`);
      (data[listKey] as string[]).push(item[1]);
      continue;
    }
    const field = line.match(/^([A-Za-z][A-Za-z0-9-]*):(?: (.*))?$/);
    assert.ok(field, `unsupported frontmatter line: ${line}`);
    const [, key, value = ''] = field;
    if (value === '[]') data[key] = [];
    else data[key] = value;
    listKey = value === '' ? key : undefined;
    if (listKey) data[key] = [];
  }
  return { data, body: source.slice(match[0].length) };
}

async function readPrompt(relativePath: string): Promise<{ data: Frontmatter; body: string }> {
  return parseFrontmatter(await readFile(join(presetRoot, relativePath), 'utf8'));
}

const agents = {
  'bh-explorer': [
    'mcp__bughunter__bh_open',
    'mcp__bughunter__bh_state',
    'mcp__bughunter__bh_act',
    'mcp__bughunter__bh_report_candidate',
    'mcp__bughunter__bh_close',
    'Skill',
  ],
  'bh-reviewer': [
    'Read',
    'Grep',
    'Glob',
    'mcp__bughunter__bh_triage',
    'Skill',
  ],
  'bh-test-writer': [
    'Read',
    'Grep',
    'Glob',
    'Edit',
    'Write',
    'mcp__bughunter__bh_detect_tests',
    'mcp__bughunter__bh_export_test',
    'mcp__bughunter__bh_verify_red',
    'Skill',
  ],
} as const;

const agentNames = Object.keys(agents);

test('each agent declares its exact tool allowlist', async () => {
  for (const [name, tools] of Object.entries(agents)) {
    const { data } = await readPrompt(`agents/${name}.md`);
    assert.equal(data.name, name);
    assert.ok((data.description as string).length > 20, `${name}: description обязателен`);
    assert.deepEqual(data.tools, [...tools], `${name}: allowlist инструментов разошёлся`);
  }
});

test('every agent returns a self-contained final result and never edits application code', async () => {
  for (const name of agentNames) {
    const { body } = await readPrompt(`agents/${name}.md`);
    assert.ok(body.toLowerCase().includes(finalResultInstruction), `${name}: нет требования к итоговому сообщению`);
  }
  const writer = (await readPrompt('agents/bh-test-writer.md')).body;
  assert.match(writer, /Код приложения не меняй никогда/);
  assert.match(writer, /kind: api/);
  const reviewer = (await readPrompt('agents/bh-reviewer.md')).body;
  assert.match(reviewer, /presets\/node\/state\/runs\//);
  assert.match(reviewer, /bh_triage/);
});

test('agents invoke the shared core skills', async () => {
  const explorer = (await readPrompt('agents/bh-explorer.md')).body;
  assert.match(explorer, /bughunter-oracles/);
  assert.match(explorer, /bughunter-preset-card/);
  const reviewer = (await readPrompt('agents/bh-reviewer.md')).body;
  assert.match(reviewer, /bughunter-oracles/);
  const writer = (await readPrompt('agents/bh-test-writer.md')).body;
  assert.match(writer, /bughunter-red-test/);
});

test('the explorer knows the three node personas and the failure vocabulary', async () => {
  const { body } = await readPrompt('agents/bh-explorer.md');
  assert.deepEqual([...NODE_PERSONAS], ['интегратор', 'ревизор', 'нетерпеливый']);
  for (const persona of NODE_PERSONAS) {
    assert.ok(body.toLowerCase().includes(persona.toLowerCase()), `explorer не описывает персону: ${persona}`);
  }
  assert.match(body, /RETRY_LATER: EXPLORER_BUSY/);
  assert.match(body, /FAILED: <код ошибки>/);
  assert.match(body, /Кандидатов нет/);
  assert.match(body, /LIMIT_REACHED/);
});

test('the preset card lists exactly the five node interaction tools', async () => {
  const { body } = await readPrompt('skills/preset-card/SKILL.md');
  const section = body.match(/^## Инструменты пресета\n([\s\S]*?)(?=^## )/m);
  assert.ok(section, 'в карте нет раздела «Инструменты пресета»');
  const tokens = [...new Set(section[1].match(/\bbh_[a-z_]+\b/g) ?? [])].sort();
  assert.deepEqual(tokens, ['bh_act', 'bh_close', 'bh_open', 'bh_state', 'bh_sweep']);
  for (const retired of ['bh_crawl', 'bh_navigate', 'bh_probe', 'bh_export_e2e']) {
    assert.ok(!body.includes(retired), `карта упоминает чужой инструмент: ${retired}`);
  }
  assert.match(body, /## Кому принадлежат/);
  assert.match(body, /## Области прогона/);
});

test('the card names the check kinds and the pointer rule', async () => {
  const { body } = await readPrompt('skills/preset-card/SKILL.md');
  for (const kind of nodeCheckKinds) {
    assert.ok(body.includes(kind), `в карте нет вида check: ${kind}`);
  }
  assert.match(body, /METHOD|МЕТОД/);
  assert.match(body, /pointer/);
  assert.match(body, /CHECK_INVALID/);
  assert.match(body, /profile|профил/i);
  assert.match(body, /POST \/__reset|reset/i);
});
