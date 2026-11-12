import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { paginateElements, rankElements } from '../src/browser/elements.ts';
import { describeScreen, maxExtractorSummaryLength } from '../src/browser/screen.ts';
import { defaultElementsPerSnapshot } from '../src/config.ts';
import { SessionManager } from '../src/browser/session.ts';
import type { Profile } from '../src/profile/types.ts';
import { writeJsonAtomic } from '../src/run-store.ts';
import type { Config, ElementSnapshot } from '../src/types.ts';

const directories: string[] = [];
const managers: SessionManager[] = [];
let server: Server;
let origin: string;

const rowCount = 20;
const buttonCount = 150;

const tableRows = Array.from({ length: rowCount }, (_, index) =>
  `<tr><td>${index}</td><td>${(index + 1) * 10}</td></tr>`).join('');
const buttons = Array.from({ length: buttonCount }, (_, index) =>
  `<button data-testid="button-${index}" style="display:block;width:120px;height:24px">Button ${index}</button>`).join('');
const screenPage = `<!doctype html>
<html><head><meta charset="utf-8"><title>screen</title></head>
<body style="margin:0;position:relative;width:900px">
<table data-testid="orders"><tbody>${tableRows}</tbody></table>
${buttons}
</body></html>`;

before(async () => {
  server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(screenPage);
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
    routes: ['/screen'],
    routeMap: {},
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
    tests: { unit: { command: null }, e2e: { dir: 'e2e/bughunter' } },
  };
}

async function createManager(profile?: Profile, patch?: (config: Config) => void) {
  const stateDir = await mkdtemp(join(tmpdir(), 'bh-snapshot-'));
  directories.push(stateDir);
  await writeJsonAtomic(join(stateDir, 'known-bugs.json'), []);
  await writeJsonAtomic(join(stateDir, 'suppressions.json'), []);
  const config = configTemplate();
  patch?.(config);
  const manager = new SessionManager(config, stateDir, profile ?? null);
  managers.push(manager);
  const { sessionId } = await manager.open('run-snapshot', '/screen', 'новичок');
  return { manager, stateDir, config, sessionId };
}

function element(patch: Partial<ElementSnapshot> & { name: string }): ElementSnapshot {
  return {
    id: `id-${patch.name}`,
    role: 'generic',
    type: 'div',
    disabled: false,
    locator: { kind: 'css', value: `#css-${patch.name}` },
    box: { x: 0, y: 0, width: 10, height: 10 },
    ...patch,
  };
}

test('elements inside the viewport rank first, then role, then position', () => {
  const elements = [
    element({ name: 'far-generic', box: { x: 0, y: 5000, width: 10, height: 10 } }),
    element({ name: 'below-button', role: 'button', box: { x: 0, y: 900, width: 10, height: 10 } }),
    element({ name: 'visible-generic', box: { x: 200, y: 100, width: 10, height: 10 } }),
    element({ name: 'visible-button-right', role: 'button', box: { x: 300, y: 100, width: 10, height: 10 } }),
    element({ name: 'visible-button-left', role: 'button', box: { x: 10, y: 100, width: 10, height: 10 } }),
    element({ name: 'visible-textbox', role: 'textbox', box: { x: 10, y: 50, width: 10, height: 10 } }),
  ];

  const ranked = rankElements(elements, { width: 1280, height: 720 });

  assert.deepEqual(ranked.map((value) => value.name), [
    'visible-button-left',
    'visible-button-right',
    'visible-textbox',
    'visible-generic',
    'below-button',
    'far-generic',
  ]);
  // Детерминированность: тот же вход, тот же порядок, и вход не мутируется.
  assert.deepEqual(rankElements(elements, { width: 1280, height: 720 }).map((value) => value.name), ranked.map((value) => value.name));
  assert.deepEqual(elements.map((value) => value.name), [
    'far-generic', 'below-button', 'visible-generic', 'visible-button-right', 'visible-button-left', 'visible-textbox',
  ]);
});

test('paginateElements covers the ranked list without duplicates or gaps', () => {
  const elements = Array.from({ length: 500 }, (_, index) => element({ name: `b${index}` }));
  const seen: string[] = [];
  const truncatedFlags: boolean[] = [];
  let cursor: number | undefined;
  let pages = 0;
  do {
    const page = paginateElements(elements, 50, cursor);
    assert.ok(page.elements.length > 0);
    assert.ok(page.elements.length <= 50);
    assert.equal(page.totalVisible, 500);
    seen.push(...page.elements.map((value) => value.name));
    truncatedFlags.push(page.truncated);
    cursor = page.nextCursor;
    pages += 1;
  } while (cursor !== undefined && pages < 20);

  assert.equal(pages, 10);
  assert.equal(seen.length, 500);
  assert.equal(new Set(seen).size, 500);
  assert.deepEqual(seen, elements.map((value) => value.name));
  assert.deepEqual(truncatedFlags, [...Array.from({ length: 9 }, () => true), false]);
});

