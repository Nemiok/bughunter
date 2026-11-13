import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { SessionManager } from '../src/browser/session.ts';
import type { ActInput } from '../src/browser/session.ts';
import { generatePlaywrightTest } from '../src/export-playwright.ts';
import type { Profile } from '../src/profile/types.ts';
import { reproduceCandidate } from '../src/reproduce.ts';
import { writeJsonAtomic } from '@bughunter/core';
import { createRun } from '../src/runs.ts';
import type { Candidate, Journal } from '@bughunter/core';
import type { Step } from '../src/types.ts';
import type { WebConfig as Config } from '../src/config.ts';
import type { ElementSnapshot } from '../src/types.ts';

const directories: string[] = [];
const managers: SessionManager[] = [];
let server: Server;
let origin: string;

// Геометрия фиксирована, чтобы координаты в тестах были детерминированы без чтения bounding box.
const flowPage = `<!doctype html>
<html><head><meta charset="utf-8"><title>flow</title></head>
<body style="margin:0;font-family:sans-serif;position:relative;width:900px;height:600px">
<div data-testid="item" tabindex="0" class="item" style="position:absolute;left:20px;top:20px;width:100px;height:40px;background:#eee">Item</div>
<div data-testid="zone-a" tabindex="0" class="zone" style="position:absolute;left:20px;top:80px;width:160px;height:80px;border:1px solid #999">Zone A</div>
<div data-testid="zone-b" tabindex="0" class="zone" style="position:absolute;left:220px;top:80px;width:160px;height:80px;border:1px solid #999">Zone B</div>
<div data-testid="list" tabindex="0" style="position:absolute;left:420px;top:20px;width:300px;height:120px;overflow:auto;border:1px solid #999">
  <div style="position:relative;height:1200px"><div id="rows" style="position:absolute;left:0;right:0"></div></div>
</div>
<p data-testid="total" style="position:absolute;left:760px;top:20px;margin:0">TOTAL 42</p>
<button data-testid="ok" style="position:absolute;left:20px;top:200px;width:200px;height:40px">Press me</button>
<button data-testid="danger" style="position:absolute;left:20px;top:260px;width:200px;height:40px">Delete account</button>
<div data-testid="hoverbox" tabindex="0" style="position:absolute;left:20px;top:320px;width:200px;height:40px">Hover me</div>
<form action="/flow" method="get"><button type="submit" data-testid="go" style="position:absolute;left:20px;top:380px;width:200px;height:40px">Go</button></form>
<input type="file" data-testid="file" style="position:absolute;left:20px;top:440px">
<script>
  let dragging = null;
  addEventListener('mousedown', (event) => { const item = event.target.closest('.item'); if (item) dragging = item; });
  addEventListener('mouseup', (event) => {
    if (!dragging) return;
    const zone = event.target.closest('.zone');
    if (zone) {
      zone.append(dragging);
      document.title = 'dropped:' + zone.dataset.testid;
      if (zone.dataset.testid === 'zone-b') document.querySelector('[data-testid="total"]').style.display = 'none';
    }
    dragging = null;
  });
  document.querySelector('[data-testid="ok"]').addEventListener('click', () => { document.title = 'clicked'; });
  document.querySelector('[data-testid="hoverbox"]').addEventListener('mouseenter', () => { document.title = 'hovered'; });
  document.querySelector('[data-testid="file"]').addEventListener('change', (event) => {
    document.title = event.target.files[0]?.name ?? 'none';
  });
  const list = document.querySelector('[data-testid="list"]');
  const rows = document.getElementById('rows');
  const render = () => {
    const first = Math.floor(list.scrollTop / 40);
    rows.style.top = first * 40 + 'px';
    rows.replaceChildren();
    for (let index = first; index < first + 4 && index < 30; index += 1) {
      const row = document.createElement('div');
      row.dataset.testid = 'row-' + index;
      row.tabIndex = 0;
      row.style.height = '40px';
      row.textContent = 'Row ' + index;
      rows.append(row);
    }
    document.title = 'rendered:row-' + first + '-row-' + Math.min(first + 3, 29);
  };
  list.addEventListener('scroll', render);
  render();
</script>
</body></html>`;

