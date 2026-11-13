import assert from 'node:assert/strict';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { after, test } from 'node:test';
import { defaultElementsPerSnapshot, ensureConfig, loadConfig } from '../src/config.ts';
import { findProjectRoot } from '../src/project.ts';
import { createRun, readRun, updateRun, writeJsonAtomic } from '../src/run-store.ts';
import type { Config } from '@bughunter/core';

const execFile = promisify(execFileCallback);
const temporaryDirectories: string[] = [];

after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function configTemplate(): Config {
  return {
    baseUrl: 'https://dev-stand.example.local',
    allowedOrigins: ['https://dev-stand.example.local'],
    routes: ['/', '/orders', '/orders/new', '/profile'],
    routeMap: { 'src/pages/orders/**': ['/orders', '/orders/new'] },
    baseBranch: 'main',
    limits: { stepsPerSession: 60, candidatesPerRun: 20, elementsPerSnapshot: defaultElementsPerSnapshot },
    safety: { forbiddenActionText: ['удалить', 'delete', 'оплатить'], readOnly: false },
    testDataPrefix: 'bh_',
    detectors: {
      ignoreConsole: [],
      ignoreRequests: [],
      anomalyTexts: ['undefined', 'NaN', '[object Object]', 'Invalid Date'],
      errorBoundarySelector: '[data-error-boundary]',
    },
    tests: { unit: { command: null }, e2e: { dir: 'e2e/bughunter' } },
  };
}

async function writeConfig(stateDir: string, config: unknown): Promise<string> {
  await mkdir(stateDir, { recursive: true });
  const file = join(stateDir, 'config.json');
  await writeFile(file, JSON.stringify(config), 'utf8');
  return file;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFile('git', args, { cwd });
}

