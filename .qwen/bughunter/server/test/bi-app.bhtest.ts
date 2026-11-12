import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import type { ViteDevServer } from '../fixtures/bi-app/node_modules/vite/dist/node/index.d.ts';
import { SEED_VERSION, dataset } from '../fixtures/bi-app/src/mocks/seed.ts';
import { RESET_ENDPOINT, SCENARIO_KEY } from '../fixtures/bi-app/src/mocks/scenarios.ts';

const fixtureRoot = resolve(import.meta.dirname, '../fixtures/bi-app');
let vite: ViteDevServer | undefined;
let browser: Browser;
let baseUrl: string;

/** Форма, в которой хук эталона виден из Node-теста. */
type HookResponse = { url: string; status: number; body: unknown; at: string };

function hookResponses(page: Page): Promise<HookResponse[]> {
  return page.evaluate(() => (window as unknown as { __bhResponses: HookResponse[] }).__bhResponses);
}

function recordedFor(responses: HookResponse[], fragment: string): HookResponse | undefined {
  return responses.find((response) => response.url.includes(fragment));
}

async function fetchJson(page: Page, url: string): Promise<unknown> {
  return page.evaluate(async (path) => {
    const response = await fetch(path);
    return { status: response.status, body: await response.json().catch(() => null), seed: response.headers.get('x-bh-seed') };
  }, url);
}

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

/**
 * Приложение рендерится только после запуска MSW-worker'а, то есть позже `domcontentloaded`:
 * без ожидания маркера оболочки тесты проверяли бы пустой DOM.
 */
async function openFixture(page: Page, path: string): Promise<void> {
  await page.goto(fixtureUrl(path), { waitUntil: 'domcontentloaded' });
  await page.getByTestId('route-marker').waitFor({ state: 'visible', timeout: 15_000 });
}

async function withPage(run: (page: Page) => Promise<void>): Promise<void> {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await run(page);
  } finally {
    await context.close();
  }
}

/** Экран дашборда готов, когда все четыре запроса виджетов завершились (успехом или ошибкой). */
async function openDashboard(page: Page, path = '/dashboard/1'): Promise<void> {
  await openFixture(page, path);
  await page.getByTestId('dashboard-ready').waitFor({ state: 'visible', timeout: 20_000 });
}

async function setScenarioFlag(page: Page, scenario: string): Promise<void> {
  await page.evaluate(([key, value]) => window.localStorage.setItem(key, value), [SCENARIO_KEY, scenario]);
}

function currentScenarioOf(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as { __BHScenario: { current(): string } }).__BHScenario.current());
}

/** Контракт `window.__BHProfile` из `fixtures/bi-app/src/bh-profile.ts` — в тестах повторяется намеренно как внешний контракт. */
type WidgetDescriptor = { widget: string; kind: string; node: string };
type WidgetPoint = { locator: string; text: string; box: { x: number; y: number; width: number; height: number } };
type ResolvedPoint = { locator: string; text: string; role?: string } | null;

function profileWidgets(page: Page): Promise<WidgetDescriptor[]> {
  return page.evaluate(() => (window as unknown as { __BHProfile: { widgets(): WidgetDescriptor[] } }).__BHProfile.widgets());
}

function profileExtract(page: Page, widget: string): Promise<unknown> {
  return page.evaluate((name) => (window as unknown as { __BHProfile: { extract(widget: string): unknown } }).__BHProfile.extract(name), widget);
}

function profilePoints(page: Page, widget: string): Promise<WidgetPoint[]> {
  return page.evaluate((name) => (window as unknown as { __BHProfile: { points(widget: string): WidgetPoint[] } }).__BHProfile.points(name), widget);
}

function profileResolvePoint(page: Page, point: { x: number; y: number }): Promise<ResolvedPoint> {
  return page.evaluate((at) => (window as unknown as { __BHProfile: { resolvePoint(point: { x: number; y: number }): ResolvedPoint } }).__BHProfile.resolvePoint(at), point);
}

function profileSceneInfo(page: Page): Promise<{ objects: number; layers: string[] } | null> {
  return page.evaluate(() => (window as unknown as { __BHProfile: { sceneInfo(): { objects: number; layers: string[] } | null } }).__BHProfile.sceneInfo());
}

test('app shell renders navigation and serves the spa fallback', async () => {
  await withPage(async (page) => {
    await openFixture(page, '/');
    assert.match(await page.title(), /Bughunter BI/);
    for (const label of ['Дашборды', 'Отчёты', 'Мастер', 'Настройки']) {
      assert.ok(await page.getByRole('link', { name: label, exact: true }).isVisible(), `нет ссылки ${label}`);
    }
    assert.match(await page.getByTestId('seed-info').innerText(), new RegExp(SEED_VERSION));

    // Прямой заход на вложенный маршрут: без SPA-fallback vite отдал бы 404.
    const direct = await page.goto(fixtureUrl('/settings'), { waitUntil: 'domcontentloaded' });
    assert.equal(direct?.status(), 200);
    await page.getByTestId('route-marker').waitFor({ state: 'visible', timeout: 15_000 });
    assert.match(await page.getByTestId('route-marker').innerText(), /\/settings/);
  });
});

