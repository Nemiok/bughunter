import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type {
  FindingKinds, Reset, Session, SessionHandle, SweepVisit, TargetInventory,
} from '../src/preset.ts';
import { createRun, readFindings, readRun } from '../src/run-store.ts';
import { promoteFindingToCandidate, runSweep } from '../src/sweep.ts';
import type { Config, FindingDraft } from '../src/types.ts';

const config = { targetMap: {}, baseBranch: 'main' } as unknown as Config;
const kinds = ['response-captured', 'navigation-failed', 'reset-unsupported'];

async function withStateDir(run: (stateDir: string) => Promise<void>): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), 'bh-core-sweep-'));
  try {
    await run(stateDir);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

function inventory(targets: string[]): TargetInventory {
  return { list: async () => targets, templateOf: (value) => value };
}

function session(events: string[]): Session {
  const handle: SessionHandle = {
    id: 'sweep-handle',
    snapshot: async () => ({}),
    act: async () => ({}),
    steps: () => [],
    artifacts: () => [],
    close: async () => { events.push('close'); },
  };
  return {
    open: async (input) => {
      events.push(`open:${input.persona}`);
      return handle;
    },
  };
}

function reset(events: string[], supported = true): Reset {
  return { supported, apply: async () => { events.push('reset'); } };
}

/** Шаг журнала строит пресет: core не знает ни перехода, ни адреса цели. */
const findingKinds: FindingKinds = {
  kinds,
  syntheticStep: async (finding) => ({
    step: {
      id: `step-${finding.id}`,
      kind: 'navigate',
      timestamp: 'SENTINEL_TIMESTAMP',
      targetRef: finding.targetRef,
      signalIds: [],
    },
    target: `/sample${finding.targetRef}`,
  }),
};

function captured(target: string): FindingDraft {
  return { targetRef: target, kind: 'response-captured', detail: 'Ответов: 1, с телом: 1', evidenceHashes: [] };
}

async function sweepRun(stateDir: string) {
  return createRun('sweep', undefined, { config, projectRoot: stateDir, stateDir, personas: ['p'], targets: ['/a'] });
}

test('the cursor resumes an interrupted sweep without revisiting targets', () => withStateDir(async (stateDir) => {
  const run = await sweepRun(stateDir);
  const events: string[] = [];
  const targets: string[] = [];
  const visit: SweepVisit = {
    visit: async ({ target }) => {
      targets.push(target);
      return [captured(target)];
    },
  };

  const first = await runSweep({
    runId: run.id, stateDir, limit: 1,
    inventory: inventory(['/a', '/b', '/c']), session: session(events), visit, reset: reset(events), findingKinds,
  });
  assert.deepEqual(first.visited, ['/a']);
  assert.equal(first.targets, 3);
  assert.equal(first.done, false);
  assert.equal(first.nextCursor, 1);
  assert.equal(first.findings, 1);

  const second = await runSweep({
    runId: run.id, stateDir,
    inventory: inventory(['/a', '/b', '/c']), session: session(events), visit, reset: reset(events), findingKinds,
  });
  assert.deepEqual(second.visited, ['/b', '/c']);
  assert.deepEqual(targets, ['/a', '/b', '/c'], 'прерванный обход продолжается, а не начинается заново');
  assert.equal(second.done, true);
  assert.equal(second.nextCursor, undefined);

  assert.deepEqual(events, ['open:sweep', 'reset', 'close', 'open:sweep', 'reset', 'reset', 'close'],
    'сброс перед каждой целью, одна сессия на вызов, сессия закрыта');
  const progress = JSON.parse(await readFile(join(stateDir, 'runs', run.id, 'sweep.json'), 'utf8')) as {
    visited: string[]; cursor: number;
  };
  assert.deepEqual(progress.visited, ['/a', '/b', '/c']);
  assert.equal(progress.cursor, 3);
  assert.equal((await readFindings(run.id, stateDir)).length, 3);
  const after = await readRun(run.id, stateDir);
  assert.equal(after.stages.sweep, 'done');
  assert.equal(after.stages.findings, 'done');
}));

test('an unreachable target is recorded in visited and does not stop the sweep', () => withStateDir(async (stateDir) => {
  const run = await sweepRun(stateDir);
  const visit: SweepVisit = {
    visit: async ({ target }) => (target === '/dead'
      ? [{ targetRef: target, kind: 'navigation-failed', detail: 'net::ERR_CONNECTION_REFUSED', evidenceHashes: [] }]
      : [captured(target)]),
  };

  const result = await runSweep({
    runId: run.id, stateDir,
    inventory: inventory(['/dead', '/a']), session: session([]), visit, reset: reset([]), findingKinds,
  });

  // Курсор сдвинут, значит цель обработана: вызывающая сторона не должна думать, что её не прошли.
  assert.deepEqual(result.visited, ['/dead', '/a']);
  assert.equal(result.done, true);
  const findings = await readFindings(run.id, stateDir);
  assert.equal(findings.filter((finding) => finding.kind === 'navigation-failed').length, 1);
  assert.ok(findings.some((finding) => finding.targetRef === '/a' && finding.kind === 'response-captured'));
  assert.ok(findings.every((finding) => finding.status === 'new' && finding.runId === run.id && finding.id !== ''),
    'конверт находки заполняет core');
  const progress = JSON.parse(await readFile(join(stateDir, 'runs', run.id, 'sweep.json'), 'utf8')) as { cursor: number };
  assert.equal(progress.cursor, 2);

  // Область screen: недостижимая цель всё равно закрывает свою стадию, иначе прогон нельзя
  // завершить — `finishRun` требует `done` для каждой цели прогона.
  const screenRun = await createRun('sweep', '/dead', {
    config,
    projectRoot: stateDir,
    stateDir,
    personas: ['p'],
    targets: ['/a'],
  });
  const screenResult = await runSweep({
    runId: screenRun.id, stateDir,
    inventory: inventory(['/dead']), session: session([]), visit, reset: reset([]), findingKinds,
  });
  assert.deepEqual(screenResult.visited, ['/dead']);
  assert.equal((await readRun(screenRun.id, stateDir)).targetStages['/dead'], 'done');
}));

test('an unsupported reset is reported once per run', () => withStateDir(async (stateDir) => {
  const run = await sweepRun(stateDir);
  const visit: SweepVisit = { visit: async ({ target }) => [captured(target)] };
  const options = {
    runId: run.id, stateDir,
    inventory: inventory(['/a', '/b']), session: session([]), visit, findingKinds,
  };

  await runSweep({ ...options, reset: { supported: false, apply: async () => { throw new Error('не должно вызываться'); } } });
  const first = await readFindings(run.id, stateDir);
  assert.equal(first.filter((finding) => finding.kind === 'reset-unsupported').length, 1);
  assert.equal(first.find((finding) => finding.kind === 'reset-unsupported')?.detail, 'RESET_UNSUPPORTED');

  // Второй вызов того же прогона не повторяет утверждение о неподдержанном сбросе.
  await runSweep({ ...options, reset: reset([]) });
  const second = await readFindings(run.id, stateDir);
  assert.equal(second.filter((finding) => finding.kind === 'reset-unsupported').length, 1);
}));

test('a finding kind unknown to the preset is rejected', () => withStateDir(async (stateDir) => {
  const run = await sweepRun(stateDir);
  const events: string[] = [];
  const visit: SweepVisit = {
    visit: async ({ target }) => [{ targetRef: target, kind: 'totally-unknown', detail: 'x', evidenceHashes: [] }],
  };

  await assert.rejects(
    () => runSweep({
      runId: run.id, stateDir,
      inventory: inventory(['/a']), session: session(events), visit, reset: reset(events), findingKinds,
    }),
    /FINDING_KIND_INVALID: totally-unknown/,
  );
  assert.deepEqual(await readFindings(run.id, stateDir), []);
  assert.deepEqual(events, ['open:sweep', 'reset', 'close'], 'сессия закрывается даже при отказе');
}));

test('an empty inventory stops the sweep before opening a session', () => withStateDir(async (stateDir) => {
  const run = await sweepRun(stateDir);
  const events: string[] = [];
  const visit: SweepVisit = { visit: async () => [] };

  await assert.rejects(
    () => runSweep({
      runId: run.id, stateDir,
      inventory: inventory([]), session: session(events), visit, reset: reset(events), findingKinds,
    }),
    /INVENTORY_EMPTY/,
  );
  assert.deepEqual(events, [], 'браузер не запускается, когда обходить нечего');

  const missing = await createRun('sweep', '/unknown/:id', { config, projectRoot: stateDir, stateDir, personas: ['p'], targets: ['/a'] });
  await assert.rejects(
    () => runSweep({
      runId: missing.id, stateDir,
      inventory: inventory(['/a']), session: session(events), visit, reset: reset(events), findingKinds,
    }),
    /TARGETS_EMPTY: \/unknown\/:id/,
  );
  // Курсор за пределами инвентаря даёт пустой срез: обход не падает и стенд не запускает.
  const beyond = await runSweep({
    runId: run.id, stateDir,
    inventory: inventory(['/a']), session: session(events), visit, reset: reset(events), findingKinds,
    cursor: 5,
  });
  assert.deepEqual(beyond.visited, []);
  assert.equal(beyond.done, false);
  assert.deepEqual(events, []);
}));

test('promote builds the synthetic step through the preset', () => withStateDir(async (stateDir) => {
  const run = await sweepRun(stateDir);
  const visit: SweepVisit = { visit: async ({ target }) => [captured(target)] };
  await runSweep({
    runId: run.id, stateDir,
    inventory: inventory(['/a']), session: session([]), visit, reset: reset([]), findingKinds,
  });
  const [finding] = await readFindings(run.id, stateDir);
  assert.ok(finding);

  const { candidateId } = await promoteFindingToCandidate({
    runId: run.id, findingId: finding.id, title: 'Экран не отдаёт данные',
    expected: 'Данные ответа видны', actual: 'Ответ не доходит', stateDir, findingKinds,
  });

  const candidate = JSON.parse(await readFile(
    join(stateDir, 'runs', run.id, 'candidates', `${candidateId}.json`), 'utf8',
  )) as { sessionId: string; target: string; status: string; reproduction: unknown; steps: Array<Record<string, unknown>> };
  assert.deepEqual(candidate.steps.map((step) => step.kind), ['navigate']);
  assert.equal(candidate.steps[0]?.timestamp, 'SENTINEL_TIMESTAMP');
  assert.equal(candidate.steps[0]?.targetRef, '/a');
  assert.equal(candidate.target, '/sample/a');
  assert.equal(candidate.status, 'unprocessed');
  assert.deepEqual(candidate.reproduction, { status: 'unreproduced', attempts: 0 });

  const journal = JSON.parse(await readFile(
    join(stateDir, 'runs', run.id, 'journals', `${candidate.sessionId}.json`), 'utf8',
  )) as { persona: string; target: string; steps: Array<{ id: string }> };
  assert.equal(journal.persona, 'sweep');
  assert.equal(journal.target, '/sample/a');
  assert.deepEqual(journal.steps.map((step) => step.id), [`step-${finding.id}`]);

  const promoted = (await readFindings(run.id, stateDir)).find((entry) => entry.id === finding.id);
  assert.equal(promoted?.status, 'promoted');
  assert.equal(promoted?.candidateId, candidateId);

  assert.deepEqual(
    await promoteFindingToCandidate({
      runId: run.id, findingId: finding.id, title: 'x', expected: 'y', actual: 'z', stateDir, findingKinds,
    }),
    { candidateId },
    'повторное продвижение той же находки не плодит кандидатов',
  );
  await assert.rejects(
    () => promoteFindingToCandidate({
      runId: run.id, findingId: 'missing', title: 'x', expected: 'y', actual: 'z', stateDir, findingKinds,
    }),
    /FINDING_NOT_FOUND: missing/,
  );
}));