before(async () => {
  server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(flowPage);
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
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

function configTemplate(): Config {
  return {
    baseUrl: origin,
    allowedOrigins: [origin],
    routes: ['/flow'],
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

async function createManager(patch?: (config: Config) => void, profile?: Profile) {
  const stateDir = await mkdtemp(join(tmpdir(), 'bh-actions-'));
  directories.push(stateDir);
  await writeJsonAtomic(join(stateDir, 'known-bugs.json'), []);
  await writeJsonAtomic(join(stateDir, 'suppressions.json'), []);
  const config = configTemplate();
  patch?.(config);
  const manager = new SessionManager(config, stateDir, profile ?? null);
  managers.push(manager);
  return { manager, stateDir, config };
}

async function open(manager: SessionManager, runId = 'run-actions') {
  const { sessionId } = await manager.open(runId, '/flow', 'новичок');
  return sessionId;
}

type WebJournal = Omit<Journal, 'steps'> & { steps: Step[] };

async function readJournal(stateDir: string, runId: string, sessionId: string): Promise<WebJournal> {
  const path = join(stateDir, 'runs', runId, 'journals', `${sessionId}.json`);
  return JSON.parse(await (await import('node:fs/promises')).readFile(path, 'utf8')) as WebJournal;
}

async function byTestId(manager: SessionManager, sessionId: string, testId: string): Promise<ElementSnapshot> {
  const [element] = await byTestIds(manager, sessionId, testId);
  return element!;
}

// Идентификаторы элементов живут только до следующего state(): брать несколько целей нужно одним снимком.
async function byTestIds(manager: SessionManager, sessionId: string, ...testIds: string[]): Promise<ElementSnapshot[]> {
  const state = await manager.state(sessionId);
  return testIds.map((testId) => {
    const element = state.elements.find((candidate) => candidate.locator.kind === 'testid' && candidate.locator.value === testId);
    assert.ok(element, `Missing element ${testId}`);
    return element;
  });
}

async function actById(manager: SessionManager, sessionId: string, testId: string, input: Omit<ActInput, 'elementId'>) {
  const element = await byTestId(manager, sessionId, testId);
  const result = await manager.act(sessionId, { elementId: element.id, ...input });
  assert.equal(result.ok, true, result.error);
  return result;
}

async function stateWithTitle(manager: SessionManager, sessionId: string, title: string) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const state = await manager.state(sessionId);
    if (state.title === title) return state;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  assert.equal((await manager.state(sessionId)).title, title);
  throw new Error('unreachable');
}

async function testDataDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'bh-testdata-'));
  directories.push(directory);
  await writeFile(join(directory, 'sample.csv'), 'a,b\n1,2\n', 'utf8');
  return directory;
}

function uploadProfile(directory: string): Profile {
  return { name: 'actions', extractors: [], oracles: [], testData: { dir: directory } };
}

test('drag moves a value between two elements and records both locators', async () => {
  const { manager, stateDir } = await createManager();
  const sessionId = await open(manager);
  const [source, target] = await byTestIds(manager, sessionId, 'item', 'zone-b');

  const result = await manager.act(sessionId, { elementId: source.id, action: 'drag', toElementId: target.id });

  assert.equal(result.ok, true, result.error);
  assert.equal((await manager.state(sessionId)).title, 'dropped:zone-b');
  const step = (await readJournal(stateDir, 'run-actions', sessionId)).steps.at(-1);
  assert.equal(step?.action, 'drag');
  assert.equal(step?.locator, 'page.getByTestId("item")');
  assert.deepEqual(step?.to, { locator: 'page.getByTestId("zone-b")' });
});

test('drag without a drop target is rejected with DRAG_TARGET_REQUIRED', async () => {
  const { manager, stateDir } = await createManager();
  const sessionId = await open(manager);
  const source = await byTestId(manager, sessionId, 'item');
  const before = (await readJournal(stateDir, 'run-actions', sessionId)).steps.length;

  const result = await manager.act(sessionId, { elementId: source.id, action: 'drag' });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'DRAG_TARGET_REQUIRED');
  assert.equal((await readJournal(stateDir, 'run-actions', sessionId)).steps.length, before);
});

