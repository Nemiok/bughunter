import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { errorCode, ToolError } from '../src/errors.ts';

const projectRoot = join(import.meta.dirname, '../../../../..');

test('a target outside the inventory keeps its own code instead of degrading to TOOL_FAILED', () => {
  assert.equal(errorCode(new Error('TARGET_NOT_ALLOWED: /unknown')).code, 'TARGET_NOT_ALLOWED');
});

test('neutral core codes are translated and preset codes pass through', () => {
  assert.equal(errorCode(new Error('INVENTORY_EMPTY: пустой инвентарь')).code, 'SCREEN_NOT_FOUND');
  assert.equal(errorCode(new Error('TARGETS_EMPTY: /unknown/:id')).code, 'SCREEN_NOT_FOUND');
  assert.equal(errorCode(new Error('CHECK_INVALID: elementCount.target')).code, 'CHECK_INVALID');
  assert.equal(errorCode(new Error('RESET_UNSUPPORTED: /orders')).code, 'RESET_UNSUPPORTED');
  assert.equal(errorCode(new ToolError('LIMIT_REACHED')).code, 'LIMIT_REACHED');
  assert.equal(errorCode(new Error('boom')).code, 'TOOL_FAILED');
});

test('every error code the preset card promises is recognized by the entry point', async () => {
  const card = await readFile(join(projectRoot, '.qwen/skills/bughunter-preset-card/SKILL.md'), 'utf8');
  // Имена env-переменных — не коды ошибок: карта называет их рядом со словом env.
  const withoutEnvNames = card.replace(/\benv\s+`?[A-Z][A-Z0-9_]*`?/g, '');
  const codes = [...new Set(
    [...withoutEnvNames.matchAll(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)].map((match) => match[0]),
  )].sort();
  assert.ok(codes.length >= 5, `карта пресета не называет кодов ошибок: ${codes.length}`);
  for (const code of codes) {
    assert.notEqual(
      errorCode(new Error(`${code}: detail`)).code,
      'TOOL_FAILED',
      `карта обещает код ${code}, но точка входа вернёт TOOL_FAILED`,
    );
  }
});