test('snapshot is ranked, capped and paginated without duplicates or gaps', async () => {
  const { manager, sessionId } = await createManager();
  const capped = await manager.state(sessionId);
  assert.equal(capped.totalVisible, buttonCount);
  assert.equal(capped.elements.length, defaultElementsPerSnapshot);
  assert.equal(capped.truncated, true);
  assert.equal(capped.nextCursor, defaultElementsPerSnapshot);
  // Ранжирование: кнопки в viewport идут первыми по позиции, хотя таблица в DOM выше.
  assert.equal(capped.elements[0]?.name, 'Button 0');

  const all = await manager.state(sessionId, { limit: buttonCount });
  assert.equal(all.elements.length, buttonCount);
  assert.equal(all.truncated, false);
  assert.equal(all.nextCursor, undefined);

  const seen: string[] = [];
  let cursor: number | undefined;
  let pages = 0;
  do {
    const page = await manager.state(sessionId, { limit: 50, cursor });
    assert.equal(page.elements.length, 50);
    assert.equal(page.totalVisible, buttonCount);
    seen.push(...page.elements.map((value) => value.name));
    cursor = page.nextCursor;
    pages += 1;
  } while (cursor !== undefined && pages < 10);

  assert.equal(pages, 3);
  assert.equal(new Set(seen).size, buttonCount);
  assert.deepEqual(seen, all.elements.map((value) => value.name));
});

test('snapshot honours limits.elementsPerSnapshot from config', async () => {
  const { manager, sessionId } = await createManager(undefined, (config) => {
    config.limits.elementsPerSnapshot = 30;
  });
  const state = await manager.state(sessionId, { screen: false });
  assert.equal(state.elements.length, 30);
  assert.equal(state.totalVisible, buttonCount);
  assert.equal(state.truncated, true);
  assert.equal(state.nextCursor, 30);
});

test('structure block lists widgets declared by the profile extractor', async () => {
  const profile: Profile = {
    name: 'snapshot',
    extractors: [{
      name: 'orders-table',
      widget: 'orders',
      kind: 'table',
      script: `() => {
        const rows = Array.from(document.querySelectorAll('[data-testid="orders"] tbody tr'));
        const values = rows.map((row) => Number(row.children[1]?.textContent ?? '0'));
        return { rows: rows.length, min: Math.min(...values), max: Math.max(...values) };
      }`,
    }],
    oracles: [],
  };
  const { manager, sessionId } = await createManager(profile);

  const state = await manager.state(sessionId, { screen: true });

  assert.deepEqual(state.screen?.widgets, [{
    widget: 'orders',
    kind: 'table',
    extractor: 'orders-table',
    summary: { rows: rowCount, min: 10, max: rowCount * 10 },
    truncated: false,
  }]);
});

test('extractor output over the size cap is truncated with a flag', async () => {
  const profile: Profile = {
    name: 'snapshot',
    extractors: [{
      name: 'huge-table',
      widget: 'huge',
      kind: 'table',
      script: '() => Array.from({ length: 5000 }, (_, index) => ({ row: index, label: "x".repeat(40) }))',
    }],
    oracles: [],
  };
  const { manager, sessionId } = await createManager(profile);

  const state = await manager.state(sessionId, { screen: true });
  const widget = state.screen?.widgets[0];

  assert.equal(widget?.truncated, true);
  assert.ok(Array.isArray(widget?.summary));
  assert.ok((widget?.summary as unknown[]).length < 5000);
  assert.ok(JSON.stringify(widget?.summary).length <= maxExtractorSummaryLength);
});

test('extractor failure is reported, not swallowed', async () => {
  const profile: Profile = {
    name: 'snapshot',
    extractors: [{
      name: 'broken',
      widget: 'broken-widget',
      kind: 'chart',
      script: '() => { throw new Error("no scene here"); }',
    }],
    oracles: [],
  };
  const { manager, sessionId } = await createManager(profile);

  const state = await manager.state(sessionId, { screen: true });

  assert.deepEqual(state.screen?.widgets, [{
    widget: 'broken-widget',
    kind: 'chart',
    extractor: 'broken',
    truncated: false,
    error: 'EXTRACTOR_FAILED: broken',
  }]);
});

test('describeScreen returns no widgets without a profile', async () => {
  const { manager, sessionId } = await createManager();
  const state = await manager.state(sessionId, { screen: true });
  assert.deepEqual(state.screen, { widgets: [] });
  assert.ok(describeScreen !== undefined);
});
