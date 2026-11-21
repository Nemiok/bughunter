import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { writeJsonAtomic } from '@bughunter/core';
import { createRun } from '../src/runs.ts';
import { runSweep } from '../src/sweep-visit.ts';
import { crawlScreens } from '../src/discovery/crawl.ts';
import { upsertScreens, readScreens } from '../src/discovery/screens-store.ts';
import { readFindings } from '@bughunter/core';
import type { WebConfig as Config } from '../src/config.ts';

const directories: string[] = [];
const cookiesSeen: string[] = [];
let foreignHits = 0;
let server: Server;
let foreign: Server;
let second: Server;
let origin: string;
let foreignOrigin: string;
let secondOrigin: string;

function page(title: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body><main><h1>${title}</h1></main>
<script>fetch('/api/data').catch(() => undefined);</script></body></html>`;
}

before(async () => {
  foreign = createServer((_request, response) => {
    foreignHits += 1;
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(page('foreign'));
  });
  await new Promise<void>((resolveListen) => foreign.listen(0, '127.0.0.1', resolveListen));
  const foreignAddress = foreign.address();
  assert.ok(foreignAddress && typeof foreignAddress === 'object');
  foreignOrigin = `http://127.0.0.1:${foreignAddress.port}`;

  second = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/data') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ from: 'second' }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(page('second'));
  });
  await new Promise<void>((resolveListen) => second.listen(0, '127.0.0.1', resolveListen));
  const secondAddress = second.address();
  assert.ok(secondAddress && typeof secondAddress === 'object');
  secondOrigin = `http://127.0.0.1:${secondAddress.port}`;

  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    cookiesSeen.push(request.headers.cookie ?? '');
    if (url.pathname === '/api/data') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === '/to-api') {
      response.writeHead(302, { Location: `${secondOrigin}/data` }).end();
      return;
    }
    if (url.pathname === '/chain1') {
      response.writeHead(302, { Location: '/chain2' }).end();
      return;
    }
    if (url.pathname === '/chain2') {
      response.writeHead(302, { Location: `${foreignOrigin}/landed` }).end();
      return;
    }
    if (url.pathname === '/needs-cookie') {
      if ((request.headers.cookie ?? '').includes('bh_auth=1')) {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(page('private'));
      } else {
        response.writeHead(302, { Location: '/login-redirect' }).end();
      }
      return;
    }
    if (url.pathname === '/escape') {
      response.writeHead(302, { Location: `${foreignOrigin}/landed` }).end();
      return;
    }
    if (url.pathname === '/with-subresource') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><head><meta charset="utf-8"><title>sub</title></head>
