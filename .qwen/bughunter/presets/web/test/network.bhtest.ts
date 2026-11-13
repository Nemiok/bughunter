import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser } from 'playwright-core';
import { attachNetworkCapture, maxResponseBodyBytes } from '../src/browser/network.ts';
import { SessionManager } from '../src/browser/session.ts';
import { writeJsonAtomic } from '@bughunter/core';
import { createRun } from '../src/runs.ts';
import type { WebConfig as Config } from '../src/config.ts';

let browser: Browser;
let server: Server;
let external: Server;
let origin: string;
let externalOrigin: string;

const temporaryDirectories: string[] = [];

after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

const dataBody = JSON.stringify({ ok: true, rows: [1, 2, 3] });
const bigBody = JSON.stringify({ blob: 'x'.repeat(4096) });

function pageHtml(script: string): string {
  return `<!doctype html><html><body><main>network fixture</main><script>${script}</script></body></html>`;
}

const serviceWorker = `
self.addEventListener('install', (event) => { event.waitUntil(self.skipWaiting()); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname === '/api/sw-data') {
    event.respondWith(new Response(JSON.stringify({ from: 'service-worker' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    return;
  }
  event.respondWith(fetch(event.request));
});
`;

before(async () => {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(pageHtml(`fetch('/api/data');`));
      return;
    }
    if (url.pathname === '/sw.js') {
      response.writeHead(200, { 'Content-Type': 'application/javascript' });
      response.end(serviceWorker);
      return;
    }
    if (url.pathname === '/sw-page') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(pageHtml(`
        (async () => {
          await navigator.serviceWorker.register('/sw.js');
          await navigator.serviceWorker.ready;
          if (!navigator.serviceWorker.controller && !sessionStorage.getItem('bh-reloaded')) {
            sessionStorage.setItem('bh-reloaded', '1');
            location.reload();
            return;
          }
          void fetch('/api/sw-data');
        })();
      `));
      return;
    }
    if (url.pathname === '/hook-page') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(pageHtml(`
        fetch('/api/data').then((response) => response.text()).then((body) => {
          window.__bhReportResponse({ url: location.origin + '/api/data', method: 'GET', status: 200, body });
        });
      `));
      return;
    }
    if (url.pathname === '/cross') {
      const target = url.searchParams.get('target') ?? '';
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(pageHtml(`fetch(${JSON.stringify(target)});`));
      return;
    }
    if (url.pathname === '/api/data') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(dataBody);
      return;
    }
    if (url.pathname === '/api/big') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(bigBody);
      return;
    }
    if (url.pathname === '/api/csv') {
      response.writeHead(200, { 'Content-Type': 'text/csv' });
      response.end('a,b\n1,2\n');
      return;
    }
    if (url.pathname === '/api/slow') {
      setTimeout(() => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ slow: true }));
      }, 250);
      return;
    }
    response.writeHead(404, { 'Content-Type': 'text/plain' });
    response.end('not found');
  });
  external = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    response.end(JSON.stringify({ foreign: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  await new Promise<void>((resolve) => external.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const externalAddress = external.address();
  assert.ok(address && typeof address === 'object');
  assert.ok(externalAddress && typeof externalAddress === 'object');
  origin = `http://127.0.0.1:${address.port}`;
  externalOrigin = `http://127.0.0.1:${externalAddress.port}`;
});

after(async () => {
  await browser?.close();
  for (const instance of [server, external]) {
    if (instance?.listening) {
      await new Promise<void>((resolve, reject) => instance.close((error) => error ? reject(error) : resolve()));
    }
  }
});

async function openCapture(options: { responseSource?: 'playwright' | 'page-hook'; maxBodyBytes?: number } = {}) {
  const stateDir = await temporaryDirectory('bh-network-');
  const page = await browser.newPage();
  const capture = await attachNetworkCapture(page, {
    stateDir,
    runId: 'run-network',
    allowedOrigins: [origin],
    ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
    ...(options.responseSource === undefined ? {} : { responseSource: options.responseSource }),
  });
  return { stateDir, page, capture };
}

test('captures method, status, route and JSON body for same-origin responses', async () => {
  const { page, capture } = await openCapture();
  try {
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    const entry = await capture.waitFor('/api/data', 5000);
    assert.equal(entry.method, 'GET');
    assert.equal(entry.status, 200);
    assert.equal(entry.route, '/');
    assert.equal(entry.url, `${origin}/api/data`);
    assert.deepEqual(entry.json, { ok: true, rows: [1, 2, 3] });
    assert.equal(entry.truncated, false);
    assert.equal(entry.bytes, Buffer.byteLength(dataBody));
    assert.equal(entry.hash, createHash('sha256').update(dataBody).digest('hex'));
    assert.equal(entry.bodyPath, undefined);
    assert.equal(capture.sourceUnavailable(), null);
  } finally {
    await capture.dispose();
    await page.close();
  }
});

test('oversized body is truncated, hashed and stored as an artifact', async () => {
  const { stateDir, page, capture } = await openCapture({ maxBodyBytes: 64 });
  try {
    await page.goto(`${origin}/`);
    await page.evaluate(() => { void fetch('/api/big'); });
    const entry = await capture.waitFor('/api/big', 5000);
    assert.equal(entry.truncated, true);
    assert.equal(entry.bytes, Buffer.byteLength(bigBody));
    assert.equal(entry.json, undefined);
    assert.ok(entry.bodyPath, 'полное тело должно сохраняться артефактом');
    const stored = await readFile(join(stateDir, entry.bodyPath!), 'utf8');
    assert.equal(stored, bigBody);
    assert.equal(entry.hash, createHash('sha256').update(bigBody).digest('hex'));
  } finally {
    await capture.dispose();
    await page.close();
  }
});

test('non-JSON body keeps hash and content type only', async () => {
  const { page, capture } = await openCapture();
  try {
    await page.goto(`${origin}/`);
    await page.evaluate(() => { void fetch('/api/csv'); });
    const entry = await capture.waitFor('/api/csv', 5000);
    assert.equal(entry.json, undefined);
    assert.equal(entry.contentType, 'text/csv');
    assert.equal(entry.hash, createHash('sha256').update('a,b\n1,2\n').digest('hex'));
    assert.equal(entry.truncated, false);
  } finally {
    await capture.dispose();
    await page.close();
  }
});

test('waitFor resolves on the bound response and rejects with RESPONSE_TIMEOUT', async () => {
  const { page, capture } = await openCapture();
  try {
    await page.goto(`${origin}/`);
    await page.evaluate(() => { void fetch('/api/slow'); });
    const entry = await capture.waitFor('/api/slow', 5000);
    assert.deepEqual(entry.json, { slow: true });
    await assert.rejects(() => capture.waitFor('/api/never', 300), /RESPONSE_TIMEOUT: \/api\/never/);
  } finally {
    await capture.dispose();
    await page.close();
  }
});

test('service-worker-served responses are captured with readable bodies', async () => {
  const { page, capture } = await openCapture();
  try {
    await page.goto(`${origin}/sw-page`, { waitUntil: 'domcontentloaded' });
    const entry = await capture.waitFor('/api/sw-data', 10000);
    assert.equal(entry.status, 200);
    assert.deepEqual(entry.json, { from: 'service-worker' });
    assert.equal(entry.fromServiceWorker, true);
  } finally {
    await capture.dispose();
    await page.close();
  }
});

test('cross-origin responses are not captured', async () => {
  const { page, capture } = await openCapture();
  try {
    await page.goto(`${origin}/cross?target=${encodeURIComponent(`${externalOrigin}/api/other`)}`);
    await page.waitForTimeout(600);
    assert.equal(capture.responses().some((entry) => entry.url.includes('/api/other')), false);
    assert.equal(capture.sourceUnavailable(), null);
  } finally {
    await capture.dispose();
    await page.close();
  }
});

test('page-hook source collects pushed responses', async () => {
  const { page, capture } = await openCapture({ responseSource: 'page-hook' });
  try {
    await page.goto(`${origin}/hook-page`, { waitUntil: 'domcontentloaded' });
    const entry = await capture.waitFor('/api/data', 5000);
    assert.equal(entry.status, 200);
    assert.deepEqual(entry.json, { ok: true, rows: [1, 2, 3] });
    assert.equal(capture.sourceUnavailable(), null);
  } finally {
    await capture.dispose();
    await page.close();
  }
});

test('page-hook source reports RESPONSE_SOURCE_UNAVAILABLE when nothing is pushed', async () => {
  const { page, capture } = await openCapture({ responseSource: 'page-hook' });
  try {
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    await assert.rejects(() => capture.waitFor('/api/data', 500), /RESPONSE_SOURCE_UNAVAILABLE/);
    assert.equal(capture.sourceUnavailable(), 'RESPONSE_SOURCE_UNAVAILABLE');
  } finally {
    await capture.dispose();
    await page.close();
  }
});

test('session journal records response hashes on a step', async () => {
  const stateDir = await temporaryDirectory('bh-network-journal-');
  const config: Config = {
    baseUrl: origin,
    allowedOrigins: [origin],
    routes: ['/'],
    targetMap: {},
    baseBranch: 'main',
    limits: { stepsPerSession: 60, candidatesPerRun: 20 },
    safety: { forbiddenActionText: [], readOnly: false },
    testDataPrefix: 'bh_',
    detectors: {
      ignoreConsole: [],
      ignoreRequests: [],
      anomalyTexts: ['NaN'],
      errorBoundarySelector: '[data-error-boundary]',
    },
    tests: { unit: { command: null }, generated: { dir: 'e2e/bughunter' } },
  };
  await writeJsonAtomic(join(stateDir, 'config.json'), config);
  const run = await createRun('target', '/', { config, projectRoot: stateDir, stateDir });
  const manager = new SessionManager(config, stateDir);
  try {
    const { sessionId } = await manager.open(run.id, '/', 'network-journal');
    await manager.probe(sessionId, 'reload');
    await manager.close(sessionId);
    const journal = JSON.parse(await readFile(
      join(stateDir, 'runs', run.id, 'journals', `${sessionId}.json`),
      'utf8',
    )) as { steps: Array<{ kind: string; responseHashes?: string[] }> };
    const withHashes = journal.steps.filter((step) => (step.responseHashes?.length ?? 0) > 0);
    assert.ok(withHashes.length > 0, 'в журнале нет ни одного шага с responseHashes');
    assert.match(withHashes[0]!.responseHashes![0]!, /^[0-9a-f]{64}$/);
  } finally {
    await manager.closeAll();
  }
});

test('response bodies stay readable while a context route guard intercepts requests', async () => {
  const { page, capture } = await openCapture();
  try {
    await page.context().route('**/*', (route) => {
      void route.continue().catch(() => route.abort());
    });
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    const entry = await capture.waitFor('/api/data', 5000);
    assert.equal(entry.bodyError, undefined, `тело не читается при перехвате: ${entry.bodyError}`);
    assert.deepEqual(entry.json, { ok: true, rows: [1, 2, 3] });
  } finally {
    await capture.dispose();
    await page.close();
  }
});

test('takePending returns only responses accumulated since the previous call', async () => {
  const { page, capture } = await openCapture();
  try {
    await page.goto(`${origin}/`);
    await capture.waitFor('/api/data', 5000);
    const drained = capture.takePending();
    assert.ok(
      drained.some((entry) => entry.url === `${origin}/api/data`),
      'waitFor не потребляет накопленное — очередь забирает takePending',
    );
    assert.equal(capture.takePending().length, 0);
    await page.evaluate(() => { void fetch('/api/csv'); });
    await capture.waitFor('/api/csv', 5000);
    const pending = capture.takePending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.url, `${origin}/api/csv`);
    assert.equal(capture.takePending().length, 0);
    assert.ok(maxResponseBodyBytes > 0);
  } finally {
    await capture.dispose();
    await page.close();
  }
});
