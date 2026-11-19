import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { qwenHost } from '../hosts/qwen.mjs';
import { kimiHost } from '../hosts/kimi.mjs';
import { renderPromptLayer } from '../prompts.mjs';

const repoRoot = resolve(import.meta.dirname, '../..');

async function entryFor(host) {
  const out = await mkdtemp(join(tmpdir(), `bh-prompt-${host.id}-`));
  await renderPromptLayer({
    host,
    source: join(repoRoot, '.qwen'),
    workspace: join(repoRoot, '.qwen', 'bughunter'),
    out,
  });
  return readFile(join(out, 'skills', 'bughunter', 'SKILL.md'), 'utf8');
}

test('qwen entry configures before one explicit restart', async () => {
  const entry = await entryFor(qwenHost);
  assert.match(entry, /disable-model-invocation: false/);
  assert.ok(entry.includes('setup-cli.mjs'));
  assert.ok(entry.includes('--action validate'));
  assert.ok(entry.includes('перезапуск qwen'));
  assert.ok(entry.includes('project/config'));
  assert.ok(entry.includes('19 web или 16 node tools'));
  assert.ok(!entry.includes('/plugins reload'));
  assert.ok(entry.indexOf('перезапуск qwen') < entry.indexOf('bh_start_run'));
  assert.ok(!entry.includes('попроси заполнить config'));
  assert.ok(!entry.includes('покажи путь оператору и остановись'));
});

test('dormant hosts retain bh_setup fallback', async () => {
  const entry = await entryFor(kimiHost);
  assert.match(entry, /disable-model-invocation: false/);
  assert.ok(entry.includes('mcp__plugin-bughunter_bughunter__bh_setup'));
  assert.ok(entry.includes('/reload'));
});
