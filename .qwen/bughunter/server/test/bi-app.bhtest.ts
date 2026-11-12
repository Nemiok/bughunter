import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser } from 'playwright-core';
import type { ViteDevServer } from '../fixtures/bi-app/node_modules/vite/dist/node/index.d.ts';

const fixtureRoot = resolve(import.meta.dirname, '../fixtures/bi-app');
let vite: ViteDevServer | undefined;
let browser: Browser;
let baseUrl: string;

/**
 * Общий запуск фикстуры для всех тестов bi-app: её собственный vite на свободном порту,
 * тот же приём, которым test/reproduce.bhtest.ts поднимает buggy-app.
 */
export async function startBiApp(): Promise<{ baseUrl: string; server: ViteDevServer }> {
  const { createServer } = await import('../fixtures/bi-app/node_modules/vite/dist/node/index.js');
  const server: ViteDevServer = await createServer({
    root: fixtureRoot,
    configFile: resolve(fixtureRoot, 'vite.config.ts'),
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address === 'object', 'vite не отдал адрес порта');
  return { baseUrl: `http://127.0.0.1:${address.port}`, server };
}

before(async () => {
  const started = await startBiApp();
  vite = started.server;
  baseUrl = started.baseUrl;
  browser = await chromium.launch({ channel: 'chrome', args: ['--no-first-run', '--no-default-browser-check'] });
});

after(async () => {
  await browser?.close();
  await vite?.close();
});

export function fixtureUrl(path: string): string {
  return new URL(path, baseUrl).href;
}

export function fixtureBrowser(): Browser {
  return browser;
}

test('app shell renders navigation and serves the spa fallback', async () => {
  const page = await (await browser.newContext()).newPage();
  try {
    await page.goto(fixtureUrl('/'), { waitUntil: 'domcontentloaded' });
    assert.match(await page.title(), /Bughunter BI/);
    for (const label of ['Дашборды', 'Отчёты', 'Мастер', 'Настройки']) {
      assert.ok(await page.getByRole('link', { name: label, exact: true }).isVisible(), `нет ссылки ${label}`);
    }

    // Прямой заход на вложенный маршрут: без SPA-fallback vite отдал бы 404.
    const direct = await page.goto(fixtureUrl('/settings'), { waitUntil: 'domcontentloaded' });
    assert.equal(direct?.status(), 200);
    assert.ok(await page.getByRole('link', { name: 'Настройки', exact: true }).isVisible());
  } finally {
    await page.close();
  }
});
