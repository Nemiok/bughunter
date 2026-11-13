import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { exportTest } from '../src/export-host.ts';
import type { ExportTarget, TestGenerator, TestRunner } from '../src/preset.ts';
import { createRun, readCandidate, writeJsonAtomic } from '../src/run-store.ts';
import type { SharedMemoryEntry } from '../src/run-store.ts';
import type { Candidate, Config, Journal } from '../src/types.ts';

const config = { routes: ['/a'], routeMap: {}, baseBranch: 'main' } as unknown as Config;
const createdAt = '2026-11-13T00:00:00.000Z';
const journalRoute = '/orders/12';

async function withStateDir(run: (stateDir: string) => Promise<void>): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), 'bh-core-export-'));
  try {
    await run(stateDir);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

type Fixture = { runId: string; bugId: string; candidateId: string };

/** Подтверждённый и воспроизведённый баг: ровно то состояние, при котором экспорт разрешён. */
async function confirmedBug(stateDir: string, patch: Partial<Candidate> = {}): Promise<Fixture> {
  const run = await createRun('full', undefined, { config, projectRoot: stateDir, stateDir, personas: ['p'] });
  const journal: Journal = {
    sessionId: 'sess-1', runId: run.id, route: journalRoute, persona: 'p', steps: [], createdAt,
  };
  const candidate: Candidate = {
    id: 'cand-1',
    runId: run.id,
    sessionId: 'sess-1',
    route: journalRoute,
    title: 'Итог заказа не считается',
    expected: 'видна сумма 30',
    actual: 'виден NaN',
    signalIds: [],
    signature: 'sig-1',
    steps: [],
    artifacts: [],
    status: 'confirmed',
    createdAt,
    reproduction: { status: 'reproduced', attempts: 3 },
    review: { status: 'confirmed', reason: 'воспроизведено 3/3' },
    ...patch,
  };
  const known: SharedMemoryEntry = {
    id: 'bug-1', signature: 'sig-1', reason: 'воспроизведено', sourceCandidate: 'cand-1', createdAt, updatedAt: createdAt,
  };
  await writeJsonAtomic(join(stateDir, 'runs', run.id, 'journals', 'sess-1.json'), journal);
  await writeJsonAtomic(join(stateDir, 'runs', run.id, 'candidates', `${candidate.id}.json`), candidate);
  await writeJsonAtomic(join(stateDir, 'known-bugs.json'), [known]);
  return { runId: run.id, bugId: known.id, candidateId: candidate.id };
}

type Generated = { candidateId: string; initialTarget: string; stateDir: string };

function generator(source: string, seen: Generated[]): TestGenerator {
  return {
    generate: async (input) => {
      seen.push({ candidateId: input.candidate.id, initialTarget: input.initialTarget, stateDir: input.stateDir });
      return source;
    },
  };
}

function target(dir: string, fileName: (bugId: string) => string = (bugId) => `${bugId}.spec.ts`): ExportTarget {
  return { dir: () => dir, kind: 'e2e-stub', fileName };
}

function runner(ownsProject: boolean): TestRunner {
  return {
    kinds: ['e2e-stub'],
    resolveKind: async () => null,
    command: async () => ({ command: 'true' }),
    parseReport: () => ({
      singleFile: true, tests: 1, passed: 1, failed: 0, runtimeErrors: false,
      assertionFailuresOnly: false, cleanPass: true, names: [], diagnostic: '',
    }),
    ownsProject: () => ownsProject,
  };
}

test('the generated source is written once and never overwritten', () => withStateDir(async (stateDir) => {
  const { runId, bugId } = await confirmedBug(stateDir);
  const seen: Generated[] = [];
  const call = (source: string) => exportTest({
    runId, bugId, stateDir, config,
    generate: generator(source, seen), target: target('e2e/generated'), runner: runner(false),
  });

  const first = await call('SOURCE_FIRST');
  // Своего проекта с тестами нет: файл остаётся в прогоне, и это видно вызывающей стороне.
  assert.equal(first.placedInProject, false);
  assert.equal(first.file, join(stateDir, 'runs', runId, 'e2e-stub', 'bug-1.spec.ts'));
  assert.equal(await readFile(first.file, 'utf8'), 'SOURCE_FIRST');
  assert.deepEqual(seen.map((entry) => entry.initialTarget), [journalRoute]);

  await assert.rejects(call('SOURCE_SECOND'), /EXPORT_FILE_EXISTS: /);
  assert.equal(await readFile(first.file, 'utf8'), 'SOURCE_FIRST', 'чужой тест не перезаписывается');

  // Тот же источник — тот же файл: повторный экспорт не ошибка.
  assert.deepEqual(await call('SOURCE_FIRST'), first);
  const candidate = await readCandidate(runId, 'cand-1', stateDir);
  assert.equal(candidate.tests?.['e2e-stub'], 'e2e-stub/bug-1.spec.ts');
}));

test('a path escaping the destination is refused', () => withStateDir(async (stateDir) => {
  const { runId, bugId } = await confirmedBug(stateDir);
  const seen: Generated[] = [];

  await assert.rejects(
    () => exportTest({
      runId, bugId, stateDir, config,
      generate: generator('SOURCE', seen),
      target: target('e2e/generated', () => '../../escape.spec.ts'),
      runner: runner(false),
    }),
    /EXPORT_PATH_UNSAFE: /,
  );
  await assert.rejects(readFile(join(stateDir, 'escape.spec.ts'), 'utf8'), /ENOENT/);

  // Идентификатор бага приходит из памяти и подставляется в имя файла: traversal недопустим.
  await writeJsonAtomic(join(stateDir, 'known-bugs.json'), [{
    id: '../evil', signature: 'sig-1', reason: 'x', sourceCandidate: 'cand-1', createdAt, updatedAt: createdAt,
  } satisfies SharedMemoryEntry]);
  await assert.rejects(
    () => exportTest({
      runId, bugId: '../evil', stateDir, config,
      generate: generator('SOURCE', seen), target: target('e2e/generated'), runner: runner(false),
    }),
    /BUG_ID_INVALID: \.\.\/evil/,
  );
}));

test('an unconfirmed or unreproduced candidate is refused', () => withStateDir(async (stateDir) => {
  const unconfirmed = await confirmedBug(stateDir, { status: 'unprocessed', review: undefined });
  const seen: Generated[] = [];
  const call = (fixture: Fixture) => exportTest({
    runId: fixture.runId, bugId: fixture.bugId, stateDir, config,
    generate: generator('SOURCE', seen), target: target('e2e/generated'), runner: runner(false),
  });

  await assert.rejects(call(unconfirmed), /BUG_NOT_CONFIRMED: bug-1/);
  assert.deepEqual(seen, [], 'генератор не вызывается для неподтверждённого бага');

  const unreproduced = await confirmedBug(stateDir, { reproduction: { status: 'unreproduced', attempts: 0 } });
  await assert.rejects(call(unreproduced), /CANDIDATE_UNREPRODUCED: cand-1/);
  assert.deepEqual(seen, []);
}));

test('the destination comes from the preset', () => withStateDir(async (stateDir) => {
  const { runId, bugId } = await confirmedBug(stateDir);
  const projectDirectory = join(stateDir, 'project');
  const seen: Generated[] = [];

  const placed = await exportTest({
    runId, bugId, stateDir, config,
    generate: generator('SOURCE', seen),
    target: target(join(projectDirectory, 'e2e', 'bughunter')),
    runner: runner(true),
  });

  assert.equal(placed.placedInProject, true);
  assert.equal(placed.file, join(projectDirectory, 'e2e', 'bughunter', 'bug-1.spec.ts'));
  assert.equal(await readFile(placed.file, 'utf8'), 'SOURCE');
  // Тест лег вне каталога прогона, поэтому в кандидате остаётся полный путь к нему.
  assert.equal((await readCandidate(runId, 'cand-1', stateDir)).tests?.['e2e-stub'], placed.file);
  assert.deepEqual(seen.map((entry) => entry.stateDir), [stateDir]);
}));
