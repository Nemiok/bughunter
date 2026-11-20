import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { signalSignature, writeJsonAtomic } from '@bughunter/core';
import type { Candidate } from '@bughunter/core';
import { SessionManager } from '../src/browser/session.ts';
import type { ActInput } from '../src/browser/session.ts';
import type { WebConfig as Config } from '../src/config.ts';
import { generatePlaywrightTest } from '../src/export-playwright.ts';
import { verifyWebRed } from '../src/test-runner.ts';
import type { Step } from '../src/types.ts';

const temporaryDirectories: string[] = [];
const managers: SessionManager[] = [];
let server: Server;
let origin: string;

before(async () => {
  server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (request.url?.startsWith('/dialog-alert')) {
      response.end(`<title>Alert</title><body onload="alert('Загрузка завершена')"><main>ok</main></body>`);
      return;
    }
    if (request.url?.startsWith('/dialog-load-confirm')) {
      response.end(`<title>Load</title><body onload="if(confirm('Продолжить?')) document.title='Confirmed'"><main>ok</main></body>`);
      return;
    }
    response.end(`<title>Dialog</title><main>
      <button data-testid="safe" onclick="if(confirm('Продолжить?')) document.title='Continued'">Safe</button>
      <button data-testid="danger" onclick="if(confirm('Delete account?')) document.title='Deleted'">Danger</button>
    </main>`);
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await Promise.all(managers.map((manager) => manager.closeAll()));
  if (server?.listening) {
    await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  }
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

function configTemplate(): Config {
  return {
    baseUrl: origin,
    allowedOrigins: [origin],
    routes: ['/dialog', '/dialog-alert', '/dialog-load-confirm'],
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

async function createManager(): Promise<{ manager: SessionManager; stateDir: string }> {
  const stateDir = await mkdtemp(join(tmpdir(), 'bh-dialogs-'));
  temporaryDirectories.push(stateDir);
  await writeJsonAtomic(join(stateDir, 'known-bugs.json'), []);
  await writeJsonAtomic(join(stateDir, 'suppressions.json'), []);
  const manager = new SessionManager(configTemplate(), stateDir);
  managers.push(manager);
  return { manager, stateDir };
}

async function clickNamed(manager: SessionManager, sessionId: string, name: string, extra?: Partial<ActInput>) {
  const state = await manager.state(sessionId);
  const element = state.elements.find((candidate) => candidate.name === name);
  assert.ok(element, `Missing element ${name}`);
  return manager.act(sessionId, { elementId: element.id, action: 'click', ...extra });
}

test('dialog-default-dismiss', async () => {
  const { manager } = await createManager();
  const { sessionId } = await manager.open('run-dialogs', '/dialog', 'newbie');
  const result = await clickNamed(manager, sessionId, 'Safe');
  assert.equal(result.ok, true);
  assert.deepEqual(result.dialogs, [{ type: 'confirm', message: 'Продолжить?', handled: 'dismiss' }]);
  assert.equal(await manager.pageOf(sessionId).title(), 'Dialog');
  assert.ok(result.signals.some((signal) => signal.kind === 'dialog' && signal.message === 'confirm: Продолжить?'));
});

test('dialog-accept', async () => {
  const { manager } = await createManager();
  const { sessionId } = await manager.open('run-dialogs', '/dialog', 'newbie');
  const result = await clickNamed(manager, sessionId, 'Safe', { dialog: 'accept' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.dialogs, [{ type: 'confirm', message: 'Продолжить?', handled: 'accept' }]);
  assert.equal(await manager.pageOf(sessionId).title(), 'Continued');
  const last = manager.stepsOf(sessionId).at(-1) as Step;
  assert.equal(last.dialog, 'accept');
  assert.deepEqual(last.dialogs, result.dialogs);
});

test('dialog-accept-forbidden', async () => {
  const { manager } = await createManager();
  const { sessionId } = await manager.open('run-dialogs', '/dialog', 'newbie');
  const stepsBefore = manager.stepsOf(sessionId).length;
  const result = await clickNamed(manager, sessionId, 'Danger', { dialog: 'accept' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'FORBIDDEN_ACTION');
  assert.equal(result.dialogs[0]?.handled, 'dismiss');
  assert.equal(await manager.pageOf(sessionId).title(), 'Dialog');
  assert.equal(manager.stepsOf(sessionId).length, stepsBefore);
});

test('dialog-on-load', async () => {
  const { manager } = await createManager();
  const { sessionId } = await manager.open('run-dialogs', '/dialog-alert', 'newbie');
  const state = await manager.state(sessionId);
  assert.deepEqual(state.dialogs, [{ type: 'alert', message: 'Загрузка завершена', handled: 'dismiss' }]);
  assert.deepEqual((await manager.state(sessionId)).dialogs, []);
});

function candidateWith(steps: Step[]): Candidate {
  return {
    id: 'c0ffee00-0000-4000-8000-000000000001',
    runId: 'run-dialogs',
    sessionId: 'session-dialogs',
    target: '/dialog',
    title: 'Dialog regression',
    expected: 'Continued',
    actual: 'Dialog stays',
    signalIds: [],
    signature: 'sig',
    steps,
    artifacts: [],
    status: 'confirmed',
    createdAt: new Date().toISOString(),
    check: { kind: 'visibleText', target: 'Continued' },
    reproduction: { status: 'reproduced', attempts: 1 },
  };
}

test('dialog-export', async () => {
  const config = configTemplate();
  const click: Step = {
    id: 'step-1', kind: 'act', timestamp: new Date().toISOString(), targetRef: '/dialog',
    action: 'click', locator: 'page.getByTestId("safe")', dialog: 'accept',
    dialogs: [{ type: 'confirm', message: 'Продолжить?', handled: 'accept' }],
  };
  const source = generatePlaywrightTest(candidateWith([click]), config, '/dialog');
  assert.ok(source.includes("page.on('dialog'"));
  assert.ok(source.includes('dialogPolicy = "accept";'));
  const plainClick: Step = { ...click, dialog: undefined, dialogs: undefined };
  const plain = generatePlaywrightTest(candidateWith([plainClick]), config, '/dialog');
  assert.ok(!plain.includes("page.on('dialog'"));
  const mixed = generatePlaywrightTest(candidateWith([click, plainClick]), config, '/dialog');
  assert.ok(mixed.includes('dialogPolicy = "dismiss";'));
  // Политика действует ровно на своё действие: после accept-шага она сброшена.
  assert.match(source, /dialogPolicy = "accept";\n  await page\.getByTestId\("safe"\)\.click\(\);\n  dialogPolicy = "dismiss";/);
});

test('dialog-policy-does-not-leak-into-navigate', async () => {
  const { manager } = await createManager();
  const { sessionId } = await manager.open('run-dialogs', '/dialog', 'newbie');
  const accepted = await clickNamed(manager, sessionId, 'Safe', { dialog: 'accept' });
  assert.equal(accepted.dialogs[0]?.handled, 'accept');
  const state = await manager.navigate(sessionId, '/dialog-load-confirm');
  assert.deepEqual(state.dialogs, [{ type: 'confirm', message: 'Продолжить?', handled: 'dismiss' }]);
  assert.equal(await manager.pageOf(sessionId).title(), 'Load');
});

function dialogSignalCandidate(initialTarget: string): Candidate {
  return {
    id: 'c0ffee00-0000-4000-8000-000000000002',
    runId: 'run-dialogs',
    sessionId: 'session-dialogs',
    target: initialTarget,
    title: 'Unexpected alert on load',
    expected: 'Экран загружается без диалога',
    actual: 'alert при загрузке',
    signalIds: ['signal-dialog'],
    signature: signalSignature({ kind: 'dialog', message: 'alert: Загрузка завершена', target: '/dialog-alert' }),
    steps: [],
    artifacts: [],
    status: 'confirmed',
    createdAt: new Date().toISOString(),
    reproduction: { status: 'reproduced', attempts: 1 },
  };
}

test('dialog-signal-export-matches', () => {
  const source = generatePlaywrightTest(dialogSignalCandidate('/dialog-alert'), configTemplate(), '/dialog-alert');
  assert.ok(source.includes("page.on('dialog'"));
  assert.ok(source.includes("kind: 'dialog'"));
});

test('dialog-signal-export-red-and-green', { timeout: 180_000 }, async () => {
  const fixtureRoot = resolve(import.meta.dirname, '../../../fixtures/buggy-app');
  const project = await realpath(await mkdtemp(join(tmpdir(), 'bh-dialog-export-')));
  temporaryDirectories.push(project);
  await symlink(join(fixtureRoot, 'node_modules'), join(project, 'node_modules'), 'dir');
  await writeFile(join(project, 'package.json'), JSON.stringify({
    name: 'bh-dialog-export', private: true, devDependencies: { '@playwright/test': '*' },
  }));
  await writeFile(join(project, 'playwright.config.ts'),
    `import { defineConfig } from '@playwright/test';\nexport default defineConfig({ use: { channel: 'chrome' } });\n`);
  const config = configTemplate();

  const redFile = join(project, 'red.spec.ts');
  await writeFile(redFile, generatePlaywrightTest(dialogSignalCandidate('/dialog-alert'), config, '/dialog-alert'));
  const red = await verifyWebRed(redFile, { kind: 'e2e' });
  assert.equal(red.status, 'red', red.message);

  const greenFile = join(project, 'green.spec.ts');
  await writeFile(greenFile, generatePlaywrightTest(dialogSignalCandidate('/dialog'), config, '/dialog'));
  const green = await verifyWebRed(greenFile, { kind: 'e2e' });
  assert.equal(green.status, 'green', green.message);
});
