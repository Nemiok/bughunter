import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { crawlScreens } from '../src/discovery/crawl.ts';
import { readScreens, templatisedPathname, upsertScreens } from '../src/discovery/screens-store.ts';
import type { Profile } from '../src/profile/types.ts';
import { writeJsonAtomic } from '@bughunter/core';
import type { Config, ScreenEntry } from '@bughunter/core';

const directories: string[] = [];
let server: Server;
let origin: string;

const outsideOrigin = 'https://example.invalid';

function link(path: string, label: string): string {
  return `<li><a href="${path}">${label}</a></li>`;
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="margin:0;position:relative;width:900px;height:600px"><main>${body}</main></body></html>`;
}

const orderTable = `<table data-testid="orders"><tbody>
<tr><td>1</td><td>10</td></tr>
<tr><td>2</td><td>20</td></tr>
<tr><td>3</td><td>30</td></tr>
</tbody></table>`;

function routes(url: string): string {
  if (url === '/') {
    return page('start', `<ul>
      ${link('/orders/12', 'Order 12')}
      ${link('/orders/7f3ab4c9d1', 'Order uuid')}
      ${link('/profile', 'Profile')}
      ${link(`${outsideOrigin}/outside`, 'Outside')}
      ${link('#anchor', 'Anchor')}
    </ul>`);
  }
  if (url.startsWith('/orders/')) {
    return page('order', `${orderTable}${link('/', 'Back')}`);
  }
  if (url.startsWith('/profile')) {
    return page('profile', `<button data-testid="save">Save</button>${link('/', 'Back')}`);
  }
  if (url === '/spa') {
    // Имитация одностраничного приложения: ссылки появляются в DOM позже domcontentloaded,
    // после загрузки рантайма и данных. Так работает любой SPA, включая целевое BI-приложение.
    return `<!doctype html>
<html><head><meta charset="utf-8"><title>spa</title></head>
<body><div id="root"></div>
<script>
  setTimeout(function () {
    document.getElementById('root').innerHTML = '<a href="/spa/child">Child</a>';
  }, 300);
</script>
</body></html>`;
  }
  if (url === '/spa/child') {
    return page('spa-child', '<p>child</p>');
  }
  return page('missing', '<p>Not found</p>');
}

const profile: Profile = {
  name: 'discovery',
  extractors: [{
    name: 'orders-table',
    widget: 'orders',
    kind: 'table',
    script: '() => ({ rows: document.querySelectorAll(\'[data-testid="orders"] tbody tr\').length })',
  }],
  oracles: [],
};

before(async () => {
  server = createServer((request, response) => {
    const url = (request.url ?? '/').split('?')[0]!;
    response.writeHead(url.startsWith('/missing') ? 404 : 200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(routes(url));
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server?.listening) {
    await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  }
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function stateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'bh-discovery-'));
  directories.push(directory);
  return directory;
}

function crawlOptions(stateDir: string, patch: Partial<Parameters<typeof crawlScreens>[0]> = {}) {
  return {
    baseUrl: origin,
    allowedOrigins: [origin],
    stateDir,
    profile,
    maxScreens: 20,
    maxDepth: 2,
    startPaths: ['/'],
    ...patch,
  };
}

function entry(template: string): ScreenEntry {
  return {
    template,
    sampleUrl: `${origin}${template}`,
    discoveredVia: ['test'],
    widgets: [],
    lastCheckedAt: new Date().toISOString(),
  };
}

test('templatisedPathname folds identifier segments into :id', () => {
  assert.equal(templatisedPathname('/orders/12', '^\\d+$'), '/orders/:id');
  assert.equal(templatisedPathname('/orders/7f3ab4c9d1'), '/orders/:id');
  assert.equal(templatisedPathname('/orders/new'), '/orders/new');
  assert.equal(templatisedPathname('/'), '/');
  assert.throws(() => templatisedPathname('/orders/12', '(['), /PROFILE_INVALID: navigation\.idSegmentPattern/);
});

test('crawl templates dynamic segments and is incremental', async () => {
  const stateDir = await stateDirectory();

  const first = await crawlScreens(crawlOptions(stateDir));
  const screens = await readScreens(stateDir);

  assert.equal(first.stoppedEarly, false);
  assert.deepEqual(screens.map((screen) => screen.template).sort(), ['/', '/orders/:id', '/profile']);
  assert.equal(first.added, 3);
  assert.equal(first.total, 3);
  const order = screens.find((screen) => screen.template === '/orders/:id');
  assert.ok(order?.sampleUrl.startsWith(`${origin}/orders/`));
  assert.deepEqual(order?.widgets, ['orders']);
  assert.deepEqual(order?.discoveredVia, ['/']);

  const second = await crawlScreens(crawlOptions(stateDir));
  const afterSecond = await readScreens(stateDir);

  assert.equal(second.added, 0);
  assert.ok(second.updated > 0, JSON.stringify(second));
  assert.equal(second.total, 3);
  assert.equal(afterSecond.length, 3);
});

test('crawl waits for a late-rendering SPA before collecting links', async () => {
  const stateDir = await stateDirectory();

  const result = await crawlScreens(crawlOptions(stateDir, { startPaths: ['/spa'] }));

  const stored = await readScreens(stateDir);
  assert.deepEqual(
    stored.map((screen) => screen.template).sort(),
    ['/spa', '/spa/child'],
    'обход обязан дождаться рендера приложения и найти отложенные ссылки',
  );
  assert.equal(result.visited, 2);
  assert.equal(result.stoppedEarly, false);
});

test('crawl stays inside allowed origins and records blocked hops', async () => {
  const stateDir = await stateDirectory();

  const result = await crawlScreens(crawlOptions(stateDir));
  const screens = await readScreens(stateDir);

  assert.ok(result.blocked.some((url) => url.startsWith(`${outsideOrigin}/outside`)), JSON.stringify(result.blocked));
  assert.ok(screens.every((screen) => screen.sampleUrl.startsWith(origin)));
  assert.ok(screens.every((screen) => screen.template !== '/outside'));
});

test('crawl stops at maxScreens with stoppedEarly and a reason', async () => {
  const stateDir = await stateDirectory();

  const result = await crawlScreens(crawlOptions(stateDir, { maxScreens: 2, maxDepth: 3 }));

  assert.equal(result.stoppedEarly, true);
  assert.equal(result.reason, 'CRAWL_LIMIT_REACHED');
  assert.equal(result.visited, 2);
  assert.equal(result.total, 2);
});

test('screens store survives concurrent upsert and reports corruption', async () => {
  const concurrent = await stateDirectory();
  await Promise.all([
    upsertScreens(concurrent, [entry('/a')]),
    upsertScreens(concurrent, [entry('/b')]),
    upsertScreens(concurrent, [entry('/c')]),
  ]);
  assert.deepEqual((await readScreens(concurrent)).map((screen) => screen.template).sort(), ['/a', '/b', '/c']);

  const corrupt = await stateDirectory();
  await writeFile(join(corrupt, 'screens.json'), '{ "template": ', 'utf8');
  await assert.rejects(() => readScreens(corrupt), /SCREENS_STORE_CORRUPT/);
  await assert.rejects(() => upsertScreens(corrupt, [entry('/a')]), /SCREENS_STORE_CORRUPT/);
  assert.equal(await readFile(join(corrupt, 'screens.json'), 'utf8'), '{ "template": ');

  await writeFile(join(corrupt, 'screens.json'), '[]', 'utf8');
  assert.deepEqual(await readScreens(corrupt), []);
});

test('bh_crawl is reachable over real stdio MCP', async () => {
  const stateDir = await stateDirectory();
  const config: Config = {
    baseUrl: origin,
    allowedOrigins: [origin],
    routes: ['/'],
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
  await writeJsonAtomic(join(stateDir, 'config.json'), config);
  await writeJsonAtomic(join(stateDir, 'known-bugs.json'), []);
  await writeJsonAtomic(join(stateDir, 'suppressions.json'), []);

  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
    entry[1] !== undefined && !entry[0].startsWith('BUGHUNTER_'),
  ));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(import.meta.dirname, '../src/index.ts')],
    env: { ...env, BUGHUNTER_STATE_DIR: stateDir },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'bughunter-discovery', version: '1.0.0' });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const tool = listed.tools.find((candidate) => candidate.name === 'bh_crawl');
    assert.ok(tool, JSON.stringify(listed.tools.map((candidate) => candidate.name)));
    assert.deepEqual([...(tool.inputSchema as { required?: string[] }).required ?? []], []);

    const response = await client.callTool({
      name: 'bh_crawl',
      arguments: { startPaths: ['/'], maxScreens: 10, maxDepth: 2 },
    });
    assert.notEqual(response.isError, true, JSON.stringify(response.content));
    const content = response.content as Array<{ type: string; text: string }>;
    const value = JSON.parse(content[0]!.text) as { total: number; visited: number; blocked: string[] };
    assert.equal(value.visited, 3);
    assert.equal(value.total, 3);
    assert.ok(value.blocked.some((url) => url.startsWith(outsideOrigin)));
    assert.deepEqual((await readScreens(stateDir)).map((screen) => screen.template).sort(), ['/', '/orders/:id', '/profile']);
  } finally {
    await Promise.allSettled([client.close(), transport.close()]);
  }
});
