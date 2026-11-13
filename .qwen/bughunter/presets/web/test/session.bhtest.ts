import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { SessionManager } from '../src/browser/session.ts';
import type { ActInput, CandidateInput, ProbeKind } from '../src/browser/session.ts';
import { writeJsonAtomic } from '@bughunter/core';
import type { Config, Journal, Step } from '@bughunter/core';

const demoOrigin = 'http://127.0.0.1:4173';
const temporaryDirectories: string[] = [];
const managers: SessionManager[] = [];
let demoProcess: ChildProcess | undefined;
let controlsServer: Server;
let controlsOrigin: string;

before(async () => {
  try {
    await fetch(demoOrigin, { signal: AbortSignal.timeout(1000) });
  } catch {
    const demoRoot = resolve(import.meta.dirname, '../../../fixtures/buggy-app');
    demoProcess = spawn(process.execPath, [join(demoRoot, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '4173', '--strictPort'], {
      cwd: demoRoot,
      stdio: 'ignore',
    });
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await fetch(demoOrigin, { signal: AbortSignal.timeout(500) });
        break;
      } catch {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      }
    }
    await fetch(demoOrigin, { signal: AbortSignal.timeout(1000) });
  }

  controlsServer = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    if (request.url?.startsWith('/other')) {
      response.end('<title>Other</title><main><a href="/controls">Controls</a></main>');
      return;
    }
    response.end(`<title>Controls</title><script>document.title=localStorage.getItem('saved') ?? 'Controls'</script><main>
      <button data-testid="click">Click me</button>
      <button data-testid="double" onclick="document.title='Doubled'">Double me</button>
      <label>Name <input data-testid="name"></label>
      <label for="choice">Choice</label><select id="choice"><option value="a">A</option><option value="b">B</option></select>
      <label><input type="checkbox"> Accept terms</label>
      <a href="/other">Other</a>
      <button>DeLeTe account</button>
      <button onclick="console.error('drain-test')">Emit signal</button>
      <form action="/other" method="get"><label>Query <input name="q"></label><button>Submit form</button></form>
      <form id="associated-form" action="/other" method="get"></form>
      <button form="associated-form">Associated submit</button>
      <label>Associated input <input form="associated-form" name="associated"></label>
      <input type="image" form="associated-form" aria-label="Image submit" alt="Image submit" width="24" height="24" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">
      <a href="https://example.com/">External link</a>
      <button onclick="location.href='https://example.com/'">Client external</button>
      <button onclick="window.testPopup=window.open('https://example.com/')">Popup external</button>
      <button onclick="document.title=window.testPopup?.closed?'Popup closed':'Popup open'">Check popup</button>
    </main>`);
  });
  await new Promise<void>((resolveListen) => controlsServer.listen(0, '127.0.0.1', resolveListen));
  const address = controlsServer.address();
  assert.ok(address && typeof address === 'object');
  controlsOrigin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await Promise.all(managers.map((manager) => manager.closeAll()));
  if (controlsServer?.listening) {
    await new Promise<void>((resolveClose, reject) => controlsServer.close((error) => error ? reject(error) : resolveClose()));
  }
  const spawnedDemo = demoProcess;
  if (spawnedDemo && spawnedDemo.exitCode === null) {
    const exited = new Promise<void>((resolveExit) => spawnedDemo.once('exit', () => resolveExit()));
    spawnedDemo.kill('SIGTERM');
    await exited;
  }
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

function configTemplate(baseUrl: string): Config {
  return {
    baseUrl,
    allowedOrigins: [demoOrigin, controlsOrigin].filter((origin, index, origins) => origins.indexOf(origin) === index),
    routes: ['/', '/profile', '/orders', '/orders/new', '/clean', '/controls', '/other'],
    routeMap: {},
    baseBranch: 'main',
    limits: { stepsPerSession: 60, candidatesPerRun: 20 },
    safety: { forbiddenActionText: ['delete'], readOnly: false },
    testDataPrefix: 'bh_',
    detectors: {
      ignoreConsole: [],
      ignoreRequests: ['https://example.com'],
      anomalyTexts: ['undefined', 'NaN', '[object Object]', 'Invalid Date'],
      errorBoundarySelector: '[data-error-boundary]',
    },
    tests: { unit: { command: null }, e2e: { dir: 'e2e/bughunter' } },
  };
}

