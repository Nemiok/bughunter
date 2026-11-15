import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { execFile as execFileCallback } from 'node:child_process';
import { constants } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const execFile = promisify(execFileCallback);
const presetRoot = resolve(import.meta.dirname, '..');
const productRoot = resolve(presetRoot, '../..');

/** 11 инструментов core + 5 инструментов node-пресета. */
const toolNames = [
  'bh_start_run', 'bh_resume_run', 'bh_explore_next', 'bh_finish_run', 'bh_report_candidate',
  'bh_reproduce', 'bh_triage', 'bh_promote_finding', 'bh_export_test', 'bh_detect_tests',
  'bh_verify_red', 'bh_open', 'bh_state', 'bh_act', 'bh_sweep', 'bh_close',
];

function cleanEnvironment(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? tmpdir(),
  };
}

function portableFilter(source: string): boolean {
  const relativePath = relative(productRoot, source).split(sep).join('/');
  if (relativePath === '') return true;
  if (relativePath.split('/').includes('node_modules')) return false;
  if (relativePath.includes('.playwright-output')) return false;
  // Состояние разработчика в копию не едет: установка обязана начинать с чистого листа.
  return !/^presets\/[^/]+\/state\/(runs|auth)(\/|$)/.test(relativePath);
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}

async function startCopiedFixture(serverJs: string): Promise<{ child: ChildProcess; baseUrl: string }> {
  const port = await freePort();
  const child = spawn(process.execPath, [serverJs], {
    cwd: resolve(serverJs, '../..'),
    env: { ...cleanEnvironment(), PORT: String(port) },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`FIXTURE_START_TIMEOUT: ${port}`)), 20_000);
    let buffer = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      if (/^listening \d+$/m.test(buffer)) {
        clearTimeout(timer);
        done();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      fail(new Error(`FIXTURE_EXITED: ${code}`));
    });
  });
  return { child, baseUrl: `http://127.0.0.1:${port}` };
}

function stopProcess(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null) return Promise.resolve();
  const exited = new Promise<void>((done) => child.once('exit', () => done()));
  child.kill('SIGTERM');
  return exited;
}

async function callValue(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await client.callTool({ name, arguments: args });
  assert.equal(response.isError === true, false, `${name}: ${JSON.stringify(response.content)}`);
  const content = (response.content as Array<{ type: string; text: string }>)[0]!;
  assert.equal(content.type, 'text');
  return JSON.parse(content.text) as Record<string, unknown>;
}

async function callError(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await client.callTool({ name, arguments: args });
  assert.equal(response.isError, true, `${name}: ошибка не возвращена`);
  const content = (response.content as Array<{ type: string; text: string }>)[0]!;
  return JSON.parse(content.text) as Record<string, unknown>;
}

test('a portable copy serves sixteen tools and keeps its own state', { timeout: 900_000 }, async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'bh-node-portable-'));
  const productCopy = join(projectRoot, '.qwen', 'bughunter');
  const stateDir = join(productCopy, 'presets', 'node', 'state');
  let fixture: ChildProcess | undefined;
  let transport: StdioClientTransport | undefined;
  try {
    await cp(productRoot, productCopy, {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
      filter: portableFilter,
    });
    assert.ok(!(await stat(join(productCopy, 'node_modules')).then(() => true, () => false)));
    assert.ok(!(await stat(join(stateDir, 'runs')).then(() => true, () => false)));

    // Прогон ищет корень проекта по `.git`, поэтому копия — настоящий репозиторий.
    await execFile('git', ['init', '-b', 'main', projectRoot]);
    await execFile('npm', ['ci', '--no-audit', '--no-fund'], { cwd: productCopy });
    assert.ok((await lstat(join(productCopy, 'node_modules', '@bughunter', 'node'))).isSymbolicLink(), 'npm ci не создал симлинк воркспейса @bughunter/node');

    const stand = await startCopiedFixture(join(productCopy, 'fixtures', 'node-api-app', 'src', 'server.js'));
    fixture = stand.child;
    // Конфиг копии указывает на стенд из копии: разработческое состояние не используется.
    const config = JSON.parse(await readFile(join(stateDir, 'config.json'), 'utf8')) as Record<string, unknown>;
    await writeFile(join(stateDir, 'config.json'), JSON.stringify({
      ...config,
      baseUrl: stand.baseUrl,
      allowedHosts: ['127.0.0.1'],
    }, null, 2), 'utf8');

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(productCopy, 'presets', 'node', 'src', 'index.ts')],
      cwd: projectRoot,
      env: { ...cleanEnvironment(), BUGHUNTER_STATE_DIR: stateDir },
      stderr: 'ignore',
    });
    const client = new Client({ name: 'bh-node-portable', version: '0.0.0' });
    await client.connect(transport);

    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    assert.equal(names.length, 16, `инструментов: ${names.length}`);
    assert.deepEqual(names, [...toolNames].sort());

    const started = await callValue(client, 'bh_start_run', { scope: 'target', target: 'GET /health' });
    assert.equal(typeof started.runId, 'string');
    assert.deepEqual(started.targets, ['GET /health']);

    const runId = started.runId as string;
    // Без lease сессию не открыть: очередь исследования принадлежит core.
    assert.equal(
      (await callError(client, 'bh_open', { runId, target: 'GET /health', persona: 'интегратор' })).code,
      'LEASE_REQUIRED',
    );

    // Цели вне инвентаря отклоняются, а состояние копии остаётся её собственным.
    assert.equal(
      (await callError(client, 'bh_start_run', { scope: 'target', target: 'GET /nope' })).code,
      'TARGET_NOT_ALLOWED',
    );
    assert.ok((await readdir(join(stateDir, 'runs'))).includes(runId));
    // Прогон копии не должен писать в состояние разработчика: проверяем именно этот runId,
    // потому что в `state/runs` разработки законно лежат изъятые доказательства прошлых прогонов.
    const developerRuns = await readdir(join(presetRoot, 'state', 'runs')).catch(() => [] as string[]);
    assert.ok(!developerRuns.includes(runId), `прогон копии попал в состояние разработчика: ${runId}`);

    await client.close();
  } finally {
    await transport?.close().catch(() => undefined);
    await stopProcess(fixture);
    await rm(projectRoot, { recursive: true, force: true });
  }
});
