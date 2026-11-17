import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SessionManager } from '../src/browser/session.ts';
import { createRun } from '../src/runs.ts';
import type { Signal } from '@bughunter/core';
import type { WebConfig as Config } from '../src/config.ts';

const fixtureRoot = resolve(import.meta.dirname, '../../../fixtures/buggy-app');
const serverRoot = resolve(import.meta.dirname, '..');
const coreToolNames = [
  'bh_start_run',
  'bh_resume_run',
  'bh_explore_next',
  'bh_open',
  'bh_state',
  'bh_act',
  'bh_navigate',
  'bh_probe',
  'bh_crawl',
  'bh_sweep',
  'bh_promote_finding',
  'bh_report_candidate',
  'bh_reproduce',
  'bh_triage',
  'bh_export_test',
  'bh_detect_tests',
  'bh_verify_red',
  'bh_finish_run',
  'bh_close',
];

function demoConfig(baseUrl: string): Config {
  return {
    baseUrl,
    allowedOrigins: [baseUrl],
    routes: ['/', '/profile', '/orders', '/orders/new', '/clean'],
    targetMap: {},
    baseBranch: 'main',
    limits: { stepsPerSession: 60, candidatesPerRun: 20 },
    safety: { forbiddenActionText: ['delete'], readOnly: false },
    testDataPrefix: 'bh_',
    detectors: {
      ignoreConsole: [],
      ignoreRequests: [],
      anomalyTexts: ['undefined', 'NaN', '[object Object]', 'Invalid Date'],
      errorBoundarySelector: '[data-error-boundary]',
    },
    tests: { unit: { command: null }, generated: { dir: 'e2e/bughunter' } },
  };
}

async function elementByTestId(manager: SessionManager, sessionId: string, testId: string) {
  const state = await manager.state(sessionId);
  const element = state.elements.find((candidate) =>
    candidate.locator.kind === 'testid' && candidate.locator.value === testId,
  );
  assert.ok(element, `Missing data-testid=${testId}`);
  return element;
}

async function fillByTestId(manager: SessionManager, sessionId: string, testId: string, value: string) {
  const element = await elementByTestId(manager, sessionId, testId);
  const result = await manager.act(sessionId, { elementId: element.id, action: 'fill', value });
  assert.equal(result.ok, true, result.error);
  return result;
}

async function clickByTestId(manager: SessionManager, sessionId: string, testId: string) {
  const element = await elementByTestId(manager, sessionId, testId);
  const result = await manager.act(sessionId, { elementId: element.id, action: 'click' });
  assert.equal(result.ok, true, result.error);
  return result;
}

function signalsOfType(signals: Signal[], kind: string): Signal[] {
  return signals.filter((signal) => signal.kind === kind);
}