async function createManager(baseUrl = demoOrigin, patch?: (config: Config) => void): Promise<{ manager: SessionManager; stateDir: string }> {
  const stateDir = await mkdtemp(join(tmpdir(), 'bh-session-'));
  temporaryDirectories.push(stateDir);
  await writeJsonAtomic(join(stateDir, 'known-bugs.json'), []);
  await writeJsonAtomic(join(stateDir, 'suppressions.json'), []);
  const config = configTemplate(baseUrl);
  patch?.(config);
  const manager = new SessionManager(config, stateDir);
  managers.push(manager);
  return { manager, stateDir };
}

async function journal(stateDir: string, runId: string, sessionId: string): Promise<Journal> {
  return JSON.parse(await readFile(join(stateDir, 'runs', runId, 'journals', `${sessionId}.json`), 'utf8')) as Journal;
}

async function actNamed(manager: SessionManager, sessionId: string, name: string, input: Omit<ActInput, 'elementId'>) {
  const state = await manager.state(sessionId);
  const element = state.elements.find((candidate) => candidate.name === name);
  assert.ok(element, `Missing element ${name}`);
  return manager.act(sessionId, { elementId: element.id, ...input });
}

async function probe(manager: SessionManager, sessionId: string, kind: ProbeKind) {
  return manager.probe(sessionId, kind);
}

function checkCandidate(): CandidateInput {
  return {
    title: 'Saved value is visible',
    expected: 'Saved profile is shown',
    actual: 'Saved profile is not shown',
    signalIds: [],
    check: { kind: 'visibleText', target: 'Saved', expected: 'Saved' },
  };
}

test('real demo session persists candidate journal prefix and non-empty close artifacts', async () => {
  const { manager, stateDir } = await createManager();
  try {
    const { sessionId } = await manager.open('run-lifecycle', '/profile', 'newbie');
    const initial = await manager.state(sessionId);
    assert.equal(initial.stepsLeft, 60);
    assert.equal(initial.url, `${demoOrigin}/profile`);
    assert.match(initial.title, /Vite|React|Bughunter/i);
    assert.ok(initial.elements.some((element) => element.name === 'Name'));

    const filled = await actNamed(manager, sessionId, 'Name', { action: 'fill' });
    assert.equal(filled.ok, true);
    assert.equal(filled.navigated, false);
    const afterFill = await manager.state(sessionId);
    const generated = afterFill.elements.find((element) => element.name === 'Name')?.value;
    assert.match(generated ?? '', /^bh_[a-f0-9]{8}$/);
    assert.equal(afterFill.stepsLeft, 59);

    const clicked = await actNamed(manager, sessionId, 'Save', { action: 'click' });
    assert.equal(clicked.ok, true);
    const reported = await manager.reportCandidate(sessionId, checkCandidate());
    assert.match(reported.candidateId, /^[a-f0-9-]{36}$/);
    await manager.navigate(sessionId, '/clean');

    const savedJournal = await journal(stateDir, 'run-lifecycle', sessionId);
    assert.deepEqual(savedJournal.steps.map((step) => step.action), ['fill', 'click', undefined]);
    assert.equal(savedJournal.steps[0]?.locator, 'page.getByTestId("profile-name")');
    assert.equal(savedJournal.steps[0]?.value, generated);
    assert.equal(savedJournal.steps[2]?.kind, 'navigate');
    assert.equal(savedJournal.steps[2]?.path, '/clean');
    assert.deepEqual(savedJournal.steps.map((step) => step.routeTemplate), ['/profile', '/profile', '/clean']);

    const candidatePath = join(stateDir, 'runs', 'run-lifecycle', 'candidates', `${reported.candidateId}.json`);
    const candidate = JSON.parse(await readFile(candidatePath, 'utf8'));
    assert.equal(candidate.status, 'unprocessed');
    assert.deepEqual(candidate.reproduction, { status: 'unreproduced', attempts: 0 });
    assert.equal(candidate.route, '/profile');
    assert.equal(candidate.steps.length, 2);
    assert.deepEqual(candidate.steps.map((step: Step) => step.action), ['fill', 'click']);

    await manager.close(sessionId);
    const artifactDirectory = join(stateDir, 'runs', 'run-lifecycle', 'artifacts', reported.candidateId);
    const artifactSizes = await Promise.all(['trace.zip', 'screenshot.png', 'video.webm'].map(async (name) => (await stat(join(artifactDirectory, name))).size));
    assert.ok(artifactSizes.every((size) => size > 0), `Empty artifacts: ${artifactSizes.join(',')}`);
    const closedCandidate = JSON.parse(await readFile(candidatePath, 'utf8'));
    assert.equal(closedCandidate.artifacts.length, 3);
    assert.ok(closedCandidate.artifacts.every((file: string) => file.startsWith(`runs/run-lifecycle/artifacts/${reported.candidateId}/`)));
  } finally {
    await manager.closeAll();
  }
});