test('scroll records direction and delta and changes the visible set', async () => {
  const { manager, stateDir } = await createManager();
  const sessionId = await open(manager);
  const before = await stateWithTitle(manager, sessionId, 'rendered:row-0-row-3');
  assert.ok(before.elements.some((element) => element.locator.kind === 'testid' && element.locator.value === 'row-0'));
  assert.ok(!before.elements.some((element) => element.locator.kind === 'testid' && element.locator.value === 'row-10'));

  const result = await actById(manager, sessionId, 'list', { action: 'scroll', scroll: { direction: 'down', delta: 400 } });

  assert.equal(result.ok, true, result.error);
  const after = await stateWithTitle(manager, sessionId, 'rendered:row-10-row-13');
  assert.ok(after.elements.some((element) => element.locator.kind === 'testid' && element.locator.value === 'row-10'));
  const step = (await readJournal(stateDir, 'run-actions', sessionId)).steps.at(-1);
  assert.equal(step?.action, 'scroll');
  assert.deepEqual(step?.scroll, { direction: 'down', delta: 400 });
  assert.equal(step?.locator, 'page.getByTestId("list")');
});

test('scroll without a usable direction and delta is rejected with SCROLL_INVALID', async () => {
  const { manager, stateDir } = await createManager();
  const sessionId = await open(manager);
  const list = await byTestId(manager, sessionId, 'list');
  const before = (await readJournal(stateDir, 'run-actions', sessionId)).steps.length;

  const withoutScroll = await manager.act(sessionId, { elementId: list.id, action: 'scroll' });
  const sideways = await manager.act(sessionId, {
    elementId: list.id,
    action: 'scroll',
    scroll: { direction: 'sideways', delta: 100 },
  } as unknown as ActInput);
  const zeroDelta = await manager.act(sessionId, { elementId: list.id, action: 'scroll', scroll: { direction: 'down', delta: 0 } });

  assert.deepEqual([withoutScroll, sideways, zeroDelta].map((result) => result.error), [
    'SCROLL_INVALID',
    'SCROLL_INVALID',
    'SCROLL_INVALID',
  ]);
  assert.equal((await readJournal(stateDir, 'run-actions', sessionId)).steps.length, before);
});

test('clickAt and hoverAt resolve a semantic target and record it', async () => {
  const { manager, stateDir } = await createManager();
  const sessionId = await open(manager);

  const clicked = await manager.act(sessionId, { action: 'clickAt', at: { x: 120, y: 220 } });
  assert.equal(clicked.ok, true, clicked.error);
  assert.equal((await manager.state(sessionId)).title, 'clicked');

  const hovered = await manager.act(sessionId, { action: 'hoverAt', at: { x: 120, y: 340 } });
  assert.equal(hovered.ok, true, hovered.error);
  assert.equal((await manager.state(sessionId)).title, 'hovered');

  const steps = (await readJournal(stateDir, 'run-actions', sessionId)).steps.filter((step) => step.kind === 'act');
  assert.deepEqual(steps.map((step) => step.action), ['clickAt', 'hoverAt']);
  assert.deepEqual(steps[0]?.at, { x: 120, y: 220 });
  assert.equal(steps[0]?.resolvedLocator, 'page.getByTestId("ok")');
  assert.deepEqual(steps[1]?.at, { x: 120, y: 340 });
  assert.equal(steps[1]?.resolvedLocator, 'page.getByTestId("hoverbox")');
});

test('coordinate actions resolve a semantic target before forbidden and readOnly guards', async () => {
  const forbidden = await createManager();
  const forbiddenSession = await open(forbidden.manager);
  const overDanger = await forbidden.manager.act(forbiddenSession, { action: 'clickAt', at: { x: 120, y: 280 } });
  assert.equal(overDanger.ok, false);
  assert.equal(overDanger.error, 'FORBIDDEN_ACTION');

  const readOnly = await createManager((config) => { config.safety.readOnly = true; });
  const readOnlySession = await open(readOnly.manager);
  const overSubmit = await readOnly.manager.act(readOnlySession, { action: 'clickAt', at: { x: 120, y: 400 } });
  assert.equal(overSubmit.ok, false);
  assert.equal(overSubmit.error, 'FORM_SUBMISSION_BLOCKED');
});