test('scripted real-Chrome discovery finds seeded bugs 1, 2, 4 and 5 and stays clean', { timeout: 60_000 }, async () => {
  const { createServer } = await import('../../../fixtures/buggy-app/node_modules/vite/dist/node/index.js');
  const vite = await createServer({
    root: fixtureRoot,
    configFile: join(fixtureRoot, 'vite.config.ts'),
    server: { host: '127.0.0.1', port: 0 },
  });
  const stateDir = await mkdtemp(join(tmpdir(), 'bh-core-'));
  let manager: SessionManager | undefined;
  try {
    await vite.listen();
    const address = vite.httpServer?.address();
    assert.ok(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const config = demoConfig(baseUrl);
    const run = await createRun('full', undefined, { config, projectRoot: fixtureRoot, stateDir });
    manager = new SessionManager(config, stateDir);

    const profile = await manager.open(run.id, '/profile', 'scripted');
    await fillByTestId(manager, profile.sessionId, 'profile-name', '');
    const profileClick = await clickByTestId(manager, profile.sessionId, 'profile-save');
    assert.ok(signalsOfType(profileClick.signals, 'pageerror').length > 0);

    const newOrder = await manager.open(run.id, '/orders/new', 'scripted');
    await fillByTestId(manager, newOrder.sessionId, 'order-quantity', '0');
    const orderClick = await clickByTestId(manager, newOrder.sessionId, 'order-create');
    assert.ok(signalsOfType(orderClick.signals, 'response').some((signal) => signal.message.includes('500')));

    const orders = await manager.open(run.id, '/orders', 'scripted');
    const ordersState = await manager.probe(orders.sessionId, 'reload');
    assert.ok(signalsOfType(ordersState.signals, 'anomaly').some((signal) => signal.message.includes('NaN')));

    const pageTwo = await manager.open(run.id, '/orders?page=2', 'scripted');
    await manager.state(pageTwo.sessionId);
    const reloaded = await manager.probe(pageTwo.sessionId, 'reload');
    assert.ok(signalsOfType(reloaded.signals, 'console').some((signal) => signal.message.includes('filter reset')));

    const clean = await manager.open(run.id, '/clean', 'scripted');
    const cleanState = await manager.state(clean.sessionId);
    assert.deepEqual(cleanState.signals, []);
  } finally {
    try {
      await manager?.closeAll();
    } finally {
      try {
        await vite.close();
      } finally {
        await rm(stateDir, { recursive: true, force: true });
      }
    }
  }
});

async function callValue(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await client.callTool({ name, arguments: args });
  assert.notEqual(response.isError, true, JSON.stringify(response.content));
  assert.ok(Array.isArray(response.content));
  assert.equal(response.content.length, 1);
  const content = response.content[0] as { type: string; text: string };
  assert.equal(content.type, 'text');
  const value = JSON.parse(content.text) as unknown;
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

async function leaseFor(client: Client, runId: string, target: string): Promise<{ leaseId: string; target: string; persona: string }> {
  const next = await callValue(client, 'bh_explore_next', { runId, target });
  assert.equal(next.status, 'task', JSON.stringify(next));
  return { leaseId: next.leaseId as string, target: next.target as string, persona: next.persona as string };
}

async function openLeased(client: Client, runId: string, target: string): Promise<Record<string, unknown>> {
  const task = await leaseFor(client, runId, target);
  return callValue(client, 'bh_open', { runId, target: task.target, persona: task.persona, leaseId: task.leaseId });
}

test('real MCP stdio client validates strict schemas and compact core results', { timeout: 60_000 }, async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'bh-mcp-'));
  const stateDir = join(projectRoot, 'state');
  const fixture = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(`<title>Compact fixture</title><main>
      <label>Name <input data-testid="profile-name"></label>
      <button type="button" data-testid="profile-save">Save</button>
      <form><button data-testid="submit-profile">Submit profile</button></form>
    </main>`);
  });
  await new Promise<void>((resolveListen) => fixture.listen(0, '127.0.0.1', resolveListen));
  const address = fixture.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const config = demoConfig(baseUrl);
  config.safety.readOnly = true;
  await mkdir(join(projectRoot, '.git'), { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, 'config.json'), JSON.stringify(config), 'utf8');
  const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(serverRoot, 'src/index.ts')],
    cwd: projectRoot,
    env: { ...environment, BUGHUNTER_STATE_DIR: stateDir },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'bughunter-integration', version: '1.0.0' });
  let stderr = '';
  transport.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [...coreToolNames].sort());
    assert.ok(listed.tools.every((tool) => tool.description && /[А-Яа-я]/.test(tool.description)));
    const requiredInputs: Record<string, string[]> = {
      bh_start_run: ['scope'],
      bh_resume_run: ['runId'],
      bh_explore_next: ['runId'],
      bh_open: ['persona', 'runId', 'target'],
      bh_state: ['sessionId'],
      // elementId необязателен: координатные действия (clickAt, hoverAt) и скролл страницы цели не имеют.
      bh_act: ['action', 'sessionId'],
      bh_navigate: ['path', 'sessionId'],
      bh_probe: ['kind', 'sessionId'],
      bh_crawl: [],
      bh_sweep: ['runId'],
      bh_promote_finding: ['actual', 'expected', 'findingId', 'runId', 'title'],
      bh_report_candidate: ['actual', 'expected', 'sessionId', 'signalIds', 'title'],
      bh_reproduce: ['candidateId', 'runId'],
      bh_triage: ['candidateId', 'reason', 'runId', 'verdict'],
      bh_export_test: ['bugId', 'runId'],
      bh_detect_tests: ['path'],
      bh_verify_red: ['testFile'],
      bh_finish_run: ['runId'],
      bh_close: ['sessionId'],
    };
    for (const tool of listed.tools) {
      const schema = tool.inputSchema as { additionalProperties?: boolean; required?: string[] };
      assert.equal(schema.additionalProperties, false, tool.name);
      assert.deepEqual([...(schema.required ?? [])].sort(), requiredInputs[tool.name], tool.name);
    }

    const detected = await callValue(client, 'bh_detect_tests', {
      path: resolve(import.meta.dirname, '../../../fixtures/jest-project/sum.test.js'),
    });
    assert.deepEqual(detected, {
      framework: 'jest',
      command: 'npm exec -- jest',
      examples: ['broken.test.js', 'green.test.js', 'import.test.js'],
    });
    const verified = await callValue(client, 'bh_verify_red', {
      testFile: resolve(import.meta.dirname, '../../../fixtures/jest-project/green.test.js'),
    });
    assert.equal(verified.status, 'green', JSON.stringify(verified));

    const started = await callValue(client, 'bh_start_run', { scope: 'full' });
    assert.deepEqual(Object.keys(started).sort(), ['runId', 'targets']);
    const runId = started.runId;
    assert.equal(typeof runId, 'string');
    assert.deepEqual(started.targets, config.routes);

    const opened = await openLeased(client, runId as string, '/profile');
    assert.deepEqual(Object.keys(opened), ['sessionId']);
    const sessionId = opened.sessionId;
    assert.equal(typeof sessionId, 'string');

    const state = await callValue(client, 'bh_state', { sessionId });
    assert.deepEqual(Object.keys(state).sort(), [
      'elements', 'screen', 'signals', 'stepsLeft', 'title', 'totalVisible', 'truncated', 'url',
    ]);
    assert.equal(state.truncated, false);
    assert.deepEqual(state.screen, { widgets: [] });
    const elements = state.elements as Array<Record<string, unknown>>;
    assert.equal(state.totalVisible, elements.length);
    assert.ok(elements.every((element) => !('locator' in element)));
    const name = elements.find((element) => element.name === 'Name');
    const save = elements.find((element) => element.name === 'Save');
    const submit = elements.find((element) => element.name === 'Submit profile');
    assert.ok(name && save && submit);

    const filled = await callValue(client, 'bh_act', {
      sessionId, elementId: name.id, action: 'fill', value: 'Alice',
    });
    assert.deepEqual(Object.keys(filled).sort(), ['navigated', 'ok', 'signals']);
    assert.equal(filled.ok, true);
    const saved = await callValue(client, 'bh_act', { sessionId, elementId: save.id, action: 'click' });
    assert.deepEqual(Object.keys(saved).sort(), ['navigated', 'ok', 'signals']);

    const blocked = await client.callTool({
      name: 'bh_act', arguments: { sessionId, elementId: submit.id, action: 'click' },
    });
    assert.equal(blocked.isError, true);
    assert.ok(Array.isArray(blocked.content));
    const blockedContent = blocked.content[0] as { type: string; text: string };
    const blockedValue = JSON.parse(blockedContent.text) as { code?: string };
    assert.equal(blockedValue.code, 'FORBIDDEN_ACTION');

    const reported = await callValue(client, 'bh_report_candidate', {
      sessionId,
      title: 'Profile invariant',
      expected: 'Saved profile',
      actual: 'Missing saved profile',
      signalIds: [],
      check: { kind: 'visibleText', target: 'Saved', expected: 'Saved' },
    });
    assert.deepEqual(Object.keys(reported), ['candidateId']);
    const candidateId = reported.candidateId;

    const reproduced = await callValue(client, 'bh_reproduce', { runId, candidateId });
    assert.deepEqual(Object.keys(reproduced).sort(), ['artifacts', 'minimalSteps', 'reproduced', 'signature', 'steps']);
    assert.equal(reproduced.reproduced, '3/3');
    assert.equal(reproduced.steps, 2);
    assert.equal(reproduced.minimalSteps, 0);
    assert.ok(Array.isArray(reproduced.artifacts) && reproduced.artifacts.length >= 12);

    const triaged = await callValue(client, 'bh_triage', {
      runId, candidateId, verdict: 'confirmed', reason: 'Reproduced invariant violation',
    });
    assert.equal(triaged.id, candidateId);
    assert.equal(triaged.status, 'confirmed');

    const exported = await callValue(client, 'bh_export_test', { runId, bugId: candidateId });
    assert.deepEqual(Object.keys(exported).sort(), ['file', 'placedInProject']);
    assert.equal(exported.placedInProject, false);
    assert.equal(typeof exported.file, 'string');
    const unitTestFile = resolve(import.meta.dirname, '../../../fixtures/jest-project/green.test.js');
    const associated = await callValue(client, 'bh_verify_red', {
      testFile: relative(await realpath(projectRoot), unitTestFile), runId, candidateId, kind: 'unit',
    });
    assert.equal(associated.status, 'green', JSON.stringify(associated));

    const resumed = await callValue(client, 'bh_resume_run', { runId });
    assert.deepEqual(Object.keys(resumed).sort(), ['candidates', 'runId', 'stages']);
    assert.equal(resumed.runId, runId);
    assert.deepEqual(resumed.stages, { explore: 'running', reproduce: 'done', triage: 'done', export: 'done' });
    assert.deepEqual(resumed.candidates, []);

    const closed = await callValue(client, 'bh_close', { sessionId });
    assert.deepEqual(closed, { ok: true });

    const raceTask = await leaseFor(client, runId as string, '/orders');
    const contested = await Promise.all([
      client.callTool({ name: 'bh_open', arguments: { runId, target: raceTask.target, persona: raceTask.persona, leaseId: raceTask.leaseId } }),
      client.callTool({ name: 'bh_open', arguments: { runId, target: raceTask.target, persona: raceTask.persona, leaseId: raceTask.leaseId } }),
    ]);
    const succeeded = contested.filter((response) => response.isError !== true);
    const busyResponses = contested.filter((response) => response.isError === true);
    assert.equal(succeeded.length, 1);
    assert.equal(busyResponses.length, 1);
    assert.ok(Array.isArray(busyResponses[0]?.content));
    const busyContent = busyResponses[0]?.content[0] as { type: string; text: string };
    assert.equal((JSON.parse(busyContent.text) as { code?: string }).code, 'EXPLORER_BUSY');
    const contestedRun = JSON.parse(await readFile(join(stateDir, 'runs', runId as string, 'run.json'), 'utf8')) as {
      targetStages: Record<string, string>;
    };
    assert.equal(Object.values(contestedRun.targetStages).filter((status) => status === 'exploring').length, 1);
    assert.ok(Array.isArray(succeeded[0]?.content));
    const successContent = succeeded[0]?.content[0] as { type: string; text: string };
    const contestedSession = (JSON.parse(successContent.text) as { sessionId: string }).sessionId;
    await callValue(client, 'bh_close', { sessionId: contestedSession });
    const released = await openLeased(client, runId as string, '/clean');
    const failedCandidate = await callValue(client, 'bh_report_candidate', {
      sessionId: released.sessionId, title: 'Close failure probe', expected: 'Clean page', actual: 'Clean page',
      signalIds: [], check: { kind: 'visibleText', target: 'Clean page', expected: 'Clean page' },
    });
    const failedCandidatePath = join(
      stateDir, 'runs', runId as string, 'candidates', `${failedCandidate.candidateId}.json`,
    );
    await rm(failedCandidatePath);
    await mkdir(failedCandidatePath);
    const failedClose = await client.callTool({ name: 'bh_close', arguments: { sessionId: released.sessionId } });
    assert.equal(failedClose.isError, true);
    assert.ok(Array.isArray(failedClose.content));
    const failedCloseContent = failedClose.content[0] as { type: string; text: string };
    assert.match((JSON.parse(failedCloseContent.text) as { message?: string }).message ?? '', /SESSION_CLOSE_FAILED/);
    await rm(failedCandidatePath, { recursive: true });
    const reopened = await openLeased(client, runId as string, '/');
    await callValue(client, 'bh_close', { sessionId: reopened.sessionId });
    // `finishRun` требует исчерпанной очереди: добираем оставшиеся пары маршрут×персона.
    for (;;) {
      const task = await callValue(client, 'bh_explore_next', { runId });
      if (task.status === 'done') break;
      assert.equal(task.status, 'task', JSON.stringify(task));
      const completed = await callValue(client, 'bh_open', {
        runId, target: task.target, persona: task.persona, leaseId: task.leaseId,
      });
      await callValue(client, 'bh_close', { sessionId: completed.sessionId });
    }

    const finished = await callValue(client, 'bh_finish_run', { runId });
    const reportPath = join(stateDir, 'runs', runId as string, 'report.md');
    assert.deepEqual(finished, { report: reportPath });
    const report = await readFile(reportPath, 'utf8');
    assert.ok(report.includes('Profile invariant'));
    assert.ok(report.includes(`unit: ${unitTestFile}`), report);
    assert.deepEqual(await callValue(client, 'bh_finish_run', { runId }), finished);
    assert.equal(await readFile(reportPath, 'utf8'), report);
    const finishedResume = await callValue(client, 'bh_resume_run', { runId });
    assert.deepEqual(Object.keys(finishedResume).sort(), ['candidates', 'runId', 'stages']);
    assert.deepEqual(finishedResume.stages, { explore: 'done', reproduce: 'done', triage: 'done', export: 'done' });
    assert.deepEqual(finishedResume.candidates, []);

    const runnerMarker = join(projectRoot, 'verify-runner-invoked');
    const runner = join(projectRoot, 'verify-runner.cjs');
    await writeFile(runner, `require('node:fs').writeFileSync(${JSON.stringify(runnerMarker)}, 'invoked');\n`, 'utf8');
    await writeFile(join(stateDir, 'config.json'), JSON.stringify({
      ...config,
      tests: { ...config.tests, unit: { command: `node ${JSON.stringify(runner)}` } },
    }), 'utf8');
    const incomplete = await client.callTool({
      name: 'bh_verify_red',
      arguments: { runId, testFile: resolve(import.meta.dirname, '../../../fixtures/jest-project/green.test.js') },
    });
    assert.equal(incomplete.isError, true);
    assert.ok(Array.isArray(incomplete.content));
    const incompleteContent = incomplete.content[0] as { type: string; text: string };
    const incompleteValue = JSON.parse(incompleteContent.text) as { code?: string; message?: string };
    assert.equal(incompleteValue.code, 'TOOL_FAILED');
    assert.match(incompleteValue.message ?? '', /TEST_ASSOCIATION_INCOMPLETE/);
    await assert.rejects(readFile(runnerMarker, 'utf8'), { code: 'ENOENT' });

    const pendingMcpId = 'pending-mcp-candidate';
    await writeFile(join(stateDir, 'runs', runId as string, 'candidates', `${pendingMcpId}.json`), JSON.stringify({
      id: pendingMcpId, runId, sessionId: 'pending-mcp-session', target: '/profile',
      title: 'Pending MCP candidate', expected: 'Expected', actual: 'Actual', signalIds: ['signal'],
      signature: 'pending-mcp-signature', steps: [], artifacts: [], status: 'unprocessed',
      createdAt: new Date().toISOString(), reproduction: { status: 'unreproduced', attempts: 0 },
    }), 'utf8');
    const guardCases = [
      {
        name: 'bh_triage',
        arguments: { runId, candidateId: pendingMcpId, verdict: 'confirmed', reason: 'Skipped reproduction' },
        code: 'CANDIDATE_UNREPRODUCED',
      },
      { name: 'bh_finish_run', arguments: { runId }, code: 'RUN_INCOMPLETE' },
    ] as const;
    for (const guardCase of guardCases) {
      const response = await client.callTool({ name: guardCase.name, arguments: guardCase.arguments });
      assert.equal(response.isError, true);
      assert.ok(Array.isArray(response.content));
      const content = response.content[0] as { type: string; text: string };
      assert.equal((JSON.parse(content.text) as { code?: string }).code, guardCase.code);
    }

    const missing = await client.callTool({ name: 'bh_resume_run', arguments: { runId: 'missing-integration-run' } });
    assert.equal(missing.isError, true);
    assert.ok(Array.isArray(missing.content));
    const missingContent = missing.content[0] as { type: string; text: string };
    const missingValue = JSON.parse(missingContent.text) as { code?: string; message?: string };
    assert.equal(missingValue.code, 'NOT_FOUND');
    assert.ok(missingValue.message && !missingValue.message.includes('\n'));
    assert.ok(missingContent.text.length < 500);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nServer stderr: ${stderr}`);
  } finally {
    const fixtureClosed = new Promise<void>((resolveClose, reject) => {
      fixture.close((error) => error ? reject(error) : resolveClose());
    });
    const cleanup = await Promise.allSettled([
      client.close(),
      transport.close(),
      fixtureClosed,
      rm(projectRoot, { recursive: true, force: true }),
    ]);
    assert.deepEqual(cleanup.filter((entry) => entry.status === 'rejected'), []);
  }
});

test('manual auth writes storage state where the session reads it', async () => {
  const auth = await import('../src/auth.ts');
  assert.deepEqual(auth.authLaunchOptions, { channel: 'chrome', headless: false });
  const expected = process.env.BUGHUNTER_STATE_DIR === undefined
    ? join(serverRoot, 'state', 'auth', 'storage-state.json')
    : join(resolve(process.env.BUGHUNTER_STATE_DIR), 'auth', 'storage-state.json');
  assert.equal(auth.authStorageStatePath, expected);
  assert.equal(typeof auth.runAuth, 'function');

  const envState = join(tmpdir(), 'bh-auth-env');
  const moduleUrl = pathToFileURL(join(serverRoot, 'src', 'auth.ts')).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { authStorageStatePath } from ${JSON.stringify(moduleUrl)}; console.log(authStorageStatePath);`],
    { encoding: 'utf8', env: { ...process.env, BUGHUNTER_STATE_DIR: envState } });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), join(envState, 'auth', 'storage-state.json'));
});

test('startup reports missing dependencies on stderr without polluting stdout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bh-startup-'));
  const entry = join(directory, 'index.ts');
  await copyFile(join(serverRoot, 'src/index.ts'), entry);
  await copyFile(join(serverRoot, 'src/cli-host.ts'), join(directory, 'cli-host.ts'));
  await copyFile(join(serverRoot, 'src/paths.ts'), join(directory, 'paths.ts'));
  // Модульные импорты точки входа копируются вместе с ней: они не тянут сторонних зависимостей
  // (только типы core), поэтому дружелюбная подсказка об отсутствии node_modules сохраняется.
  await copyFile(join(serverRoot, 'src/errors.ts'), join(directory, 'errors.ts'));
  await copyFile(join(serverRoot, 'src/checks.ts'), join(directory, 'checks.ts'));
  await copyFile(join(serverRoot, 'src/snapshot.ts'), join(directory, 'snapshot.ts'));
  try {
    const child = spawn(process.execPath, [entry], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      child.once('error', reject);
      child.once('exit', resolveExit);
    });
    assert.notEqual(exitCode, 0);
    assert.equal(stdout, '');
    assert.ok(stderr.includes('Зависимости Bughunter не установлены. Выполните: cd .qwen/bughunter && npm ci'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