test('all action and probe kinds are replayable journal steps with shared step accounting', async () => {
  const { manager, stateDir } = await createManager(controlsOrigin);
  try {
    const { sessionId } = await manager.open('run-actions', '/controls', 'impatient');
    assert.equal((await actNamed(manager, sessionId, 'Click me', { action: 'click' })).ok, true);
    assert.equal((await actNamed(manager, sessionId, 'Double me', { action: 'dblclick' })).ok, true);
    assert.equal((await actNamed(manager, sessionId, 'Name', { action: 'fill', value: 'Alice' })).ok, true);
    assert.equal((await actNamed(manager, sessionId, 'Choice', { action: 'select', value: 'b' })).ok, true);
    assert.equal((await actNamed(manager, sessionId, 'Name', { action: 'press', value: 'Backspace' })).ok, true);
    assert.equal((await actNamed(manager, sessionId, 'Accept terms', { action: 'check' })).ok, true);
    assert.equal((await actNamed(manager, sessionId, 'Other', { action: 'hover' })).ok, true);

    const mobile = await probe(manager, sessionId, 'mobile_viewport');
    assert.equal(mobile.url, `${controlsOrigin}/controls`);
    assert.equal(mobile.stepsLeft, 52);
    const reloaded = await probe(manager, sessionId, 'reload');
    assert.equal(reloaded.stepsLeft, 51);
    const navigated = await manager.navigate(sessionId, '/other');
    assert.equal(navigated.stepsLeft, 50);
    const back = await probe(manager, sessionId, 'back');
    assert.equal(back.url, `${controlsOrigin}/controls`);
    assert.equal(back.stepsLeft, 49);

    const savedJournal = await journal(stateDir, 'run-actions', sessionId);
    assert.deepEqual(savedJournal.steps.map((step) => step.action), [
      'click', 'dblclick', 'fill', 'select', 'press', 'check', 'hover',
      undefined, undefined, undefined, undefined,
    ]);
    assert.deepEqual(savedJournal.steps.slice(7).map((step) => [step.kind, step.probe ?? step.path]), [
      ['probe', 'mobile_viewport'], ['probe', 'reload'], ['navigate', '/other'], ['probe', 'back'],
    ]);
    assert.deepEqual(savedJournal.steps.map((step) => step.routeTemplate), [
      ...Array.from({ length: 9 }, () => '/controls'), '/other', '/controls',
    ]);
    assert.ok(savedJournal.steps.filter((step) => step.kind === 'act').every((step) => step.locator && step.timestamp));
    assert.equal((await manager.state(sessionId)).stepsLeft, 49);
  } finally {
    await manager.closeAll();
  }
});