test('unresolvable point is rejected with POINT_TARGET_UNRESOLVED', async () => {
  const { manager, stateDir } = await createManager();
  const sessionId = await open(manager);
  const before = (await readJournal(stateDir, 'run-actions', sessionId)).steps.length;

  const result = await manager.act(sessionId, { action: 'clickAt', at: { x: 5000, y: 5000 } });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'POINT_TARGET_UNRESOLVED');
  assert.equal((await readJournal(stateDir, 'run-actions', sessionId)).steps.length, before);
});

test('upload takes a file from profile testData and rejects paths outside it', async () => {
  const directory = await testDataDirectory();
  const { manager, stateDir } = await createManager(undefined, uploadProfile(directory));
  const sessionId = await open(manager);
  const input = await byTestId(manager, sessionId, 'file');

  const escaping = await manager.act(sessionId, { elementId: input.id, action: 'upload', file: '../escape.csv' });
  const absolute = await manager.act(sessionId, { elementId: input.id, action: 'upload', file: '/etc/hosts' });
  assert.equal(escaping.error, 'UPLOAD_FILE_NOT_FOUND');
  assert.equal(absolute.error, 'UPLOAD_FILE_NOT_FOUND');

  const uploaded = await manager.act(sessionId, { elementId: input.id, action: 'upload', file: 'sample.csv' });
  assert.equal(uploaded.ok, true, uploaded.error);
  assert.equal((await manager.state(sessionId)).title, 'sample.csv');

  const step = (await readJournal(stateDir, 'run-actions', sessionId)).steps.at(-1);
  assert.equal(step?.action, 'upload');
  assert.equal(step?.file, 'sample.csv');
  assert.equal(step?.locator, 'page.getByTestId("file")');
});

test('upload without profile testData is rejected with UPLOAD_FILE_NOT_FOUND', async () => {
  const { manager } = await createManager();
  const sessionId = await open(manager);
  const input = await byTestId(manager, sessionId, 'file');

  const result = await manager.act(sessionId, { elementId: input.id, action: 'upload', file: 'sample.csv' });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'UPLOAD_FILE_NOT_FOUND');
});

test('profile resolvePoint hook takes precedence over the built-in hit test', async () => {
  const directory = await testDataDirectory();
  const profile: Profile = {
    ...uploadProfile(directory),
    interactions: {
      resolvePoint: '(point) => ({ locator: \'page.getByTestId("hooked")\', text: \'Hooked at \' + point.x, role: \'button\' })',
    },
  };
  const { manager, stateDir } = await createManager(undefined, profile);
  const sessionId = await open(manager);

  const result = await manager.act(sessionId, { action: 'clickAt', at: { x: 120, y: 220 } });

  assert.equal(result.ok, true, result.error);
  const step = (await readJournal(stateDir, 'run-actions', sessionId)).steps.at(-1);
  assert.equal(step?.resolvedLocator, 'page.getByTestId("hooked")');
});

test('reproduce replays every new action kind', async () => {
  const directory = await testDataDirectory();
  const profile = uploadProfile(directory);
  const { manager, stateDir, config } = await createManager((value) => { value.profile = 'actions'; }, profile);
  await mkdir(join(stateDir, 'profiles', 'actions'), { recursive: true });
  await writeFile(join(stateDir, 'profiles', 'actions', 'index.ts'), `export default ${JSON.stringify(profile)};\n`, 'utf8');
  const run = await createRun('full', undefined, { config, projectRoot: stateDir, stateDir });
  await writeJsonAtomic(join(stateDir, 'config.json'), config);

  const sessionId = await open(manager, run.id);
  await actById(manager, sessionId, 'list', { action: 'scroll', scroll: { direction: 'down', delta: 400 } });
  const [source, target] = await byTestIds(manager, sessionId, 'item', 'zone-b');
  await manager.act(sessionId, { elementId: source.id, action: 'drag', toElementId: target.id });
  await manager.act(sessionId, { action: 'clickAt', at: { x: 120, y: 220 } });
  await manager.act(sessionId, { action: 'hoverAt', at: { x: 120, y: 340 } });
  const input = await byTestId(manager, sessionId, 'file');
  await manager.act(sessionId, { elementId: input.id, action: 'upload', file: 'sample.csv' });
  const { candidateId } = await manager.reportCandidate(sessionId, {
    title: 'TOTAL disappears after the drop',
    expected: 'TOTAL 42 stays visible after the item is dropped',
    actual: 'TOTAL 42 is hidden once the item lands in zone B',
    signalIds: [],
    check: { kind: 'visibleText', target: 'TOTAL 42' },
  });
  await manager.close(sessionId);

  const result = await reproduceCandidate({ runId: run.id, candidateId, attempts: 3, stateDir });

  assert.equal(result.reproduced, '3/3');
  assert.equal(result.steps, 5);
  assert.ok(result.minimalSteps >= 1);
  assert.ok(result.minimalSteps <= result.steps);
});

