import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createRun, leaseNextExploration, readRun, updateRun } from '../src/run-store.ts';
import { createLifecycle } from '../src/session-lifecycle.ts';
import type { Config } from '../src/types.ts';

const config = { routes: ['/a', '/b'], targetMap: {}, baseBranch: 'main' } as unknown as Config;
const personas = ['персона'];

type Harness = {
  lifecycle: ReturnType<typeof createLifecycle>;
  opened: string[];
  closed: string[];
  failOpen: () => void;
  failClose: () => void;
};

function harness(stateDir: string): Harness {
  const opened: string[] = [];
  const closed: string[] = [];
  let openBroken = false;
  let closeBroken = false;
  const lifecycle = createLifecycle({
    stateDir,
    personas,
    open: async ({ target, persona }) => {
      if (openBroken) throw new Error('OPEN_FAILED');
      const sessionId = `sess-${opened.length + 1}`;
      opened.push(sessionId);
      return { sessionId, payload: { target, persona } };
    },
    close: async (sessionId) => {
      if (closeBroken) throw new Error('CLOSE_FAILED');
      closed.push(sessionId);
    },
  });
  return {
    lifecycle,
    opened,
    closed,
    failOpen: () => { openBroken = true; },
    failClose: () => { closeBroken = true; },
  };
}

async function withStateDir(run: (stateDir: string) => Promise<void>): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), 'bh-core-lifecycle-'));
  try {
    await run(stateDir);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

async function leasedTask(runId: string, stateDir: string) {
  const result = await leaseNextExploration(runId, { personas }, stateDir);
  assert.equal(result.status, 'task');
  if (result.status !== 'task') throw new Error('не достигнуто');
  return result;
}

test('a second concurrent open of the same run is refused', () => withStateDir(async (stateDir) => {
  const run = await createRun('full', undefined, { config, projectRoot: stateDir, stateDir, personas, targets: ['/a'] });
  const { lifecycle } = harness(stateDir);
  const task = await leasedTask(run.id, stateDir);
  await lifecycle.open({ runId: run.id, target: task.target, persona: task.persona, leaseId: task.leaseId });
  await assert.rejects(
    () => lifecycle.open({ runId: run.id, target: task.target, persona: task.persona, leaseId: task.leaseId }),
    /EXPLORER_BUSY/,
  );
}));

test('open without a lease is refused when the run has a queue', () => withStateDir(async (stateDir) => {
  const run = await createRun('full', undefined, { config, projectRoot: stateDir, stateDir, personas, targets: ['/a'] });
  const { lifecycle, opened } = harness(stateDir);
  await assert.rejects(
    () => lifecycle.open({ runId: run.id, target: '/a', persona: personas[0]! }),
    /LEASE_REQUIRED/,
  );
  assert.deepEqual(opened, [], 'сессия не открывается без lease');
}));

test('a lease for another target is refused', () => withStateDir(async (stateDir) => {
  const run = await createRun('full', undefined, { config, projectRoot: stateDir, stateDir, personas, targets: ['/a'] });
  const { lifecycle, opened } = harness(stateDir);
  const task = await leasedTask(run.id, stateDir);
  await assert.rejects(
    () => lifecycle.open({ runId: run.id, target: '/b', persona: task.persona, leaseId: task.leaseId }),
    /LEASE_(MISMATCH|UNKNOWN)/,
  );
  assert.deepEqual(opened, []);
}));

test('a failed open returns the task to the queue', () => withStateDir(async (stateDir) => {
  const run = await createRun('full', undefined, { config, projectRoot: stateDir, stateDir, personas, targets: ['/a'] });
  const { lifecycle, failOpen } = harness(stateDir);
  const task = await leasedTask(run.id, stateDir);
  failOpen();
  await assert.rejects(
    () => lifecycle.open({ runId: run.id, target: task.target, persona: task.persona, leaseId: task.leaseId }),
    /OPEN_FAILED/,
  );
  const again = await leasedTask(run.id, stateDir);
  assert.equal(again.target, task.target, 'задача снова выдана, а не потеряна');
}));

test('a successful close completes the lease and the target stage', () => withStateDir(async (stateDir) => {
  const run = await createRun('full', undefined, { config, projectRoot: stateDir, stateDir, personas, targets: ['/a'] });
  const { lifecycle, opened } = harness(stateDir);
  const task = await leasedTask(run.id, stateDir);
  await lifecycle.open({ runId: run.id, target: task.target, persona: task.persona, leaseId: task.leaseId });
  await lifecycle.close(opened[0]!);
  const after = await readRun(run.id, stateDir);
  assert.equal(after.targetStages[task.target], 'done');
  // После завершения lease очищается, поэтому элемент ищем по цели и персоне.
  assert.equal(after.exploreQueue?.find((item) => item.target === task.target && item.persona === task.persona)?.status, 'done');
}));

test('a failed close releases the lease instead of completing it', () => withStateDir(async (stateDir) => {
  const run = await createRun('full', undefined, { config, projectRoot: stateDir, stateDir, personas, targets: ['/a'] });
  const { lifecycle, opened, failClose } = harness(stateDir);
  const task = await leasedTask(run.id, stateDir);
  await lifecycle.open({ runId: run.id, target: task.target, persona: task.persona, leaseId: task.leaseId });
  failClose();
  await assert.rejects(() => lifecycle.close(opened[0]!), /CLOSE_FAILED/);
  const after = await readRun(run.id, stateDir);
  assert.equal(after.exploreQueue?.find((item) => item.target === task.target && item.persona === task.persona)?.status, 'pending');
}));

test('reclaim skips leases that are live in this process', () => withStateDir(async (stateDir) => {
  const run = await createRun('full', undefined, { config, projectRoot: stateDir, stateDir, personas, targets: ['/a'] });
  const { lifecycle, opened } = harness(stateDir);
  const task = await leasedTask(run.id, stateDir);
  await lifecycle.open({ runId: run.id, target: task.target, persona: task.persona, leaseId: task.leaseId });
  const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const current = await readRun(run.id, stateDir);
  await updateRun(run.id, {
    exploreQueue: current.exploreQueue?.map((item) => (item.status === 'leased' ? { ...item, leasedAt: stale } : item)),
  }, stateDir);
  await lifecycle.reclaim(run.id);
  const after = await readRun(run.id, stateDir);
  assert.equal(after.exploreQueue?.find((item) => item.leaseId === task.leaseId)?.status, 'leased');
  assert.deepEqual([...lifecycle.liveLeaseIds(run.id)], [task.leaseId]);
  await lifecycle.close(opened[0]!);
}));

test('leaseNext hands out one task at a time through the same lock', () => withStateDir(async (stateDir) => {
  const run = await createRun('full', undefined, { config, projectRoot: stateDir, stateDir, personas, targets: ['/a'] });
  const { lifecycle } = harness(stateDir);
  const first = await lifecycle.leaseNext(run.id, {});
  assert.equal(first.status, 'task');
  const second = await lifecycle.leaseNext(run.id, {});
  assert.equal(second.status, 'busy');
}));