test('navigation guards reject external URL tricks before network and allow same-origin control', async () => {
  const { manager, stateDir } = await createManager(controlsOrigin);
  try {
    await assert.rejects(manager.open('run-bad-open', 'https://example.com/', 'newbie'), /NAVIGATION_NOT_ALLOWED/);
    const { sessionId } = await manager.open('run-navigation', '/controls', 'newbie');
    for (const target of ['https://example.com/', '//example.com/path', `${controlsOrigin.replace('http://', 'http://user:pass@')}/other`]) {
      await assert.rejects(manager.navigate(sessionId, target), /NAVIGATION_NOT_ALLOWED/);
    }
    const allowed = await manager.navigate(sessionId, '/other');
    assert.equal(allowed.url, `${controlsOrigin}/other`);
    await manager.navigate(sessionId, '/controls');

    const before = (await journal(stateDir, 'run-navigation', sessionId)).steps;
    const external = await actNamed(manager, sessionId, 'External link', { action: 'click' });
    assert.equal(external.error, 'NAVIGATION_NOT_ALLOWED');
    assert.equal((await manager.state(sessionId)).url, `${controlsOrigin}/controls`);
    const client = await actNamed(manager, sessionId, 'Client external', { action: 'click' });
    assert.equal(client.error, 'NAVIGATION_NOT_ALLOWED');
    assert.equal((await manager.state(sessionId)).url, `${controlsOrigin}/controls`);
    const popup = await actNamed(manager, sessionId, 'Popup external', { action: 'click' });
    assert.equal(popup.error, 'FORBIDDEN_ORIGIN');
    assert.equal((await manager.state(sessionId)).url, `${controlsOrigin}/controls`);
    assert.deepEqual((await journal(stateDir, 'run-navigation', sessionId)).steps, before);
    const context = (manager as unknown as {
      sessions: Map<string, { context: { pages(): unknown[] } }>;
    }).sessions.get(sessionId)?.context;
    assert.equal(context?.pages().length, 1);
  } finally {
    await manager.closeAll();
  }
});

test('forbidden action text and read-only form submission are rejected before journaling', async () => {
  const { manager, stateDir } = await createManager(controlsOrigin, (config) => { config.safety.readOnly = true; });
  try {
    const { sessionId } = await manager.open('run-safety', '/controls', 'newbie');
    const forbidden = await actNamed(manager, sessionId, 'DeLeTe account', { action: 'click' });
    assert.equal(forbidden.ok, false);
    assert.match(forbidden.error ?? '', /FORBIDDEN_ACTION/);
    const submission = await actNamed(manager, sessionId, 'Submit form', { action: 'click' });
    assert.equal(submission.error, 'FORM_SUBMISSION_BLOCKED');
    const associatedClick = await actNamed(manager, sessionId, 'Associated submit', { action: 'click' });
    assert.equal(associatedClick.error, 'FORM_SUBMISSION_BLOCKED');
    const associatedEnter = await actNamed(manager, sessionId, 'Associated input', { action: 'press', value: 'Enter' });
    assert.equal(associatedEnter.error, 'FORM_SUBMISSION_BLOCKED');
    const imageSubmit = await actNamed(manager, sessionId, 'Image submit', { action: 'click' });
    assert.equal(imageSubmit.error, 'FORM_SUBMISSION_BLOCKED');
    assert.equal((await manager.state(sessionId)).url, `${controlsOrigin}/controls`);
    assert.deepEqual((await journal(stateDir, 'run-safety', sessionId)).steps, []);
  } finally {
    await manager.closeAll();
  }
});

