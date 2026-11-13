import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  completeExplorationLease,
  readRun,
  reclaimExplorationLeases,
  releaseExplorationLease,
  updateRun,
  validateExplorationLease,
} from '@bughunter/core';
import type { Config, Run } from '@bughunter/core';
import { createRun, leaseNextExploration } from '../src/runs.ts';
import { EXPLORER_PERSONAS } from '../src/personas.ts';

const serverRoot = resolve(import.meta.dirname, '..');
const temporaryDirectories: string[] = [];

after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function queueConfig(): Config {
  return {
    baseUrl: 'http://127.0.0.1:4173',
    allowedOrigins: ['http://127.0.0.1:4173'],
    routes: ['/', '/orders', '/profile'],
    routeMap: {},
    baseBranch: 'main',
    limits: { stepsPerSession: 60, candidatesPerRun: 20 },
    safety: { forbiddenActionText: ['delete'], readOnly: false },
    testDataPrefix: 'bh_',
    detectors: {
      ignoreConsole: [],
      ignoreRequests: [],
      anomalyTexts: ['undefined', 'NaN'],
      errorBoundarySelector: '[data-error-boundary]',
    },
    tests: { unit: { command: null }, e2e: { dir: 'e2e/bughunter' } },
  };
}

test('createRun builds a route-major queue with the three MVP personas', async () => {
  const stateDir = await temporaryDirectory('bh-queue-');
  const run = await createRun('full', undefined, { config: queueConfig(), projectRoot: stateDir, stateDir });
  assert.deepEqual(
    run.exploreQueue?.map((item) => [item.route, item.persona, item.status]),
    [
      ['/', 'новичок', 'pending'],
      ['/', 'нетерпеливый', 'pending'],
      ['/', 'граничный ввод', 'pending'],
      ['/orders', 'новичок', 'pending'],
      ['/orders', 'нетерпеливый', 'pending'],
      ['/orders', 'граничный ввод', 'pending'],
      ['/profile', 'новичок', 'pending'],
      ['/profile', 'нетерпеливый', 'pending'],
      ['/profile', 'граничный ввод', 'pending'],
    ],
  );
  assert.ok(run.exploreQueue?.every((item) => item.leaseId === undefined));
  const persisted = await readRun(run.id, stateDir);
  assert.deepEqual(persisted.exploreQueue, run.exploreQueue);
});

test('createRun for route scope queues only the selected route', async () => {
  const stateDir = await temporaryDirectory('bh-queue-');
  const run = await createRun('route', '/orders', { config: queueConfig(), projectRoot: stateDir, stateDir });
  assert.equal(run.exploreQueue?.length, EXPLORER_PERSONAS.length);
  assert.ok(run.exploreQueue?.every((item) => item.route === '/orders'));
});