async function createDiffRepository(changedFile: string): Promise<string> {
  const root = await temporaryDirectory('bh-git-');
  await git(root, 'init', '-b', 'main');
  await git(root, 'config', 'user.email', 'bughunter@example.invalid');
  await git(root, 'config', 'user.name', 'Bughunter Test');
  await mkdir(join(root, 'src/pages/orders'), { recursive: true });
  await writeFile(join(root, 'src/pages/orders/index.ts'), 'export const orders = 1;\n');
  await writeFile(join(root, 'README.md'), 'base\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'base');
  await git(root, 'checkout', '-b', 'feature');
  await mkdir(join(root, changedFile, '..'), { recursive: true });
  await writeFile(join(root, changedFile), 'changed\n');
  await git(root, 'add', '.');
  await git(root, 'commit', '-m', 'change');
  return root;
}

test('missing config creates template without starting a run', async () => {
  const root = await temporaryDirectory('bh-config-');
  const result = await ensureConfig(root);
  assert.equal(result.config, undefined);
  assert.equal(result.createdPath, join(root, 'config.json'));
  const written = JSON.parse(await readFile(result.createdPath!, 'utf8'));
  assert.deepEqual(written, configTemplate());
  assert.equal(written.limits.stepsPerSession, 60);
});

test('existing valid config loads without being recreated', async () => {
  const root = await temporaryDirectory('bh-config-');
  const file = await writeConfig(root, configTemplate());
  assert.deepEqual(await loadConfig(root), configTemplate());
  assert.deepEqual(await ensureConfig(root), { config: configTemplate() });
  assert.equal(JSON.parse(await readFile(file, 'utf8')).baseBranch, 'main');
});

test('malformed config JSON includes the concrete path', async () => {
  const root = await temporaryDirectory('bh-config-');
  await mkdir(root, { recursive: true });
  const file = join(root, 'config.json');
  await writeFile(file, '{ not json', 'utf8');
  await assert.rejects(loadConfig(root), (error) => {
    assert.match(String(error), /^Error: CONFIG_INVALID: /);
    assert.ok(String(error).includes(file));
    return true;
  });
});

test('invalid and unknown config fields include the concrete path and Zod issue', async () => {
  const root = await temporaryDirectory('bh-config-');
  const invalid = configTemplate();
  invalid.limits.stepsPerSession = 0;
  const file = await writeConfig(root, invalid);
  await assert.rejects(loadConfig(root), (error) => {
    assert.ok(String(error).includes(`CONFIG_INVALID: ${file}:`));
    assert.match(String(error), /limits\.stepsPerSession|Too small/);
    return true;
  });

  await writeConfig(root, { ...configTemplate(), unexpected: true });
  await assert.rejects(loadConfig(root), (error) => {
    assert.ok(String(error).includes(`CONFIG_INVALID: ${file}:`));
    assert.match(String(error), /unexpected|Unrecognized key/);
    return true;
  });
});

test('project root is found by walking up to .git', async () => {
  const root = await temporaryDirectory('bh-project-');
  await mkdir(join(root, '.git'));
  const nested = join(root, 'src/nested');
  await mkdir(nested, { recursive: true });
  assert.equal(await findProjectRoot(nested), root);
});

test('diff run uses git diff and routeMap to select routes', async () => {
  const projectRoot = await createDiffRepository('src/pages/orders/details.ts');
  const stateDir = await temporaryDirectory('bh-run-');
  const run = await createRun('diff', undefined, { config: configTemplate(), projectRoot, stateDir });
  assert.deepEqual(run.routes, ['/orders', '/orders/new']);
  assert.equal(run.scope, 'diff');
  assert.match(run.id, /^\d{8}T\d{6}\.\d{3}Z-[a-f0-9]+$/);
  assert.deepEqual((await readRun(run.id, stateDir)).routes, run.routes);
});

test('diff run falls back to all routes when no route-map glob matches', async () => {
  const projectRoot = await createDiffRepository('README.md');
  const stateDir = await temporaryDirectory('bh-run-');
  const run = await createRun('diff', undefined, { config: configTemplate(), projectRoot, stateDir });
  assert.deepEqual(run.routes, configTemplate().routes);
});

test('route glob ** matches zero directories below a literal segment', async () => {
  const projectRoot = await createDiffRepository('src/index.ts');
  const stateDir = await temporaryDirectory('bh-run-');
  const config = configTemplate();
  config.routeMap = { 'src/**/index.ts': ['/profile'] };
  const run = await createRun('diff', undefined, { config, projectRoot, stateDir });
  assert.deepEqual(run.routes, ['/profile']);
});

test('route glob ** matches zero directories at the repository root', async () => {
  const projectRoot = await createDiffRepository('foo.ts');
  const stateDir = await temporaryDirectory('bh-run-');
  const config = configTemplate();
  config.routeMap = { '**/foo.ts': ['/profile'] };
  const run = await createRun('diff', undefined, { config, projectRoot, stateDir });
  assert.deepEqual(run.routes, ['/profile']);
});

test('route glob * matches within a single path segment', async () => {
  const projectRoot = await createDiffRepository('src/pages/orders/index.ts');
  const stateDir = await temporaryDirectory('bh-run-');
  const config = configTemplate();
  config.routeMap = { 'src/pages/*/index.ts': ['/orders'] };
  const run = await createRun('diff', undefined, { config, projectRoot, stateDir });
  assert.deepEqual(run.routes, ['/orders']);
});

test('route run requires one allowed configured route', async () => {
  const projectRoot = await temporaryDirectory('bh-project-');
  const stateDir = await temporaryDirectory('bh-run-');
  const deps = { config: configTemplate(), projectRoot, stateDir };
  const run = await createRun('route', '/orders', deps);
  assert.deepEqual(run.routes, ['/orders']);
  await assert.rejects(createRun('route', undefined, deps), /ROUTE_REQUIRED/);
  await assert.rejects(createRun('route', '/admin', deps), /ROUTE_NOT_ALLOWED/);
});

test('run updates persist and unknown or unsafe IDs fail clearly', async () => {
  const projectRoot = await temporaryDirectory('bh-project-');
  const stateDir = await temporaryDirectory('bh-run-');
  const run = await createRun('full', undefined, { config: configTemplate(), projectRoot, stateDir });
  const updated = await updateRun(run.id, { status: 'finished' }, stateDir);
  assert.equal(updated.status, 'finished');
  assert.equal((await readRun(run.id, stateDir)).status, 'finished');
  await assert.rejects(readRun('missing-run', stateDir), /RUN_NOT_FOUND: missing-run/);
  await assert.rejects(readRun('../outside', stateDir), /RUN_ID_INVALID/);
  await assert.rejects(updateRun('..\\outside', {}, stateDir), /RUN_ID_INVALID/);
});

test('atomic writes leave valid JSON when a writer is interrupted', async () => {
  const root = await temporaryDirectory('bh-atomic-');
  const file = join(root, 'value.json');
  await writeJsonAtomic(file, { version: 'initial' });
  const moduleUrl = pathToFileURL(join(process.cwd(), 'src/run-store.ts')).href;
  const child = spawn(process.execPath, [
    '--input-type=module',
    '--eval',
    `import { writeJsonAtomic } from ${JSON.stringify(moduleUrl)}; let version = 0; while (true) { await writeJsonAtomic(process.argv[1], { version: version++, payload: 'x'.repeat(100000) }); }`,
    file,
  ]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  child.kill('SIGKILL');
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  const value = JSON.parse(await readFile(file, 'utf8'));
  assert.ok(value.version === 'initial' || typeof value.version === 'number');
  const temporaryFiles = (await readdir(root)).filter((name) => name.endsWith('.tmp'));
  for (const temporaryFile of temporaryFiles) {
    assert.ok(temporaryFile.startsWith('.value.json.'));
  }
});