test('step limit covers actions and probes without executing or journaling excess work', async () => {
  const { manager, stateDir } = await createManager(controlsOrigin, (config) => { config.limits.stepsPerSession = 2; });
  try {
    const { sessionId } = await manager.open('run-limit', '/controls', 'impatient');
    assert.equal((await actNamed(manager, sessionId, 'Click me', { action: 'click' })).ok, true);
    const finalProbe = await probe(manager, sessionId, 'mobile_viewport');
    assert.equal(finalProbe.stepsLeft, 0);
    const limited = await actNamed(manager, sessionId, 'Double me', { action: 'dblclick' });
    assert.equal(limited.ok, false);
    assert.equal(limited.error, 'LIMIT_REACHED');
    await assert.rejects(probe(manager, sessionId, 'reload'), /LIMIT_REACHED/);
    assert.equal((await manager.state(sessionId)).title, 'Controls');
    assert.equal((await manager.state(sessionId)).stepsLeft, 0);
    assert.equal((await journal(stateDir, 'run-limit', sessionId)).steps.length, 2);
  } finally {
    await manager.closeAll();
  }
});

test('candidate signatures deduplicate against known bugs and suppressions', async () => {
  const { manager, stateDir } = await createManager();
  try {
    const first = await manager.open('run-dedup', '/profile', 'newbie');
    const original = await manager.reportCandidate(first.sessionId, checkCandidate());
    const candidatePath = join(stateDir, 'runs', 'run-dedup', 'candidates', `${original.candidateId}.json`);
    const signature = JSON.parse(await readFile(candidatePath, 'utf8')).signature as string;
    await manager.close(first.sessionId);

    await writeJsonAtomic(join(stateDir, 'known-bugs.json'), [{ id: 'known-1', signature }]);
    const knownSession = await manager.open('run-dedup', '/profile', 'newbie');
    const known = await manager.reportCandidate(knownSession.sessionId, checkCandidate());
    assert.equal(known.duplicateOf, 'known-1');
    await manager.close(knownSession.sessionId);

    await writeJsonAtomic(join(stateDir, 'known-bugs.json'), []);
    await writeJsonAtomic(join(stateDir, 'suppressions.json'), [{ id: 'suppressed-1', signature }]);
    const suppressedSession = await manager.open('run-dedup', '/profile', 'newbie');
    const suppressed = await manager.reportCandidate(suppressedSession.sessionId, checkCandidate());
    assert.equal(suppressed.duplicateOf, 'suppressed-1');
  } finally {
    await manager.closeAll();
  }
});


test('navigate returns zero steps left after the final allowed step', async () => {
  const { manager, stateDir } = await createManager(controlsOrigin, (config) => { config.limits.stepsPerSession = 1; });
  try {
    const { sessionId } = await manager.open('run-final-navigate', '/controls', 'newbie');
    const result = await manager.navigate(sessionId, '/other');
    assert.equal(result.stepsLeft, 0);
    assert.equal((await journal(stateDir, 'run-final-navigate', sessionId)).steps.length, 1);
  } finally {
    await manager.closeAll();
  }
});

test('storage state is loaded and emitted signals drain exactly once', async () => {
  const { manager, stateDir } = await createManager(controlsOrigin);
  try {
    await mkdir(join(stateDir, 'auth'), { recursive: true });
    await writeFile(join(stateDir, 'auth', 'storage-state.json'), JSON.stringify({
      cookies: [],
      origins: [{ origin: controlsOrigin, localStorage: [{ name: 'saved', value: 'Loaded storage' }] }],
    }), 'utf8');
    const { sessionId } = await manager.open('run-storage', '/controls', 'newbie');
    assert.equal((await manager.state(sessionId)).title, 'Loaded storage');

    const emitted = await actNamed(manager, sessionId, 'Emit signal', { action: 'click' });
    assert.ok(emitted.signals.some((signal) => signal.kind === 'console' && signal.message === 'drain-test'));
    assert.deepEqual((await manager.state(sessionId)).signals, []);
  } finally {
    await manager.closeAll();
  }
});