test('msw serves seeded datasets and records every mocked response', async () => {
  await withPage(async (page) => {
    await openFixture(page, '/');

    // Экраны появятся в следующей задаче, поэтому слой моков проверяется прямым запросом.
    const response = await fetchJson(page, '/api/dashboards') as { status: number; body: unknown[]; seed: string | null };
    assert.equal(response.status, 200);
    assert.equal(response.seed, SEED_VERSION);
    assert.equal(response.body.length, dataset('normal').dashboards.length);

    const recorded = recordedFor(await hookResponses(page), '/api/dashboards');
    assert.ok(recorded, 'хук эталона не записал ответ /api/dashboards');
    assert.equal(recorded.status, 200);
    assert.equal((recorded.body as unknown[]).length, dataset('normal').dashboards.length);
    assert.match(recorded.at, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test('scenario flag switches datasets and the reset endpoint restores the seed', async () => {
  await withPage(async (page) => {
    await openFixture(page, '/');

    await setScenarioFlag(page, 'empty');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('route-marker').waitFor({ state: 'visible', timeout: 15_000 });
    assert.equal(await currentScenarioOf(page), 'empty');
    const empty = await fetchJson(page, '/api/dashboards') as { body: unknown[] };
    assert.deepEqual(empty.body, []);

    await page.evaluate((endpoint) => fetch(endpoint, { method: 'POST' }), RESET_ENDPOINT);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('route-marker').waitFor({ state: 'visible', timeout: 15_000 });
    assert.equal(await currentScenarioOf(page), 'normal');
    const restored = await fetchJson(page, '/api/dashboards') as { body: unknown[] };
    assert.equal(restored.body.length, dataset('normal').dashboards.length);
  });
});

test('response hook exists before the first fetch on a cold load', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    const seenByPlaywright: string[] = [];
    page.on('response', (response) => {
      if (response.url().includes('/api/')) seenByPlaywright.push(new URL(response.url()).pathname);
    });

    await openFixture(page, '/');
    await page.waitForFunction(() => (window as unknown as { __bhResponses: unknown[] }).__bhResponses.length > 0, undefined, { timeout: 15_000 });

    const seenByHook = (await hookResponses(page)).map((response) => new URL(response.url).pathname);
    assert.ok(seenByHook.length >= 1, 'хук не записал ни одного ответа');
    // Если бы хук регистрировался после первого fetch, списки разошлись бы именно началом.
    assert.deepEqual(seenByHook, seenByPlaywright);
    assert.ok(seenByHook.includes('/api/meta'));
  } finally {
    await context.close();
  }
});

test('big scenario serves thousands of rows and the page stays clean', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await openFixture(page, '/');
    await setScenarioFlag(page, 'big');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('route-marker').waitFor({ state: 'visible', timeout: 15_000 });

    const response = await fetchJson(page, '/api/dashboards/1/widgets/table') as { body: { rows: unknown[] } };
    assert.ok(response.body.rows.length >= 5000, `ожидалось не меньше 5000 строк, получено ${response.body.rows.length}`);

    const recorded = recordedFor(await hookResponses(page), '/widgets/table');
    assert.ok(recorded, 'большой ответ не записан хуком');
    assert.equal(((recorded.body as { rows: unknown[] }).rows).length, response.body.rows.length);

    const title = await page.title();
    for (const anomaly of ['undefined', 'NaN', '[object Object]', 'Invalid Date']) {
      assert.ok(!title.includes(anomaly), `в заголовке оказалась аномалия ${anomaly}`);
    }
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

test('every screen route renders its own content', async () => {
  const routes: Array<[string, string]> = [
    ['/dashboards', 'dashboards-list'],
    ['/reports', 'reports-list'],
    ['/wizard', 'wizard-step'],
    ['/settings', 'settings-form'],
    ['/clean', 'clean-marker'],
    ['/report/r-001', 'report-title'],
    ['/dashboard/1', 'widget-table'],
  ];
  await withPage(async (page) => {
    for (const [path, marker] of routes) {
      await openFixture(page, path);
      assert.ok(await page.getByTestId(marker).isVisible(), `${path}: не отрендерил ${marker}`);
    }
  });
});

test('dashboard screen renders four widgets and exposes them through __BHProfile', async () => {
  await withPage(async (page) => {
    await openDashboard(page);

    const widgets = await profileWidgets(page);
    assert.deepEqual(widgets.map((widget) => widget.widget).sort(), ['bars', 'line', 'scene', 'table']);
    assert.deepEqual(
      widgets.map((widget) => [widget.widget, widget.kind]).sort(),
      [['bars', 'chart'], ['line', 'chart'], ['scene', 'scene'], ['table', 'table']].sort(),
    );

    const table = await profileExtract(page, 'table') as { rows: Array<{ value: number }>; total: number };
    assert.equal(table.rows.length, dataset('normal').widgets.table.rows.length);
    assert.equal(typeof table.total, 'number');

    const bars = await profileExtract(page, 'bars') as { bars: unknown[] };
    assert.equal(bars.bars.length, dataset('normal').widgets.bars.bars.length);

    // Четыре разные технологии рендеринга на одном экране.
    assert.ok(await page.getByTestId('widget-table').isVisible());
    assert.ok(await page.locator('[data-testid="widget-line"] svg').isVisible());
    assert.ok(await page.locator('[data-testid="widget-bars"] canvas').isVisible());
    assert.ok(await page.locator('[data-testid="widget-scene"] canvas').isVisible());
  });
});

test('konva bar is reachable by coordinates through the profile hook', async () => {
  await withPage(async (page) => {
    await openDashboard(page);

    const points = await profilePoints(page, 'bars');
    assert.ok(points.length >= 12, `ожидалось не меньше 12 целей, получено ${points.length}`);
    const third = points[2]!;
    const center = {
      x: Math.round(third.box.x + third.box.width / 2),
      y: Math.round(third.box.y + third.box.height / 2),
    };

    const resolved = await profileResolvePoint(page, center);
    assert.equal(resolved?.locator, third.locator);
    assert.equal(resolved?.text, third.text);
    assert.ok(third.box.width > 0 && third.box.height > 0);

    // Точка вне виджетов не должна превращаться в цель: иначе координатный клик
    // по пустому месту выглядел бы как осмысленное действие.
    assert.equal(await profileResolvePoint(page, { x: 3, y: 3 }), null);
  });
});

test('3d scene renders in headless chrome without extra launch args', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  try {
    await openDashboard(page);
    const info = await profileSceneInfo(page);
    assert.ok(info !== null, 'sceneInfo вернул null — сцена не собрана');
    assert.ok(info.objects >= 3, `ожидалось не меньше 3 объектов сцены, получено ${info.objects}`);
    assert.ok(info.layers.length >= 1);
    assert.deepEqual(pageErrors, []);
  } finally {
    await context.close();
  }
});

test('dashboard ids template into one inventory entry while report slugs stay distinct', async () => {
  await withPage(async (page) => {
    await openFixture(page, '/dashboards');
    // Ссылки появляются только после ответа API: ждать нужно их, а не маркер оболочки.
    await page.waitForFunction(
      () => document.querySelectorAll('a[href^="/dashboard/"]').length === 120,
      undefined,
      { timeout: 20_000 },
    );
    const dashboardLinks = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href^="/dashboard/"]')).map((link) => link.getAttribute('href') ?? ''));
    assert.equal(dashboardLinks.length, 120);
    assert.ok(dashboardLinks.every((href) => /^\/dashboard\/\d+$/.test(href)), 'ссылки дашбордов должны быть числовыми, чтобы шаблонизироваться в /dashboard/:id');

    await openFixture(page, '/reports');
    await page.waitForFunction(
      () => document.querySelectorAll('a[href^="/report/"]').length === 120,
      undefined,
      { timeout: 20_000 },
    );
    const reportLinks = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href^="/report/"]')).map((link) => link.getAttribute('href') ?? ''));
    assert.equal(reportLinks.length, 120);
    assert.equal(new Set(reportLinks).size, 120);
    // Нечисловой slug не сворачивается в :id — это и даёт 120 отдельных экранов в инвентаре.
    assert.ok(reportLinks.every((href) => !/^\/report\/\d+$/.test(href)), 'slug отчёта не должен выглядеть как числовой идентификатор');
  });
});

test('wizard moves a field onto the shelf by drag and drop', async () => {
  await withPage(async (page) => {
    await openFixture(page, '/wizard');
    assert.match(await page.getByTestId('wizard-step').innerText(), /Шаг 1/);
    assert.equal((await page.getByTestId('shelf-items').innerText()).trim(), '');

    await page.getByTestId('field-revenue').dragTo(page.getByTestId('shelf'));

    assert.match(await page.getByTestId('shelf-items').innerText(), /Выручка/);
    await page.getByTestId('wizard-next').click();
    assert.match(await page.getByTestId('wizard-step').innerText(), /Шаг 2/);
  });
});

const ANOMALY_TEXTS = ['undefined', 'NaN', '[object Object]', 'Invalid Date'];

test('every seeded data bug is observable through the widget projection', async () => {
  await withPage(async (page) => {
    await openDashboard(page);

    // D1 — итог не равен сумме строк.
    const table = await profileExtract(page, 'table') as { rows: Array<{ id: number; region: string; value: number }>; total: number };
    const sum = table.rows.reduce((total, row) => total + row.value, 0);
    assert.ok(Math.abs(table.total - sum) > 0.01, `D1: total ${table.total} при сумме строк ${sum}`);

    // D2 — округление не в ту сторону: 1234.565 → 1234.56 вместо 1234.57.
    assert.match(await page.getByTestId('kpi-avg').innerText(), /1\s?234,56/);

    // D3 — сдвиг часового пояса: 2026-03-01T00:00:00Z показано как 28.02.2026.
    assert.match(await page.getByTestId('dashboard-updated').innerText(), /28\.02\.2026/);

    // D6 — доля считается от неверной базы: 37% вместо 52%.
    assert.match(await page.getByTestId('kpi-share').innerText(), /37%/);

    // D5 — вторая страница таблицы повторяет строку id 7.
    await page.getByTestId('table-more').click();
    await page.waitForFunction(() => {
      const rows = ((window as unknown as { __BHProfile: { extract(w: string): { rows: Array<{ id: number }> } } })
        .__BHProfile.extract('table')).rows;
      return rows.filter((row) => row.id === 7).length === 2;
    }, undefined, { timeout: 15_000 });

    // D4 — фильтр применён к таблице и не применён к линейному графику.
    await page.getByTestId('filter-region').selectOption('ural');
    await page.waitForFunction(() => {
      const rows = ((window as unknown as { __BHProfile: { extract(w: string): { rows: Array<{ region: string }> } } })
        .__BHProfile.extract('table')).rows;
      return rows.length > 0 && rows.every((row) => row.region === 'ural');
    }, undefined, { timeout: 15_000 });
    const line = await profileExtract(page, 'line') as { points: unknown[] };
    assert.equal(line.points.length, dataset('normal').widgets.line.points.length, 'D4: линейный график не отреагировал на фильтр');
  });
});

test('unhandled exception on settings is visible as a pageerror signal', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await openFixture(page, '/settings');
    const [error] = await Promise.all([
      page.waitForEvent('pageerror', { timeout: 15_000 }),
      page.getByTestId('export-csv').click(),
    ]);
    assert.match(error.message, /Cannot read properties of null/);
  } finally {
    await context.close();
  }
});

