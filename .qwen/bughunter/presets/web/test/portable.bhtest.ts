import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { execFile as execFileCallback } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Run } from '@bughunter/core';
import type { WebConfig as Config } from '../src/config.ts';

const execFile = promisify(execFileCallback);
const presetRoot = resolve(import.meta.dirname, '..');
const productRoot = resolve(presetRoot, '../..');
const workspaceRoot = resolve(productRoot, '../..');
const fixtureRoot = join(productRoot, 'fixtures');
const sourceDemo = join(fixtureRoot, 'buggy-app');
const toolNames = [
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

function cleanEnvironment(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
    entry[1] !== undefined && !entry[0].startsWith('BUGHUNTER_'),
  ));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`);
}

async function copyPortableProject(destination: string): Promise<void> {
  await cp(sourceDemo, destination, {
    recursive: true,
    filter: (source) => !relative(sourceDemo, source).split(sep).includes('node_modules'),
  });
  const staging = await mkdtemp(join(tmpdir(), 'bh-portable-copy-'));
  try {
    await cp(join(workspaceRoot, '.qwen'), join(staging, '.qwen'), {
      recursive: true,
      filter(source) {
        const path = relative(workspaceRoot, source).split(sep);
        return !path.includes('node_modules')
          && relative(workspaceRoot, source) !== '.qwen/bughunter/presets/web/state/runs'
          && relative(workspaceRoot, source) !== '.qwen/bughunter/presets/web/state/auth';
      },
    });
    await cp(join(staging, '.qwen'), join(destination, '.qwen'), { recursive: true });
    await cp(join(workspaceRoot, '.mcp.json'), join(destination, '.mcp.json'));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function run(command: string, args: string[], cwd: string): Promise<string> {
  const { stdout, stderr } = await execFile(command, args, {
    cwd,
    env: cleanEnvironment(),
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  return `${stdout}${stderr}`;
}

async function availablePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolveListen, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolveListen);
  });
  const address = probe.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => {
    probe.close((error) => error ? reject(error) : resolveClose());
  });
  return port;
}

async function startDemo(projectRoot: string): Promise<{ child: ChildProcess; baseUrl: string; output: () => string }> {
  const port = await availablePort();
  const child = spawn(process.execPath, [
    join(projectRoot, 'node_modules/vite/bin/vite.js'),
    '--host', '127.0.0.1', '--port', String(port), '--strictPort',
  ], {
    cwd: projectRoot,
    env: cleanEnvironment(),
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Copied demo exited early: ${output}`);
      try {
        const response = await fetch(baseUrl);
        if (response.ok) return { child, baseUrl, output: () => output };
      } catch {
        // Vite may still be starting.
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    throw new Error(`Copied demo did not start: ${output}`);
  } catch (error) {
    await stopProcess(child);
    throw error;
  }
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => child.once('exit', resolveExit));
  try {
    if (process.platform === 'win32') child.kill('SIGTERM');
    else process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  await exited;
}

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

async function callValue(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await client.callTool({ name, arguments: args });
  assert.notEqual(response.isError, true, `${name}: ${JSON.stringify(response.content)}`);
  assert.ok(Array.isArray(response.content));
  assert.equal(response.content.length, 1);
  const content = response.content[0] as { type: string; text: string };
  assert.equal(content.type, 'text');
  const value = JSON.parse(content.text) as unknown;
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

test('demo process stop waits for child exit', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: process.platform !== 'win32',
    stdio: 'ignore',
  });
  await stopProcess(child);
  assert.equal(child.signalCode, 'SIGTERM');
});

