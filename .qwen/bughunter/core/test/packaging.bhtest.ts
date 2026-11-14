import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';

const projectRoot = join(import.meta.dirname, '../../../..');

function ignored(relativePath: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', relativePath], { cwd: projectRoot, stdio: 'ignore' });
    return true;
  } catch (error) {
    if ((error as { status?: number }).status === 1) return false;
    throw error;
  }
}

/**
 * Каталог состояния переехал вместе с разрезом (`state/` → `presets/web/state/`), а рантайм
 * прежней установки остался на старом месте: там доказательства гейтов и `storage-state.json`
 * с секретами сессии. Оба пути обязаны игнорироваться, иначе широкий `git add` унесёт их в историю.
 */
test('runtime state stays ignored under both the pre-split and the split paths', () => {
  const runtime = [
    '.qwen/bughunter/state/runs/20260101T000000.000Z-aaaaaaaaaaaa/run.json',
    '.qwen/bughunter/state/auth/storage-state.json',
    '.qwen/bughunter/presets/web/state/runs/20260101T000000.000Z-aaaaaaaaaaaa/run.json',
    '.qwen/bughunter/presets/web/state/auth/storage-state.json',
    '.qwen/bughunter/presets/web/state/preset.json',
  ];
  const exposed = runtime.filter((path) => !ignored(path));
  assert.deepEqual(exposed, [], `не игнорируются: ${exposed.join(', ')}`);
});

test('shared state files stay tracked, not ignored', () => {
  for (const path of [
    '.qwen/bughunter/presets/web/state/config.json',
    '.qwen/bughunter/presets/web/state/known-bugs.json',
    '.qwen/bughunter/presets/web/state/suppressions.json',
  ]) {
    assert.equal(ignored(path), false, `общий файл состояния не должен игнорироваться: ${path}`);
  }
});