test('leaseNextExploration leases one item at a time and completes in order', async () => {
  const stateDir = await temporaryDirectory('bh-queue-');
  const run = await createRun('full', undefined, { config: queueConfig(), projectRoot: stateDir, stateDir });

  const first = await leaseNextExploration(run.id, {}, stateDir);
  assert.equal(first.status, 'task');
  if (first.status !== 'task') return;
  assert.equal(first.route, '/');
  assert.equal(first.persona, 'новичок');
  assert.ok(first.leaseId.length > 0);

  const busy = await leaseNextExploration(run.id, {}, stateDir);
  assert.deepEqual(busy, { status: 'busy', activeRoute: '/' });

  await completeExplorationLease(run.id, first.leaseId, stateDir);
  const second = await leaseNextExploration(run.id, {}, stateDir);
  assert.equal(second.status, 'task');
  if (second.status !== 'task') return;
  assert.equal(second.route, '/');
  assert.equal(second.persona, 'нетерпеливый');
  assert.notEqual(second.leaseId, first.leaseId);

  const stored = await readRun(run.id, stateDir);
  assert.deepEqual(
    stored.exploreQueue?.map((item) => item.status),
    ['done', 'leased', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending', 'pending'],
  );

  await completeExplorationLease(run.id, second.leaseId, stateDir);
  for (let index = 0; index < 7; index += 1) {
    const next = await leaseNextExploration(run.id, {}, stateDir);
    assert.equal(next.status, 'task');
    if (next.status !== 'task') return;
    await completeExplorationLease(run.id, next.leaseId, stateDir);
  }
  assert.deepEqual(await leaseNextExploration(run.id, {}, stateDir), { status: 'done' });
});

test('leaseNextExploration route filter leases the first pending item of that route only', async () => {
  const stateDir = await temporaryDirectory('bh-queue-');
  const run = await createRun('full', undefined, { config: queueConfig(), projectRoot: stateDir, stateDir });
  const task = await leaseNextExploration(run.id, { route: '/profile' }, stateDir);
  assert.equal(task.status, 'task');
  if (task.status !== 'task') return;
  assert.equal(task.route, '/profile');
  assert.equal(task.persona, 'новичок');
  const filteredBusy = await leaseNextExploration(run.id, { route: '/orders' }, stateDir);
  assert.deepEqual(filteredBusy, { status: 'busy', activeRoute: '/profile' });
  await completeExplorationLease(run.id, task.leaseId, stateDir);
  const again = await leaseNextExploration(run.id, { route: '/profile' }, stateDir);
  assert.equal(again.status, 'task');
  if (again.status !== 'task') return;
  assert.equal(again.persona, 'нетерпеливый');
});

test('stale leases are reclaimed before a new task is handed out', async () => {
  const stateDir = await temporaryDirectory('bh-queue-');
  const run = await createRun('full', undefined, { config: queueConfig(), projectRoot: stateDir, stateDir });
  const first = await leaseNextExploration(run.id, {}, stateDir);
  assert.equal(first.status, 'task');
  if (first.status !== 'task') return;
  const stale = await leaseNextExploration(run.id, { staleLeaseMs: 0 }, stateDir);
  assert.equal(stale.status, 'task', 'a zero-TTL lease must be reclaimed as stale');
  if (stale.status !== 'task') return;
  assert.equal(stale.route, first.route);
  assert.equal(stale.persona, first.persona);
  assert.notEqual(stale.leaseId, first.leaseId);
  const stored = await readRun(run.id, stateDir);
  assert.equal(stored.exploreQueue?.[0]?.leaseId, stale.leaseId);
});

test('live session leases are never reclaimed as stale or by resume', async () => {
  const stateDir = await temporaryDirectory('bh-queue-');
  const run = await createRun('full', undefined, { config: queueConfig(), projectRoot: stateDir, stateDir });
  const task = await leaseNextExploration(run.id, {}, stateDir);
  assert.equal(task.status, 'task');
  if (task.status !== 'task') return;
  const keep = new Set([task.leaseId]);
  const busy = await leaseNextExploration(run.id, { staleLeaseMs: 0, keepLeaseIds: keep }, stateDir);
  assert.deepEqual(busy, { status: 'busy', activeRoute: '/' }, 'a live lease must survive zero TTL');
  await reclaimExplorationLeases(run.id, stateDir, keep);
  const stored = await readRun(run.id, stateDir);
  assert.equal(stored.exploreQueue?.[0]?.status, 'leased');
  assert.equal(stored.exploreQueue?.[0]?.leaseId, task.leaseId);
});

test('validateExplorationLease accepts the exact task and rejects mismatches', async () => {
  const stateDir = await temporaryDirectory('bh-queue-');
  const run = await createRun('full', undefined, { config: queueConfig(), projectRoot: stateDir, stateDir });
  const task = await leaseNextExploration(run.id, {}, stateDir);
  assert.equal(task.status, 'task');
  if (task.status !== 'task') return;
  await validateExplorationLease(run.id, task.leaseId, task.route, task.persona, stateDir);
  await assert.rejects(
    validateExplorationLease(run.id, 'no-such-lease', task.route, task.persona, stateDir),
    /LEASE_UNKNOWN/,
  );
  await assert.rejects(
    validateExplorationLease(run.id, task.leaseId, '/orders', task.persona, stateDir),
    /LEASE_MISMATCH/,
  );
  await assert.rejects(
    validateExplorationLease(run.id, task.leaseId, task.route, 'другая персона', stateDir),
    /LEASE_MISMATCH/,
  );
  await completeExplorationLease(run.id, task.leaseId, stateDir);
  await assert.rejects(
    validateExplorationLease(run.id, task.leaseId, task.route, task.persona, stateDir),
    /LEASE_UNKNOWN/,
  );
});

test('releaseExplorationLease returns the item to pending for retry', async () => {
  const stateDir = await temporaryDirectory('bh-queue-');
  const run = await createRun('full', undefined, { config: queueConfig(), projectRoot: stateDir, stateDir });
  const task = await leaseNextExploration(run.id, {}, stateDir);
  assert.equal(task.status, 'task');
  if (task.status !== 'task') return;
  await releaseExplorationLease(run.id, task.leaseId, stateDir);
  const stored = await readRun(run.id, stateDir);
  assert.equal(stored.exploreQueue?.[0]?.status, 'pending');
  assert.equal(stored.exploreQueue?.[0]?.leaseId, undefined);
  const retry = await leaseNextExploration(run.id, {}, stateDir);
  assert.equal(retry.status, 'task');
  if (retry.status !== 'task') return;
  assert.equal(retry.route, task.route);
  assert.equal(retry.persona, task.persona);
});

test('reclaimExplorationLeases returns every leased item to pending', async () => {
  const stateDir = await temporaryDirectory('bh-queue-');
  const run = await createRun('full', undefined, { config: queueConfig(), projectRoot: stateDir, stateDir });
  const task = await leaseNextExploration(run.id, {}, stateDir);
  assert.equal(task.status, 'task');
  if (task.status !== 'task') return;
  await reclaimExplorationLeases(run.id, stateDir);
  const stored = await readRun(run.id, stateDir);
  assert.ok(stored.exploreQueue?.every((item) => item.status === 'pending' && item.leaseId === undefined));
});

test('legacy runs without a queue lazily build one and skip done routes', async () => {
  const stateDir = await temporaryDirectory('bh-queue-');
  const run = await createRun('full', undefined, { config: queueConfig(), projectRoot: stateDir, stateDir });
  const legacy: Run = { ...run, exploreQueue: undefined };
  legacy.routeStages = { '/': 'done', '/orders': 'pending', '/profile': 'pending' };
  await updateRun(run.id, { exploreQueue: undefined, routeStages: legacy.routeStages }, stateDir);
  assert.equal((await readRun(run.id, stateDir)).exploreQueue, undefined);

  const task = await leaseNextExploration(run.id, {}, stateDir);
  assert.equal(task.status, 'task');
  if (task.status !== 'task') return;
  assert.equal(task.route, '/orders', 'done routes must not be re-queued');
  const stored = await readRun(run.id, stateDir);
  assert.equal(stored.exploreQueue?.length, 2 * EXPLORER_PERSONAS.length);
  assert.ok(stored.exploreQueue?.every((item) => item.route !== '/'));
});

async function callValue(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await client.callTool({ name, arguments: args });
  assert.notEqual(response.isError, true, JSON.stringify(response.content));
  assert.ok(Array.isArray(response.content));
  const content = response.content[0] as { type: string; text: string };
  return JSON.parse(content.text) as Record<string, unknown>;
}

async function callError(client: Client, name: string, args: Record<string, unknown>): Promise<{ code?: string; message?: string }> {
  const response = await client.callTool({ name, arguments: args });
  assert.equal(response.isError, true, JSON.stringify(response.content));
  assert.ok(Array.isArray(response.content));
  const content = response.content[0] as { type: string; text: string };
  return JSON.parse(content.text) as { code?: string; message?: string };
}

test('MCP exploration queue hands out one lease, requires it on open, and survives parallel callers', { timeout: 60_000 }, async () => {
  const projectRoot = await temporaryDirectory('bh-queue-mcp-');
  const stateDir = join(projectRoot, 'state');
  await mkdir(join(projectRoot, '.git'), { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, 'config.json'), JSON.stringify(queueConfig()), 'utf8');
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(serverRoot, 'src/index.ts')],
    cwd: projectRoot,
    env: { ...environment, BUGHUNTER_STATE_DIR: stateDir },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'bughunter-queue', version: '1.0.0' });
  try {
    await client.connect(transport);

    const missing = await callError(client, 'bh_explore_next', { runId: 'no-such-run' });
    assert.match(missing.message ?? '', /RUN_NOT_FOUND/);

    const started = await callValue(client, 'bh_start_run', { scope: 'full' });
    const runId = started.runId as string;

    const parallel = await Promise.all([
      client.callTool({ name: 'bh_explore_next', arguments: { runId } }),
      client.callTool({ name: 'bh_explore_next', arguments: { runId } }),
      client.callTool({ name: 'bh_explore_next', arguments: { runId } }),
    ]);
    const payloads = parallel.map((response) => {
      const content = (response.content as Array<{ type: string; text: string }>)[0];
      return JSON.parse(content.text) as Record<string, unknown>;
    });
    const tasks = payloads.filter((payload) => payload.status === 'task');
    const busies = payloads.filter((payload) => payload.status === 'busy');
    assert.equal(tasks.length, 1, JSON.stringify(payloads));
    assert.equal(busies.length, 2, JSON.stringify(payloads));
    assert.deepEqual(busies, [{ status: 'busy', activeRoute: '/' }, { status: 'busy', activeRoute: '/' }]);

    const task = tasks[0] as { leaseId: string; route: string; persona: string };

    const noLease = await callError(client, 'bh_open', { runId, route: task.route, persona: task.persona });
    assert.equal(noLease.code, 'LEASE_REQUIRED');
    const wrongLease = await callError(client, 'bh_open', { runId, route: task.route, persona: task.persona, leaseId: 'wrong' });
    assert.equal(wrongLease.code, 'LEASE_UNKNOWN');
    const mismatch = await callError(client, 'bh_open', { runId, route: '/orders', persona: task.persona, leaseId: task.leaseId });
    assert.equal(mismatch.code, 'LEASE_MISMATCH');

    const stored = await readRun(runId, stateDir);
    assert.equal(stored.exploreQueue?.[0]?.status, 'leased', 'failed opens must not consume the lease');
    assert.equal(stored.exploreQueue?.[0]?.leaseId, task.leaseId);
  } finally {
    await client.close();
  }
});
