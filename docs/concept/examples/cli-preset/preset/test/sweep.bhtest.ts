import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRun, readFindings } from '@bughunter/core';

import { cliInventory } from '../src/inventory.ts';
import { cliPersonas } from '../src/personas.ts';
import { cliSweepSession, cliSweepVisit, runSweep } from '../src/sweep-visit.ts';
import { stateFor } from './harness.ts';
import type { TestState } from './harness.ts';

async function sweepRun(state: TestState, limit?: number) {
  const run = await createRun('sweep', undefined, {
    config: state.config,
    projectRoot: state.config.appDir,
    stateDir: state.stateDir,
    personas: cliPersonas.roster,
    targets: await cliInventory.list(state.stateDir),
  });
  const result = await runSweep({
    runId: run.id,
    stateDir: state.stateDir,
    ...(limit === undefined ? {} : { limit }),
  });
  return { run, result, findings: await readFindings(run.id, state.stateDir) };
}

test('sweep finds C1, C2 and C4 from declared scenarios and leaves the clean list alone', async () => {
  const state = await stateFor();
  try {
    const { result, findings } = await sweepRun(state);
    assert.deepEqual(result.visited, ['add <name> <qty>', 'show <name>', 'list']);
    assert.equal(result.done, true);
    assert.equal(result.targets, 3);

    const add = findings.filter((finding) => finding.targetRef === 'add <name> <qty>');
    assert.equal(add.length, 7, JSON.stringify(add.map((finding) => [finding.widget, finding.kind, finding.detail]), null, 2));
    assert.equal(add.filter((finding) => finding.kind === 'exit-code-unexpected').length, 2);
    assert.equal(add.filter((finding) => finding.kind === 'output-mismatch').length, 4);
    assert.equal(add.some((finding) => finding.kind === 'output-anomaly' && finding.detail.includes('NaN')), true);

    const show = findings.filter((finding) => finding.targetRef === 'show <name>');
    assert.equal(show.length, 3, JSON.stringify(show.map((finding) => [finding.kind, finding.detail]), null, 2));
    assert.equal(show.some((finding) => finding.kind === 'exit-code-unexpected'), true);
    assert.equal(show.some((finding) => finding.kind === 'output-anomaly'), true);

    assert.deepEqual(findings.filter((finding) => finding.targetRef === 'list'), [], 'чистая команда дала ложные срабатывания');
    assert.equal(findings.some((finding) => finding.detail.includes('add apple 3; add apple 3')), false);
  } finally {
    await state.cleanup();
  }
});

test('sweep cursor continues after a limit and does not repeat a target', async () => {
  const state = await stateFor();
  try {
    const first = await sweepRun(state, 1);
    assert.deepEqual(first.result.visited, ['add <name> <qty>']);
    assert.equal(first.result.done, false);
    assert.equal(first.result.nextCursor, 1);

    const second = await runSweep({ runId: first.run.id, stateDir: state.stateDir, limit: 1 });
    assert.deepEqual(second.visited, ['show <name>']);
    assert.equal(second.nextCursor, 2);
    const findings = await readFindings(first.run.id, state.stateDir);
    assert.equal(findings.length, 10, 'вторая цель не должна повторить находки первой');

    const third = await runSweep({ runId: first.run.id, stateDir: state.stateDir, limit: 1 });
    assert.deepEqual(third.visited, ['list']);
    assert.equal(third.done, true);
  } finally {
    await state.cleanup();
  }
});

test('sweep session refuses model actions and a run of another scope is rejected', async () => {
  const state = await stateFor();
  try {
    const handle = await cliSweepSession.open({
      runId: 'run-not-sweep', target: 'list', persona: 'sweep', stateDir: state.stateDir,
    });
    try {
      await assert.rejects(handle.act({ argv: ['list'] }), /SWEEP_SESSION_READ_ONLY/);
    } finally {
      await handle.close();
    }

    const run = await createRun('target', 'list', {
      config: state.config,
      projectRoot: state.config.appDir,
      stateDir: state.stateDir,
      personas: cliPersonas.roster,
      targets: await cliInventory.list(state.stateDir),
    });
    await assert.rejects(runSweep({ runId: run.id, stateDir: state.stateDir }), /SWEEP_SCOPE_REQUIRED/);
    assert.equal(typeof cliSweepVisit.visit, 'function');
  } finally {
    await state.cleanup();
  }
});