test('race on fast filter change is visible as a console error', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  try {
    await openFixture(page, '/dashboard/1');
    await setScenarioFlag(page, 'latency');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('dashboard-ready').waitFor({ state: 'visible', timeout: 30_000 });

    const filter = page.getByTestId('filter-region');
    await filter.selectOption('ural');
    await filter.selectOption('siberia');
    await page.waitForTimeout(3_000);

    assert.ok(consoleErrors.some((text) => text.includes('RACE')), JSON.stringify(consoleErrors));
    assert.deepEqual(consoleErrors.filter((text) => text.includes('RACE')).length > 0, true);
  } finally {
    await context.close();
  }
});

test('double submit of the wizard creates two requests and leaves no signal at all', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const failedResponses: string[] = [];
  const saves: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('response', (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.url()} ${response.status()}`);
  });
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/wizard/save')) saves.push(request.url());
  });
  try {
    await openFixture(page, '/wizard');
    await page.getByTestId('wizard-next').click();
    await page.getByTestId('wizard-next').click();
    await page.getByTestId('wizard-save').dblclick();
    await page.waitForFunction(
      () => document.querySelector('[data-testid="wizard-summary"]')?.textContent?.includes('2') ?? false,
      undefined,
      { timeout: 15_000 },
    );

    assert.equal(saves.length, 2, 'двойная отправка обязана создать два запроса');
    assert.match(await page.getByTestId('wizard-summary').innerText(), /Сохранённых отчётов: 2/);
    // N3 — это и есть граница существующих детекторов: нарушение кратности не оставляет сигнала.
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(consoleErrors, []);
    assert.deepEqual(failedResponses, []);
  } finally {
    await context.close();
  }
});

test('legal transformations render correctly and produce no anomaly text', async () => {
  await withPage(async (page) => {
    await openFixture(page, '/clean');
    assert.match(await page.getByTestId('clean-abbrev').innerText(), /1[.,]2K/);
    assert.match(await page.getByTestId('clean-number').innerText(), /234,57/);
    assert.match(await page.getByTestId('clean-date').innerText(), /01\.03\.2026/);
    assert.match(await page.getByTestId('clean-total').innerText(), /2\s?400,00/);

    await openDashboard(page);
    for (const text of [await page.locator('body').innerText()]) {
      for (const anomaly of ANOMALY_TEXTS) {
        assert.ok(!text.includes(anomaly), `на экране найдена аномалия ${anomaly}`);
      }
    }
  });
});
