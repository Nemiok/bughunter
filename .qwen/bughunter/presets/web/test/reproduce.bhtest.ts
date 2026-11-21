import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import type { ViteDevServer } from '../../../fixtures/buggy-app/node_modules/vite/dist/node/index.d.ts';
import { SessionManager } from '../src/browser/session.ts';
import type { CandidateInput } from '../src/browser/session.ts';
import { signalSignature } from '@bughunter/core';
import { checkViolated } from '../src/checks.ts';
import { reproduceCandidate } from '../src/reproduce.ts';
import { writeJsonAtomic } from '@bughunter/core';
import { createRun } from '../src/runs.ts';
import type { Candidate } from '@bughunter/core';
import type { Step } from '../src/types.ts';
import type { WebConfig as Config } from '../src/config.ts';

const fixtureRoot = resolve(import.meta.dirname, '../../../fixtures/buggy-app');
let vite: ViteDevServer;
let baseUrl: string;

before(async () => {
  const { createServer } = await import('../../../fixtures/buggy-app/node_modules/vite/dist/node/index.js');
  vite = await createServer({
    root: fixtureRoot,
    configFile: join(fixtureRoot, 'vite.config.ts'),
    server: { host: '127.0.0.1', port: 0 },
  });
  await vite.listen();
  const address = vite.httpServer?.address();
  assert.ok(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await vite?.close();
});

function demoConfig(): Config {
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

async function act(manager: SessionManager, sessionId: string, testId: string, action: 'click' | 'dblclick' | 'fill', value?: string) {
  const state = await manager.state(sessionId);
  const element = state.elements.find((candidate) => candidate.locator.kind === 'testid' && candidate.locator.value === testId);
  assert.ok(element, `Missing ${testId}`);
  const result = await manager.act(sessionId, { elementId: element.id, action, ...(value === undefined ? {} : { value }) });
  assert.equal(result.ok, true, result.error);
  return result;
}

async function clickRole(manager: SessionManager, sessionId: string, role: 'link', name: string) {
  const state = await manager.state(sessionId);
  const element = state.elements.find((candidate) => candidate.locator.kind === 'role' && candidate.locator.role === role && candidate.locator.name === name);
  assert.ok(element, `Missing ${role} ${name}`);
  const result = await manager.act(sessionId, { elementId: element.id, action: 'click' });
  assert.equal(result.ok, true, result.error);
  return result;
}

async function candidateFixture(
  target: string,
  explore: (manager: SessionManager, sessionId: string) => Promise<CandidateInput>,
  expectedReproduction: '0/1' | '1/1' = '1/1',
): Promise<{ result: Awaited<ReturnType<typeof reproduceCandidate>>; candidate: Candidate & { minimalSteps?: Step[] } }> {
  const stateDir = await mkdtemp(join(tmpdir(), 'bh-reproduce-'));
  const config = demoConfig();
  const run = await createRun('full', undefined, { config, projectRoot: fixtureRoot, stateDir });
  await writeJsonAtomic(join(stateDir, 'config.json'), config);
  await writeJsonAtomic(join(stateDir, 'known-bugs.json'), []);
  await writeJsonAtomic(join(stateDir, 'suppressions.json'), []);
  const manager = new SessionManager(config, stateDir);
  try {
    const { sessionId } = await manager.open(run.id, target, 'replay-test');
    const input = await explore(manager, sessionId);
    const { candidateId } = await manager.reportCandidate(sessionId, input);
    await manager.close(sessionId);
    const candidatePath = join(stateDir, 'runs', run.id, 'candidates', `${candidateId}.json`);
    const before = JSON.parse(await readFile(candidatePath, 'utf8')) as Candidate;
    const result = await reproduceCandidate({ runId: run.id, candidateId, attempts: 1, stateDir });
    const candidate = JSON.parse(await readFile(candidatePath, 'utf8')) as Candidate & { minimalSteps?: Step[] };
    assert.equal(result.reproduced, expectedReproduction);
    assert.equal(result.steps, before.steps.length);
    assert.equal(result.signature, before.signature);
    assert.equal(result.minimalSteps, candidate.minimalSteps?.length ?? 0);
    assert.ok(result.minimalSteps <= result.steps);
    assert.equal(candidate.reproduction?.status, expectedReproduction === '1/1' ? 'reproduced' : 'unreproduced');
    assert.equal(candidate.reproduction.attempts, 1);
    assert.ok(result.artifacts.length >= before.artifacts.length + 3);
    assert.ok(result.artifacts.every((path) => path.startsWith(`runs/${run.id}/artifacts/${candidateId}/`)));
    const artifactSizes = await Promise.all(result.artifacts.map(async (path) => (await stat(join(stateDir, path))).size));
    assert.ok(artifactSizes.every((size) => size > 0));
    return { result, candidate };
  } finally {
    await manager.closeAll();
    await rm(stateDir, { recursive: true, force: true });
  }
}

function signalCandidate(input: CandidateInput, signals: Array<{ id: string; kind: string }>, kind: string): CandidateInput {
  const signal = signals.find((candidate) => candidate.kind === kind);
  assert.ok(signal, `Missing ${kind} signal`);
  return { ...input, signalIds: [signal.id] };
}

test('real Chrome reproduces and minimizes all five seeded bug symptoms', { timeout: 180_000 }, async (t) => {
  await t.test('1: empty profile pageerror', async () => {
    const { candidate } = await candidateFixture('/profile', async (manager, sessionId) => {
      await manager.probe(sessionId, 'mobile_viewport');
      const clicked = await act(manager, sessionId, 'profile-save', 'click');
      return signalCandidate({
        title: 'Empty profile throws', expected: 'Validation', actual: 'Unhandled error', signalIds: [],
      }, clicked.signals, 'pageerror');
    });
    assert.deepEqual((candidate.minimalSteps as Step[] | undefined)?.map((step) => step.action), ['click']);
  });

  await t.test('2: zero quantity HTTP 500', async () => {
    const { candidate } = await candidateFixture('/orders/new', async (manager, sessionId) => {
      await manager.probe(sessionId, 'mobile_viewport');
      await act(manager, sessionId, 'order-quantity', 'fill', '0');
      const clicked = await act(manager, sessionId, 'order-create', 'click');
      return signalCandidate({
        title: 'Zero quantity fails', expected: 'Validation', actual: 'HTTP 500', signalIds: [],
      }, clicked.signals, 'response');
    });
    assert.deepEqual((candidate.minimalSteps as Step[] | undefined)?.map((step) => step.action), ['fill', 'click']);
  });

  await t.test('3: double click violates the pre-action order count', async () => {
    await candidateFixture('/orders/new', async (manager, sessionId) => {
      await manager.probe(sessionId, 'mobile_viewport');
      await act(manager, sessionId, 'order-create', 'dblclick');
      await clickRole(manager, sessionId, 'link', 'Orders');
      await manager.state(sessionId);
      return {
        title: 'Double click creates extra orders', expected: 'One order', actual: 'More than one order', signalIds: [],
        check: { kind: 'elementCount', target: '[data-testid="order-row"]', expected: 2 },
      };
    });
  });

  await t.test('4: empty orders render NaN', async () => {
    await candidateFixture('/orders', async (manager, sessionId) => {
      await manager.state(sessionId);
      await manager.probe(sessionId, 'mobile_viewport');
      const reloaded = await manager.probe(sessionId, 'reload');
      return signalCandidate({
        title: 'Empty total is NaN', expected: 'Numeric total', actual: 'NaN', signalIds: [],
      }, reloaded.signals, 'anomaly');
    });
  });

  await t.test('5: page two reload emits the filter console error', async () => {
    await candidateFixture('/orders?page=2', async (manager, sessionId) => {
      await manager.state(sessionId);
      await manager.probe(sessionId, 'mobile_viewport');
      const reloaded = await manager.probe(sessionId, 'reload');
      return signalCandidate({
        title: 'Page two resets filter', expected: 'Filter retained', actual: 'Console error', signalIds: [],
      }, reloaded.signals, 'console');
    });
  });
});

test('every replay starts clean and notVisibleText checks retain the required actions', async () => {
  const { candidate } = await candidateFixture('/profile', async (manager, sessionId) => {
    await act(manager, sessionId, 'profile-name', 'fill', 'Alice');
    await act(manager, sessionId, 'profile-save', 'click');
    return {
      title: 'Saved profile remains visible', expected: 'No saved profile', actual: 'Saved Alice is visible', signalIds: [],
      check: { kind: 'notVisibleText', target: 'Saved Alice' },
    };
  });
  assert.deepEqual((candidate.minimalSteps as Step[] | undefined)?.map((step) => step.action), ['fill', 'click']);
});

test('final-page visibleText violation reproduces and minimizes against real Chrome', async () => {
  const { candidate } = await candidateFixture('/clean', async (manager, sessionId) => {
    await manager.probe(sessionId, 'mobile_viewport');
    return {
      title: 'Expected confirmation is absent', expected: 'Confirmation visible', actual: 'Confirmation absent', signalIds: [],
      check: { kind: 'visibleText', target: 'Confirmation complete' },
    };
  });
  assert.deepEqual(candidate.minimalSteps, []);
});

test('visible text satisfying the final-page check stays unreproduced without minimal steps', async () => {
  const { candidate } = await candidateFixture('/clean', async (manager, sessionId) => {
    await manager.probe(sessionId, 'mobile_viewport');
    return {
      title: 'Visible text is present', expected: 'Clean page visible', actual: 'Clean page visible', signalIds: [],
      check: { kind: 'visibleText', target: 'Clean page' },
    };
  }, '0/1');
  assert.equal(candidate.minimalSteps, undefined);
  assert.equal(candidate.reproduction?.status, 'unreproduced');
});

test('signal-backed candidates ignore a violated check when the normalized signature differs', { timeout: 60_000 }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'bh-reproduce-miss-'));
  const config = demoConfig();
  const run = await createRun('full', undefined, { config, projectRoot: fixtureRoot, stateDir });
  await writeJsonAtomic(join(stateDir, 'config.json'), config);
  const manager = new SessionManager(config, stateDir);
  try {
    const { sessionId } = await manager.open(run.id, '/profile', 'replay-test');
    const clicked = await act(manager, sessionId, 'profile-save', 'click');
    const input = signalCandidate({
      title: 'Different error', expected: 'No error', actual: 'Error', signalIds: [],
      check: { kind: 'visibleText', target: 'Confirmation that does not exist' },
    }, clicked.signals, 'pageerror');
    const { candidateId } = await manager.reportCandidate(sessionId, input);
    await manager.close(sessionId);
    const candidatePath = join(stateDir, 'runs', run.id, 'candidates', `${candidateId}.json`);
    const candidate = JSON.parse(await readFile(candidatePath, 'utf8')) as Candidate;
    // Повтор сверяется с сырой сигнатурой симптома: подменяем именно её.
    candidate.signalSignature = signalSignature({ kind: 'pageerror', message: 'A different error 42', target: '/profile' });
    await writeJsonAtomic(candidatePath, candidate);
    const result = await reproduceCandidate({ runId: run.id, candidateId, attempts: 1, stateDir });
    const saved = JSON.parse(await readFile(candidatePath, 'utf8')) as Candidate & { minimalSteps?: Step[] };
    assert.equal(result.reproduced, '0/1');
    assert.equal(result.minimalSteps, 0);
    assert.equal(saved.reproduction?.status, 'unreproduced');
    assert.equal(saved.minimalSteps, undefined);
  } finally {
    await manager.closeAll();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('text checks judge by a visible match, not by the first DOM match', async () => {
  const browser = await chromium.launch({ channel: 'chrome', args: ['--no-first-run', '--no-default-browser-check'] });
  const page = await (await browser.newContext()).newPage();
  try {
    // Реальный случай с bi-app: регион одновременно в скрытом <option> фильтра и в видимой
    // ячейке таблицы. `getByText(...).first()` попадает в option, и нарушение пропадает.
    await page.setContent('<select><option value="all">Все</option><option value="northwest">northwest</option></select>'
      + '<table><tbody><tr><td>3</td><td>northwest</td></tr></tbody></table>');
    assert.equal(
      await checkViolated(page, { kind: 'notVisibleText', target: 'northwest' }),
      true,
      'видимый текст обязан нарушать notVisibleText, даже если первым в DOM идёт скрытый узел',
    );
    assert.equal(
      await checkViolated(page, { kind: 'visibleText', target: 'northwest' }),
      false,
      'видимый текст не должен давать ложного нарушения visibleText',
    );

    // Текст есть только в скрытом узле — нарушений нет ни у того, ни у другого вида.
    await page.setContent('<select><option value="ural">ural</option></select>');
    assert.equal(await checkViolated(page, { kind: 'visibleText', target: 'ural' }), true);
    assert.equal(await checkViolated(page, { kind: 'notVisibleText', target: 'ural' }), false);
  } finally {
    await browser.close();
  }
});

test('replay infrastructure failure surfaces as REPLAY_FAILED, not unreproduced', { timeout: 60_000 }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'bh-replay-failed-'));
  const config = demoConfig();
  const run = await createRun('full', undefined, { config, projectRoot: fixtureRoot, stateDir });
  await writeJsonAtomic(join(stateDir, 'config.json'), config);
  await writeJsonAtomic(join(stateDir, 'known-bugs.json'), []);
  await writeJsonAtomic(join(stateDir, 'suppressions.json'), []);
  const manager = new SessionManager(config, stateDir);
  try {
    const { sessionId } = await manager.open(run.id, '/profile', 'replay-test');
    await act(manager, sessionId, 'profile-save', 'click');
    const { candidateId } = await manager.reportCandidate(sessionId, {
      title: 'Broken locator', expected: 'Validation', actual: 'Nothing', signalIds: [],
      check: { kind: 'visibleText', target: 'Saved' },
    });
    await manager.close(sessionId);
    const candidatePath = join(stateDir, 'runs', run.id, 'candidates', `${candidateId}.json`);
    const stored = JSON.parse(await readFile(candidatePath, 'utf8')) as Candidate & { steps: Step[] };
    stored.steps = stored.steps.map((step) => ({ ...step, locator: 'page.getByTestId("does-not-exist")' })) as Step[];
    await writeJsonAtomic(candidatePath, stored);
    await assert.rejects(
      reproduceCandidate({ runId: run.id, candidateId, attempts: 1, stateDir }),
      /REPLAY_FAILED: REPLAY_ELEMENT_NOT_FOUND/,
    );
    const after = JSON.parse(await readFile(candidatePath, 'utf8')) as Candidate;
    assert.deepEqual(after.reproduction, { status: 'unreproduced', attempts: 0 });
  } finally {
    await manager.closeAll();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('web replay resets the stand before journal steps', { timeout: 60_000 }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'bh-replay-reset-'));
  const config = demoConfig();
  config.profile = 'replay-reset';
  try {
    const run = await createRun('full', undefined, { config, projectRoot: fixtureRoot, stateDir });
    await writeJsonAtomic(join(stateDir, 'config.json'), config);
    await writeJsonAtomic(join(stateDir, 'known-bugs.json'), []);
    await writeJsonAtomic(join(stateDir, 'suppressions.json'), []);
    await mkdir(join(stateDir, 'profiles', 'replay-reset'), { recursive: true });
    await writeFile(join(stateDir, 'profiles', 'replay-reset', 'index.ts'), `export default {
      name: 'replay-reset', extractors: [], oracles: [],
      reset: { kind: 'mock-endpoint', url: '/__reset' },
    };\n`);
    const callsBefore = await (await fetch(`${baseUrl}/__reset-calls`)).json() as string[];
    const manager = new SessionManager(config, stateDir);
    try {
      const { sessionId } = await manager.open(run.id, '/profile', 'replay-test');
      await act(manager, sessionId, 'profile-name', 'fill', 'Alice');
      await act(manager, sessionId, 'profile-save', 'click');
      const { candidateId } = await manager.reportCandidate(sessionId, {
        title: 'Saved profile', expected: 'Saved', actual: 'Missing', signalIds: [],
        check: { kind: 'visibleText', target: 'Saved' },
      });
      await manager.close(sessionId);
      const result = await reproduceCandidate({ runId: run.id, candidateId, attempts: 1, stateDir });
      assert.equal(result.reproduced, '1/1');
      const callsAfter = await (await fetch(`${baseUrl}/__reset-calls`)).json() as string[];
      assert.ok(callsAfter.length > callsBefore.length, 'повтор обязан сбросить стенд');
      assert.ok(callsAfter.includes('POST'), `сброс — POST: ${JSON.stringify(callsAfter)}`);
    } finally {
      await manager.closeAll();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
