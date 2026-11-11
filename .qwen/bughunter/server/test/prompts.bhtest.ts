import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

const projectRoot = join(import.meta.dirname, '../../../..');
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
    'skill',
  ],
  'bh-reviewer': [
    'read_file',
    'grep_search',
    'glob',
    'mcp__bughunter__bh_triage',
    'skill',
  ],
  'bh-test-writer': [
    'read_file',
    'grep_search',
    'glob',
    'edit',
    'write_file',
    'mcp__bughunter__bh_detect_tests',
    'mcp__bughunter__bh_export_e2e',
    'mcp__bughunter__bh_verify_red',
    'skill',
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
    '$ARGUMENTS', 'diff', 'full', 'route <path>', 'resume <runId>',
    'bh_start_run', 'bh_resume_run', 'bh_explore_next', 'bh_reproduce', 'bh_finish_run',
    'agent', 'subagent_type', 'bh-explorer', 'bh-reviewer', 'bh-test-writer', 'leaseId',
    'run_in_background: false', 'не объединяй', 'не делегируй воспроизведение',
    'EXPLORER_BUSY', 'RUN_INCOMPLETE', 'pendingCandidates', 'RETRY_LATER',
  ]) assert.ok(body.toLowerCase().includes(required.toLowerCase()), `missing entry contract: ${required}`);
  const allowedLine = body.split('\n').find((line) => line.includes('Главному агенту разрешены только'));
  const forbiddenLine = body.split('\n').find((line) => line.includes('Запрещено напрямую вызывать'));
  assert.ok(allowedLine && forbiddenLine, 'binding main-agent allowlist and forbidden list are required');
  for (const tool of ['bh_start_run', 'bh_resume_run', 'bh_explore_next', 'bh_reproduce', 'bh_finish_run', 'agent']) {
    assert.ok(allowedLine.includes(tool), `main allowlist missing ${tool}`);
  }
  for (const tool of [
    'bh_open', 'bh_state', 'bh_act', 'bh_navigate', 'bh_probe', 'bh_report_candidate', 'bh_close',
    'bh_triage', 'bh_export_e2e', 'bh_detect_tests', 'bh_verify_red',
  ]) assert.ok(forbiddenLine.includes(tool), `main forbidden list missing ${tool}`);
  assert.match(body, /ровно один tool\/agent вызов/i);
  assert.match(body, /без batch/i);
  assert.match(body, /последовательно/i);
  assert.match(body, /run_in_background:\s*false/i);
  assert.match(body, /не открывай браузер/i);
  assert.match(body, /невоспроизвед/i);
  assert.match(body, /ничего не коммить/i);
});

const skills = {
  'bughunter-oracles': 'при исследовании страницы и разборе кандидатов в баги',
  'bughunter-red-test': 'при написании теста на найденный баг',
} as const;

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
  assert.ok(reviewer.includes('.qwen/bughunter/state/runs/'));
  assert.ok(writer.includes('bughunter-red-test'));
  assert.match(writer, /не более (?:чем )?(?:за )?(?:3|тр[её]х)/i);
  assert.match(writer, /код приложения не (?:меняй|изменяй)/i);
});

test('explorer requires a lease and never reports a failed exploration as clean', async () => {
  const explorer = (await readPrompt('.qwen/agents/bh-explorer.md')).body;
  assert.ok(explorer.includes('leaseId'), 'explorer must receive and pass leaseId');
  assert.match(explorer, /RETRY_LATER: EXPLORER_BUSY/);
  assert.match(explorer, /FAILED: /);
  assert.match(explorer, /не чистый маршрут/);
  assert.match(explorer, /никогда вместо них `Кандидатов нет`/);
});