test('storage probing failure removes temporary media after open mkdir', async () => {
  const { manager, stateDir } = await createManager(controlsOrigin);
  try {
    await writeFile(join(stateDir, 'auth'), 'not a directory', 'utf8');
    await assert.rejects(manager.open('run-open-failure', '/controls', 'newbie'));
    const artifactsDir = join(stateDir, 'runs', 'run-open-failure', 'artifacts');
    const remaining = await readdir(artifactsDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    assert.deepEqual(remaining, []);
  } finally {
    await manager.closeAll();
  }
});

test('check-only signatures use fixed field order and preserve expected counts', async () => {
  const { manager, stateDir } = await createManager();
  try {
    const { sessionId } = await manager.open('run-check-signatures', '/profile', 'newbie');
    const input = (check: CandidateInput['check']): CandidateInput => ({
      title: 'Order count', expected: 'Expected count', actual: 'Actual count', signalIds: [], check,
    });
    const signatureOf = async (candidateId: string): Promise<string> => JSON.parse(await readFile(
      join(stateDir, 'runs', 'run-check-signatures', 'candidates', `${candidateId}.json`), 'utf8',
    )).signature as string;

    const original = await manager.reportCandidate(sessionId, input({
      kind: 'elementCount', target: '[data-testid="order-row"]', expected: 1,
    }));
    const originalSignature = await signatureOf(original.candidateId);
    const reordered = await manager.reportCandidate(sessionId, input({
      expected: 1, target: '[data-testid="order-row"]', kind: 'elementCount',
    }));
    assert.equal(await signatureOf(reordered.candidateId), originalSignature);

    await writeJsonAtomic(join(stateDir, 'known-bugs.json'), [{ id: 'known-check', signature: originalSignature }]);
    const known = await manager.reportCandidate(sessionId, input({
      expected: 1, target: '[data-testid="order-row"]', kind: 'elementCount',
    }));
    assert.equal(known.duplicateOf, 'known-check');

    const different = await manager.reportCandidate(sessionId, input({
      kind: 'elementCount', target: '[data-testid="order-row"]', expected: 2,
    }));
    assert.equal(different.duplicateOf, undefined);
    const differentSignature = await signatureOf(different.candidateId);
    assert.notEqual(differentSignature, originalSignature);

    await writeJsonAtomic(join(stateDir, 'known-bugs.json'), []);
    await writeJsonAtomic(join(stateDir, 'suppressions.json'), [{ id: 'suppressed-check', signature: differentSignature }]);
    const suppressed = await manager.reportCandidate(sessionId, input({
      target: '[data-testid="order-row"]', expected: 2, kind: 'elementCount',
    }));
    assert.equal(suppressed.duplicateOf, 'suppressed-check');
  } finally {
    await manager.closeAll();
  }
});

test('elementCount target that is not a selector is rejected at report time', async () => {
  const { manager } = await createManager();
  try {
    const { sessionId } = await manager.open('run-check-invalid', '/profile', 'newbie');
    const candidate = (check: CandidateInput['check']): CandidateInput => ({
      title: 'Duplicate row', expected: 'One row', actual: 'Two rows', signalIds: [], check,
    });

    // Обычный текст вместо селектора: без проверки ошибка всплыла бы только в bh_reproduce
    // и молча превратилась бы в «не воспроизведено» после трёх попыток.
    await assert.rejects(
      () => manager.reportCandidate(sessionId, candidate({ kind: 'elementCount', target: 'Позиция 7', expected: 1 })),
      /CHECK_INVALID: elementCount\.target/,
    );

    const asText = await manager.reportCandidate(
      sessionId,
      candidate({ kind: 'elementCount', target: 'text=Позиция 7', expected: 1 }),
    );
    assert.ok(asText.candidateId);

    const otherKinds = await manager.reportCandidate(
      sessionId,
      candidate({ kind: 'visibleText', target: 'Nothing here' }),
    );
    assert.ok(otherKinds.candidateId);
  } finally {
    await manager.closeAll();
  }
});