test('export generates code for every new action kind', async () => {
  const directory = await testDataDirectory();
  const steps: Step[] = [
    { id: 'step-1', kind: 'act', timestamp: '2026-11-12T00:00:00.000Z', targetRef: '/flow', action: 'drag', locator: 'page.getByTestId("item")', to: { locator: 'page.getByTestId("zone-b")' } },
    { id: 'step-2', kind: 'act', timestamp: '2026-11-12T00:00:01.000Z', targetRef: '/flow', action: 'scroll', locator: 'page.getByTestId("list")', scroll: { direction: 'down', delta: 400 } },
    { id: 'step-3', kind: 'act', timestamp: '2026-11-12T00:00:02.000Z', targetRef: '/flow', action: 'scroll', scroll: { direction: 'down', delta: 400 } },
    { id: 'step-4', kind: 'act', timestamp: '2026-11-12T00:00:03.000Z', targetRef: '/flow', action: 'clickAt', at: { x: 120, y: 220 }, resolvedLocator: 'page.getByTestId("ok")' },
    { id: 'step-5', kind: 'act', timestamp: '2026-11-12T00:00:04.000Z', targetRef: '/flow', action: 'hoverAt', at: { x: 120, y: 340 }, resolvedLocator: 'page.getByTestId("hoverbox")' },
    { id: 'step-6', kind: 'act', timestamp: '2026-11-12T00:00:05.000Z', targetRef: '/flow', action: 'upload', locator: 'page.getByTestId("file")', file: 'sample.csv' },
  ];
  const candidate: Candidate = {
    id: 'candidate-actions',
    runId: 'run-actions',
    sessionId: 'session-actions',
    target: '/flow',
    title: 'TOTAL disappears after the drop',
    expected: 'TOTAL 42 stays visible',
    actual: 'TOTAL 42 is hidden',
    signalIds: [],
    signature: 'signature-actions',
    steps,
    artifacts: [],
    status: 'confirmed',
    createdAt: '2026-11-12T00:00:00.000Z',
    check: { kind: 'visibleText', target: 'TOTAL 42' },
    reproduction: { status: 'reproduced', attempts: 3 },
  };

  const source = generatePlaywrightTest(candidate, configTemplate(), '/flow', uploadProfile(directory));

  assert.ok(source.includes('await page.getByTestId("item").dragTo(page.getByTestId("zone-b"));'), source);
  assert.ok(source.includes('await page.getByTestId("list").evaluate((element) => element.scrollBy(0, 400));'), source);
  assert.ok(source.includes('await page.mouse.wheel(0, 400);'), source);
  assert.ok(source.includes('await page.mouse.click(120, 220);'), source);
  assert.ok(source.includes('await page.mouse.move(120, 340);'), source);
  assert.ok(source.includes(`await page.getByTestId("file").setInputFiles(${JSON.stringify(join(directory, 'sample.csv'))});`), source);
  assert.ok(source.includes('await expect.poll(async () => { const matches = page.getByText("TOTAL 42", { exact: true }); const total = await matches.count(); for (let index = 0; index < total; index += 1) { if (await matches.nth(index).isVisible()) return true; } return false; }, { timeout: 5000 }).toBe(true);'), source);
});
