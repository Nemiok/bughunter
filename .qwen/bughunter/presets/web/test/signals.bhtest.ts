import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';
import { chromium, type Browser } from 'playwright-core';
import { findAnomalyTexts, scanSignals } from '../src/detectors/index.ts';
import type { Config } from '@bughunter/core';

let browser: Browser;
let server: Server;
let origin: string;

before(async () => {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  server = createServer((request, response) => {
    if (request.url?.startsWith('/missing')) {
      response.writeHead(404).end('missing');
      return;
    }
    if (request.url === '/clean') {
      response.writeHead(200, { 'Content-Type': 'text/html' }).end('<main>Total 0</main>');
      return;
    }
    if (request.url === '/transient') {
      response.writeHead(200, { 'Content-Type': 'text/html' }).end(`<main>Total <span id="total">NaN</span></main><script>
        setTimeout(() => { document.getElementById('total').textContent = '0'; }, 0);
      </script>`);
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html' }).end('<main>Total NaN today</main>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await browser?.close();
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

function configTemplate(): Config {
  return {
    baseUrl: 'http://127.0.0.1',
    allowedOrigins: ['http://127.0.0.1'],
    routes: ['/'],
    routeMap: {},
    baseBranch: 'main',
    limits: { stepsPerSession: 60, candidatesPerRun: 20 },
    safety: { forbiddenActionText: [], readOnly: false },
    testDataPrefix: 'bh_',
    detectors: {
      ignoreConsole: ['Ignore me'],
      ignoreRequests: ['/ignored'],
      anomalyTexts: ['NaN', 'undefined', '[object Object]'],
      errorBoundarySelector: '[data-error-boundary]',
    },
    tests: { unit: { command: null }, e2e: { dir: 'e2e/bughunter' } },
  };
}

test('anomaly matching respects token boundaries and escapes literal tokens', () => {
  assert.deepEqual(findAnomalyTexts('Total NaN today', ['NaN']), ['NaN']);
  assert.deepEqual(findAnomalyTexts('NaNagus undefinedValue', ['NaN', 'undefined']), []);
  assert.deepEqual(findAnomalyTexts('literal [object Object]', ['[object Object]']), ['[object Object]']);
  assert.deepEqual(findAnomalyTexts('a+b and aXb', ['a+b']), ['a+b']);
});

test('scanSignals captures browser, network, text, and boundary signals and applies ignores', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(origin);
    const config = configTemplate();
    const initial = await scanSignals(page, config);
    assert.deepEqual(initial.map((signal) => signal.kind), ['anomaly']);
    assert.equal(initial[0]?.message, 'NaN');
    assert.notEqual(initial[0]?.id, '');

    const consoleEvent = page.waitForEvent('console', (message) => message.text().includes('Order 123 failed'));
    const errorEvent = page.waitForEvent('pageerror');
    const responseEvent = page.waitForEvent('response', (response) => response.status() === 404);
    const failedEvent = page.waitForEvent('requestfailed');
    await page.route('**/failed*', (route) => route.abort());
    await page.route('**/ignored*', (route) => route.abort());
    await page.evaluate(() => {
      console.error('Ignore me 123');
      console.error('Order 123 failed');
      setTimeout(() => { throw new Error('Profile 42 exploded'); }, 0);
      void fetch('/missing?id=42');
      void fetch('/failed?id=42').catch(() => undefined);
      void fetch('/ignored?id=42').catch(() => undefined);
    });
    await Promise.all([consoleEvent, errorEvent, responseEvent, failedEvent]);
    await page.evaluate(() => {
      const boundary = document.createElement('div');
      boundary.dataset.errorBoundary = '';
      boundary.textContent = 'Something went wrong 42';
      document.body.append(boundary);
    });

    const signals = await scanSignals(page, config);
    assert.ok(signals.some((signal) => signal.kind === 'console' && signal.message === 'Order 123 failed'));
    assert.ok(signals.some((signal) => signal.kind === 'pageerror' && signal.message.includes('Profile 42 exploded')));
    assert.ok(signals.some((signal) => signal.kind === 'response' && signal.status === 404));
    assert.ok(signals.some((signal) => signal.kind === 'requestfailed' && signal.url?.includes('/failed')));
    assert.ok(signals.some((signal) => signal.kind === 'errorBoundary' && signal.message.includes('Something went wrong')));
    assert.ok(signals.every((signal) => !signal.message.includes('Ignore me') && !signal.url?.includes('/ignored')));
    assert.ok(signals.every((signal) => signal.signature.length === 64 && signal.route === '/'));
    assert.deepEqual(await scanSignals(page, config), []);
  } finally {
    await page.close();
  }
});

test('transient anomalies are captured between scans and during initial page load', async () => {
  const config = configTemplate();
  const page = await browser.newPage();
  try {
    await page.goto(`${origin}/clean`);
    await scanSignals(page, config);
    await page.evaluate(async () => {
      const total = document.querySelector('main')!;
      total.textContent = 'Total NaN';
      await new Promise((resolve) => setTimeout(resolve, 0));
      total.textContent = 'Total 0';
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const betweenScans = await scanSignals(page, config);
    assert.equal(betweenScans.filter((signal) => signal.kind === 'anomaly' && signal.message === 'NaN').length, 1);
    assert.deepEqual(await scanSignals(page, config), []);
  } finally {
    await page.close();
  }

  const initialPage = await browser.newPage();
  try {
    await scanSignals(initialPage, config);
    await initialPage.goto(`${origin}/transient`, { waitUntil: 'domcontentloaded' });
    await initialPage.waitForFunction(() => document.body.innerText.includes('Total 0'));
    const initialLoad = await scanSignals(initialPage, config);
    assert.equal(initialLoad.filter((signal) => signal.kind === 'anomaly' && signal.message === 'NaN').length, 1);
    assert.deepEqual(await scanSignals(initialPage, config), []);
  } finally {
    await initialPage.close();
  }
});

test('error boundary hide and show between scans emits exactly one new appearance', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<div data-error-boundary>Recovered failure</div>');
    const config = configTemplate();
    config.detectors.anomalyTexts = [];
    const initial = await scanSignals(page, config);
    assert.equal(initial.filter((signal) => signal.kind === 'errorBoundary').length, 1);

    await page.evaluate(async () => {
      const boundary = document.querySelector<HTMLElement>('[data-error-boundary]')!;
      boundary.style.display = 'none';
      await new Promise((resolve) => setTimeout(resolve, 0));
      boundary.style.display = '';
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const signals = await scanSignals(page, config);
    assert.equal(signals.filter((signal) => signal.kind === 'errorBoundary').length, 1);
    assert.deepEqual(await scanSignals(page, config), []);
  } finally {
    await page.close();
  }
});
