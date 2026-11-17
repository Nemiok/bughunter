import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { EXPLORER_PERSONAS } from '../src/personas.ts';

const projectRoot = join(import.meta.dirname, '../../../../..');
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
  return parseFrontmatter(await readFile(join(projectRoot, relativePath), 'utf8'));
}

const agents = {
  'bh-explorer': [
    'mcp__bughunter__bh_open',
    'mcp__bughunter__bh_state',
    'mcp__bughunter__bh_act',
    'mcp__bughunter__bh_navigate',
    'mcp__bughunter__bh_probe',
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

for (const [name, tools] of Object.entries(agents)) {
  test(`${name} declares its exact standalone agent contract`, async () => {
    const { data, body } = await readPrompt(`.qwen/agents/${name}.md`);
    assert.equal(data.name, name);
    assert.equal(typeof data.description, 'string');
    assert.ok((data.description as string).trim().length > 0);
    assert.deepEqual(data.tools, tools);
    assert.equal(data.subagents, undefined);
    assert.equal(data.model, undefined);
    assert.equal(data.override, undefined);
    assert.ok(!body.includes('${base_prompt}'));
    assert.match(body, new RegExp(finalResultInstruction, 'i'));
  });
}

test('entry skill is manual, argument-driven, and orchestrates the complete run', async () => {
  const { data, body } = await readPrompt('.qwen/skills/bughunter/SKILL.md');
  assert.equal(data.name, 'bughunter');
  assert.equal(typeof data.description, 'string');
  assert.ok((data.description as string).trim().length > 0);
  assert.equal(data['disable-model-invocation'], 'true');
  assert.equal(data.model, undefined);
  assert.equal(data.override, undefined);
  for (const required of [
    '$ARGUMENTS', 'diff', 'full', 'target <path>', 'resume <runId>',
    'bh_start_run', 'bh_resume_run', 'bh_explore_next', 'bh_reproduce', 'bh_finish_run',
    'Agent', 'subagent_type', 'bh-explorer', 'bh-reviewer', 'bh-test-writer', 'leaseId',
    'run_in_background: false', 'не объединяй', 'не делегируй воспроизведение',
    'EXPLORER_BUSY', 'RUN_INCOMPLETE', 'pendingCandidates', 'RETRY_LATER',
  ]) assert.ok(body.toLowerCase().includes(required.toLowerCase()), `missing entry contract: ${required}`);
  const allowedLine = body.split('\n').find((line) => line.includes('Главному агенту разрешены только'));
  const forbiddenLine = body.split('\n').find((line) => line.includes('Запрещено напрямую вызывать'));
  assert.ok(allowedLine && forbiddenLine, 'binding main-agent allowlist and forbidden list are required');
  for (const tool of ['bh_start_run', 'bh_resume_run', 'bh_explore_next', 'bh_reproduce', 'bh_finish_run', 'Agent']) {
    assert.ok(allowedLine.includes(tool), `main allowlist missing ${tool}`);
  }
  for (const tool of [
    'bh_report_candidate', 'bh_triage', 'bh_export_test', 'bh_detect_tests', 'bh_verify_red',
  ]) assert.ok(forbiddenLine.includes(tool), `main forbidden list missing ${tool}`);
  // Словарь пресета entry-скилл не называет: он отправляет главного агента в карту пресета.
  assert.ok(body.includes('bughunter-preset-card'), 'entry skill must send the main agent to the preset card');
  assert.match(body, /ровно один tool\/agent вызов/i);
  assert.match(body, /без batch/i);
  assert.match(body, /последовательно/i);
  assert.match(body, /run_in_background:\s*false/i);
  assert.match(body, /не открывай сессию/i);
  assert.match(body, /невоспроизвед/i);
  assert.match(body, /ничего не коммить/i);
});

const skills = {
  'bughunter-oracles': 'при исследовании цели и разборе кандидатов в баги',
  'bughunter-red-test': 'при написании теста на найденный баг',
} as const;

test('oracles name multiplicity and idempotency as a checkable invariant class', async () => {
  const { body } = await readPrompt('.qwen/skills/bughunter-oracles/SKILL.md');
  for (const required of ['идемпотентн', 'кратност', 'одно действие', 'дублир', 'check', 'без сигнала']) {
    assert.ok(body.toLowerCase().includes(required.toLowerCase()), `missing oracle rule: ${required}`);
  }
});

for (const [name, whenToUse] of Object.entries(skills)) {
  test(`${name} declares its exact skill metadata`, async () => {
    const { data } = await readPrompt(`.qwen/skills/${name}/SKILL.md`);
    assert.equal(data.name, name);
    assert.equal(typeof data.description, 'string');
    assert.ok((data.description as string).trim().length > 0);
    assert.equal(data.whenToUse, whenToUse);
    assert.equal(data.model, undefined);
    assert.equal(data.override, undefined);
  });
}

test('agents invoke their reusable skills and reviewer/writer keep their boundaries', async () => {
  const explorer = (await readPrompt('.qwen/agents/bh-explorer.md')).body;
  const reviewer = (await readPrompt('.qwen/agents/bh-reviewer.md')).body;
  const writer = (await readPrompt('.qwen/agents/bh-test-writer.md')).body;
  assert.ok(explorer.includes('bughunter-oracles'));
  assert.ok(reviewer.includes('.qwen/bughunter/presets/web/state/runs/'));
  assert.ok(writer.includes('bughunter-red-test'));
  assert.match(writer, /не более (?:чем )?(?:за )?(?:3|тр[её]х)/i);
  assert.match(writer, /код приложения не (?:меняй|изменяй)/i);
});

test('explorer requires a lease and never reports a failed exploration as clean', async () => {  const explorer = (await readPrompt('.qwen/agents/bh-explorer.md')).body;
  assert.ok(explorer.includes('leaseId'), 'explorer must receive and pass leaseId');
  assert.match(explorer, /RETRY_LATER: EXPLORER_BUSY/);
  assert.match(explorer, /FAILED: /);
  assert.match(explorer, /не чистый маршрут/);
  assert.match(explorer, /никогда вместо них `Кандидатов нет`/);
});

test('entry skill offers deterministic scopes and the explorer knows the extended action set', async () => {
  const entry = (await readPrompt('.qwen/skills/bughunter/SKILL.md')).body;
  const entryLower = entry.toLowerCase();
  for (const required of ['sweep <template>', 'sweep', 'bh_promote_finding', 'не расходуй модель', 'FINDING_NOT_CANDIDATE', 'инвентар']) {
    assert.ok(entryLower.includes(required.toLowerCase()), `missing entry scope contract: ${required}`);
  }
  const allowedLine = entry.split('\n').find((line) => line.includes('Главному агенту разрешены только'));
  assert.ok(allowedLine, 'binding main-agent allowlist is required');
  assert.ok(allowedLine!.includes('bh_promote_finding'), 'main allowlist missing bh_promote_finding');

  const explorer = (await readPrompt('.qwen/agents/bh-explorer.md')).body.toLowerCase();
  for (const required of ['структура экрана', 'drag', 'scroll', 'clickat', 'hoverat', 'upload', 'cursor', 'totalvisible', 'точк']) {
    assert.ok(explorer.includes(required), `missing explorer capability: ${required}`);
  }
});

/** Восемь инструментов взаимодействия веб-пресета (спецификация 6.4). */
const webInteractionTools = ['bh_open', 'bh_state', 'bh_act', 'bh_navigate', 'bh_probe', 'bh_crawl', 'bh_sweep', 'bh_close'];

test('the preset card lists exactly the eight web interaction tools', async () => {
  const { data, body } = await readPrompt('.qwen/skills/bughunter-preset-card/SKILL.md');
  assert.equal(data.name, 'bughunter-preset-card');
  assert.ok((data.description as string).trim().length > 0);
  assert.equal(data.model, undefined);
  assert.equal(data.override, undefined);

  const tools = body.split(/^## /m).find((section) => section.startsWith('Инструменты пресета'));
  assert.ok(tools, 'preset card needs an «Инструменты пресета» section');
  const listed = [...new Set([...tools.matchAll(/\b(bh_[a-z_]+)\b/g)].map((match) => match[1]))].sort();
  assert.deepEqual(listed, [...webInteractionTools].sort());

  // Обход — главный агент, взаимодействие — субагент: карта единственная называет имена.
  const sweepLine = body.split('\n').find((line) => line.includes('bh_crawl') && line.includes('bh_sweep'));
  assert.ok(sweepLine && /главн/i.test(sweepLine), 'the card must give the deterministic sweep tools to the main agent');
  const explorerLine = body.split('\n').find((line) => line.includes('bh-explorer'));
  assert.ok(explorerLine, 'the card must bind the interaction tools to bh-explorer');
  for (const tool of ['bh_open', 'bh_state', 'bh_act', 'bh_navigate', 'bh_probe', 'bh_close']) {
    assert.ok(explorerLine!.includes(tool), `explorer-only line missing ${tool}`);
  }

  // Области прогона и словарь check — тоже пресетные.
  for (const required of ['diff', 'full', 'target', 'sweep', 'resume', 'state/screens.json', ':id']) {
    assert.ok(body.includes(required), `preset card missing scope or inventory detail: ${required}`);
  }
  for (const kind of ['visibleText', 'notVisibleText', 'elementCount']) {
    assert.ok(body.includes(kind), `preset card missing check kind: ${kind}`);
  }
  assert.match(body, /elementCount\.target/);
  assert.match(body, /text=/);
});

test('explorer defines the behaviour of every server-side persona', async () => {
  const explorer = (await readPrompt('.qwen/agents/bh-explorer.md')).body.toLowerCase();
  assert.ok(EXPLORER_PERSONAS.length > 0);
  for (const persona of EXPLORER_PERSONAS) {
    assert.ok(explorer.includes(persona.toLowerCase()), `explorer does not define persona: ${persona}`);
  }
  for (const behaviour of ['dblclick', 'reload', 'back', 'query-параметры', 'отрицательные', 'bh_probe']) {
    assert.ok(explorer.includes(behaviour.toLowerCase()), `missing persona behaviour: ${behaviour}`);
  }
});

test('prompts do not mention the retired tool name', async () => {
  const files: string[] = [];
  for (const directory of ['.qwen/skills', '.qwen/agents']) {
    for (const entry of await readdir(join(projectRoot, directory), { withFileTypes: true, recursive: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) files.push(join(entry.parentPath, entry.name));
    }
  }
  assert.ok(files.length >= 4, `промпты не найдены: ${files.length} файл(ов)`);
  for (const file of files) {
    assert.ok(!(await readFile(file, 'utf8')).includes('bh_export_e2e'), `устаревшее имя инструмента в ${file}`);
  }
});