test('clean copied project is self-contained and isolates project tools', { timeout: 240_000 }, async () => {
  const projectRoot = await mkdtemp(join(fixtureRoot, 'portable-'));
  let demo: Awaited<ReturnType<typeof startDemo>> | undefined;
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  try {
    await copyPortableProject(projectRoot);
    assert.equal(await pathExists(join(projectRoot, 'node_modules')), false);
    assert.equal(await pathExists(join(projectRoot, '.qwen/bughunter/node_modules')), false);
    assert.equal(await pathExists(join(projectRoot, '.qwen/bughunter/presets/web/state/runs')), false);
    assert.equal(await pathExists(join(projectRoot, '.qwen/bughunter/presets/web/state/auth')), false);
    await run('git', ['init', '--initial-branch=main'], projectRoot);
    await run('npm', ['ci', '--no-audit', '--no-fund'], join(projectRoot, '.qwen/bughunter'));
    await run('npm', ['ci', '--no-audit', '--no-fund'], projectRoot);

    const packageJson = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const tsconfig = JSON.parse(await readFile(join(projectRoot, 'tsconfig.json'), 'utf8')) as { include?: string[] };
    assert.deepEqual(tsconfig.include, ['src', 'vite.config.ts']);
    assert.equal(packageJson.dependencies?.jest, undefined);
    assert.equal(packageJson.devDependencies?.jest, undefined);
    assert.equal(packageJson.devDependencies?.eslint, undefined);
    assert.equal(packageJson.scripts?.lint, undefined);
    await writeFile(join(projectRoot, 'vitest.config.ts'), `import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: { exclude: [...configDefaults.exclude, '**/.qwen/**'] },
});
`, 'utf8');
    const typecheck = await run('npm', ['exec', '--', 'tsc', '--noEmit', '--listFiles'], projectRoot);
    const compiledFiles = typecheck.split(/\r?\n/).map((file) => file.trim()).filter(Boolean);
    assert.equal(compiledFiles.some((file) => inside(join(projectRoot, '.qwen'), file)), false, typecheck);
    const unitTests = await run('npm', ['test', '--', '--run', '--reporter=verbose'], projectRoot);
    assert.match(unitTests, /2 passed/);
    assert.equal(unitTests.includes('.bhtest.ts'), false, unitTests);

    demo = await startDemo(projectRoot);
    const stateDir = join(projectRoot, '.qwen/bughunter/presets/web/state');
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'config.json'), `${JSON.stringify(demoConfig(demo.baseUrl), null, 2)}\n`, 'utf8');
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(projectRoot, '.qwen/bughunter/presets/web/src/index.ts')],
      cwd: projectRoot,
      env: cleanEnvironment(),
      stderr: 'pipe',
    });
    let serverErrors = '';
    transport.stderr?.on('data', (chunk: Buffer) => { serverErrors += chunk.toString(); });
    client = new Client({ name: 'bughunter-portability', version: '1.0.0' });
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [...toolNames].sort());

    const detected = await callValue(client, 'bh_detect_tests', { path: join(projectRoot, 'src/profile.test.ts') });
    assert.equal(detected.framework, 'vitest');
    const verified = await callValue(client, 'bh_verify_red', { testFile: join(projectRoot, 'src/profile.test.ts') });
    assert.equal(verified.status, 'green', JSON.stringify(verified));

    const started = await callValue(client, 'bh_start_run', { scope: 'full' });
    const runId = started.runId;
    assert.equal(typeof runId, 'string');
    const storedRun = JSON.parse(await readFile(join(stateDir, 'runs', runId as string, 'run.json'), 'utf8')) as Run;
    assert.equal(storedRun.id, runId);
    assert.equal(storedRun.scope, 'full');

    const profileTask = await callValue(client, 'bh_explore_next', { runId, target: '/profile' });
    assert.equal(profileTask.status, 'task', JSON.stringify(profileTask));
    const opened = await callValue(client, 'bh_open', {
      runId, target: profileTask.target, persona: profileTask.persona, leaseId: profileTask.leaseId,
    });
    const sessionId = opened.sessionId;
    assert.equal(typeof sessionId, 'string');
    const state = await callValue(client, 'bh_state', { sessionId });
    const elements = state.elements as Array<Record<string, unknown>>;
    const name = elements.find((element) => element.name === 'Name');
    const save = elements.find((element) => element.name === 'Save');
    assert.ok(name && save);
    await callValue(client, 'bh_act', { sessionId, elementId: name.id, action: 'fill', value: '' });
    const saved = await callValue(client, 'bh_act', { sessionId, elementId: save.id, action: 'click' });
    const signals = saved.signals as Array<{ id: string }>;
    const navigated = await callValue(client, 'bh_navigate', { sessionId, path: '/profile' });
    assert.equal(navigated.url, `${demo.baseUrl}/profile`);
    await callValue(client, 'bh_probe', { sessionId, kind: 'reload' });
    const reported = await callValue(client, 'bh_report_candidate', {
      sessionId,
      title: 'Portable profile failure',
      expected: 'Profile saves without a page error',
      actual: 'Saving an empty profile raises a page error',
      signalIds: signals.map((signal) => signal.id),
    });
    const candidateId = reported.candidateId;
    assert.equal(typeof candidateId, 'string');
    const reproduced = await callValue(client, 'bh_reproduce', { runId, candidateId });
    assert.equal(reproduced.reproduced, '3/3');
    await callValue(client, 'bh_triage', {
      runId, candidateId, verdict: 'confirmed', reason: 'Portable copy reproduced the page error',
    });
    const exported = await callValue(client, 'bh_export_test', { runId, bugId: candidateId });
    assert.equal(exported.placedInProject, true);
    assert.equal(typeof exported.file, 'string');
    assert.equal(inside(projectRoot, exported.file as string), true, String(exported.file));
    const verifiedE2e = await callValue(client, 'bh_verify_red', {
      testFile: exported.file, runId, candidateId, kind: 'e2e',
    });
    assert.equal(verifiedE2e.status, 'red', JSON.stringify(verifiedE2e));
    const resumed = await callValue(client, 'bh_resume_run', { runId });
    assert.deepEqual(resumed.candidates, []);
    assert.deepEqual(await callValue(client, 'bh_close', { sessionId }), { ok: true });
    for (const route of ['/', '/orders', '/orders/new', '/clean']) {
      const routeTask = await callValue(client, 'bh_explore_next', { runId, target: route });
      assert.equal(routeTask.status, 'task', JSON.stringify(routeTask));
      const completed = await callValue(client, 'bh_open', {
        runId, target: routeTask.target, persona: routeTask.persona, leaseId: routeTask.leaseId,
      });
      await callValue(client, 'bh_close', { sessionId: completed.sessionId });
    }
    const finished = await callValue(client, 'bh_finish_run', { runId });
    assert.equal(finished.report, join(stateDir, 'runs', runId as string, 'report.md'));
    assert.equal(inside(stateDir, finished.report as string), true);
    assert.match(await readFile(finished.report as string, 'utf8'), /Portable profile failure/);
    assert.equal(serverErrors.includes(workspaceRoot), false, serverErrors);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}${demo ? `\nDemo output: ${demo.output()}` : ''}`);
  } finally {
    const connections = await Promise.allSettled([client?.close(), transport?.close()]);
    if (demo) await stopProcess(demo.child);
    const removal = await Promise.allSettled([rm(projectRoot, { recursive: true, force: true })]);
    assert.deepEqual([...connections, ...removal].filter((entry) => entry.status === 'rejected'), []);
  }
});