<body><main><h1>sub</h1></main><script>fetch('/to-api').catch(() => undefined);</script></body></html>`);
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(page(url.pathname === '/login-redirect' ? 'login' : 'ok'));
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  for (const active of [server, foreign, second]) {
    if (active?.listening) {
      await new Promise<void>((resolveClose, reject) => active.close((error) => error ? reject(error) : resolveClose()));
    }
  }
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

function configTemplate(allowedOrigins: string[] = [origin]): Config {
  return {
    baseUrl: origin,
    allowedOrigins,
    routes: ['/ok'],
    targetMap: {},
    baseBranch: 'main',
    limits: { stepsPerSession: 60, candidatesPerRun: 20, responseSettleMs: 500 },
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

async function setup(screens: Array<{ template: string; sampleUrl: string }>, auth: boolean, allowedOrigins?: string[]) {
  const stateDir = await mkdtemp(join(tmpdir(), 'bh-auth-guard-'));
  directories.push(stateDir);
  const config = configTemplate(allowedOrigins);
  await writeJsonAtomic(join(stateDir, 'config.json'), config);
  await writeJsonAtomic(join(stateDir, 'known-bugs.json'), []);
  await writeJsonAtomic(join(stateDir, 'suppressions.json'), []);
  if (auth) {
    await mkdir(join(stateDir, 'auth'), { recursive: true });
    await writeJsonAtomic(join(stateDir, 'auth', 'storage-state.json'), {
      cookies: [{
        name: 'bh_auth', value: '1', domain: '127.0.0.1', path: '/',
        expires: -1, httpOnly: false, secure: false, sameSite: 'Lax',
      }],
      origins: [],
    });
  }
  await upsertScreens(stateDir, screens.map((screen) => ({ ...screen, discoveredVia: ['test'], widgets: [] })));
  const run = await createRun('sweep', undefined, { config, projectRoot: stateDir, stateDir });
  return { stateDir, config, run };
}

test('sweep-carries-auth', async () => {
  cookiesSeen.length = 0;
  const { stateDir, run } = await setup([{ template: '/needs-cookie', sampleUrl: `${origin}/needs-cookie` }], true);
  const result = await runSweep({ runId: run.id, stateDir });
  assert.deepEqual(result.visited, ['/needs-cookie']);
  assert.ok(cookiesSeen.some((cookie) => cookie.includes('bh_auth=1')), 'sweep обязан нести cookie из storage-state');
  const findings = await readFindings(run.id, stateDir);
  assert.ok(findings.some((finding) => finding.targetRef === '/needs-cookie' && finding.kind === 'response-captured'));
});

test('sweep-without-auth-stays-anonymous', async () => {
  cookiesSeen.length = 0;
  const { stateDir, run } = await setup([{ template: '/needs-cookie', sampleUrl: `${origin}/needs-cookie` }], false);
  await runSweep({ runId: run.id, stateDir });
  assert.ok(!cookiesSeen.some((cookie) => cookie.includes('bh_auth=1')));
});

test('sweep-blocks-foreign-redirect', async () => {
  foreignHits = 0;
  const { stateDir, run } = await setup([{ template: '/escape', sampleUrl: `${origin}/escape` }], false);
  await runSweep({ runId: run.id, stateDir });
  assert.equal(foreignHits, 0, 'редирект за разрешённые origins не выполняется');
  const findings = await readFindings(run.id, stateDir);
  assert.ok(findings.some((finding) => finding.targetRef === '/escape' && finding.kind === 'navigation-failed'));
});

test('crawl-carries-auth', async () => {
  cookiesSeen.length = 0;
  const { stateDir, config } = await setup([], true);
  const result = await crawlScreens({
    baseUrl: origin, allowedOrigins: config.allowedOrigins, stateDir, profile: null,
    maxScreens: 5, maxDepth: 1, startPaths: ['/needs-cookie'],
  });
  assert.equal(result.visited, 1);
  assert.ok(cookiesSeen.some((cookie) => cookie.includes('bh_auth=1')), 'crawl обязан нести cookie из storage-state');
});

test('crawl-blocks-foreign-redirect', async () => {
  foreignHits = 0;
  const { stateDir, config } = await setup([], false);
  const result = await crawlScreens({
    baseUrl: origin, allowedOrigins: config.allowedOrigins, stateDir, profile: null,
    maxScreens: 5, maxDepth: 1, startPaths: ['/escape'],
  });
  assert.equal(foreignHits, 0, 'редирект за разрешённые origins не выполняется');
  assert.ok(result.blocked.some((url) => url.includes('/escape')), `переход обязан попасть в blocked: ${JSON.stringify(result.blocked)}`);
});

test('sweep-blocks-redirect-chain', async () => {
  const { stateDir, run } = await setup([
    { template: '/chain1', sampleUrl: `${origin}/chain1` },
    { template: '/ok', sampleUrl: `${origin}/ok` },
  ], false);
  const result = await runSweep({ runId: run.id, stateDir });
  assert.deepEqual(result.visited, ['/chain1', '/ok'], 'обход продолжается после заблокированной цепочки');
  const findings = await readFindings(run.id, stateDir);
  const chain = findings.filter((finding) => finding.targetRef === '/chain1');
  assert.ok(chain.some((finding) => finding.kind === 'navigation-failed'), `цепочка обязана дать navigation-failed: ${JSON.stringify(chain)}`);
  assert.ok(!chain.some((finding) => finding.kind === 'response-captured'), 'чужой DOM не описывается');
  assert.ok(findings.some((finding) => finding.targetRef === '/ok' && finding.kind === 'response-captured'));
});

test('crawl-blocks-redirect-chain', async () => {
  const { stateDir, config } = await setup([], false);
  const result = await crawlScreens({
    baseUrl: origin, allowedOrigins: config.allowedOrigins, stateDir, profile: null,
    maxScreens: 5, maxDepth: 1, startPaths: ['/chain1'],
  });
  assert.ok(result.blocked.some((url) => url.includes('/chain1')), `цепочка обязана попасть в blocked: ${JSON.stringify(result.blocked)}`);
  const screens = await readScreens(stateDir);
  assert.ok(!screens.some((screen) => screen.template.includes('chain')), 'чужой landing не попадает в инвентарь');
});

test('subresource-redirect-between-allowed-origins', async () => {
  const { stateDir, run } = await setup(
    [{ template: '/with-subresource', sampleUrl: `${origin}/with-subresource` }],
    false,
    [origin, secondOrigin],
  );
  await runSweep({ runId: run.id, stateDir });
  const findings = await readFindings(run.id, stateDir);
  const captured = findings.find((finding) => finding.targetRef === '/with-subresource' && finding.kind === 'response-captured');
  assert.ok(captured, 'ответ субресурса после cross-origin редиректа обязан захватываться');
  assert.match(captured.detail, /Ответов: [1-9]/, `редирект между allowed origins не ломается: ${captured.detail}`);
});

test('dead-stand-shows-real-network-error', async () => {
  const dead = createServer();
  await new Promise<void>((resolveListen) => dead.listen(0, '127.0.0.1', resolveListen));
  const deadAddress = dead.address();
  assert.ok(deadAddress && typeof deadAddress === 'object');
  const deadOrigin = `http://127.0.0.1:${deadAddress.port}`;
  await new Promise<void>((resolveClose, reject) => dead.close((error) => error ? reject(error) : resolveClose()));
  const { stateDir, run } = await setup([{ template: '/dead', sampleUrl: `${deadOrigin}/` }], false, [origin, deadOrigin]);
  await runSweep({ runId: run.id, stateDir });
  const findings = await readFindings(run.id, stateDir);
  const failed = findings.find((finding) => finding.targetRef === '/dead' && finding.kind === 'navigation-failed');
  assert.ok(failed, 'мёртвый стенд даёт navigation-failed');
  assert.match(failed.detail, /ERR_CONNECTION_REFUSED/, `видна настоящая сетевая ошибка, не маскировка guard'ом: ${failed.detail}`);
});
