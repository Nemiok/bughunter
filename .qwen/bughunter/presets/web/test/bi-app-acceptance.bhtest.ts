import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import type { Page } from 'playwright-core';
import type { ViteDevServer } from '../../../fixtures/bi-app/node_modules/vite/dist/node/index.d.ts';
import { SCENARIO_KEY } from '../../../fixtures/bi-app/src/mocks/scenarios.ts';
import { SessionManager, type StateResult } from '../src/browser/session.ts';
import { crawlScreens, type CrawlResult } from '../src/discovery/crawl.ts';
import { readScreens, templatisedPathname, upsertScreens } from '../src/discovery/screens-store.ts';
import { loadActiveProfile, loadProfile } from '../src/profile/load.ts';
import { readFindings, readRun, writeJsonAtomic } from '@bughunter/core';
import { createRun, finishRun } from '../src/runs.ts';
import { runSweep } from '../src/sweep-visit.ts';
import type { WebConfig as Config } from '../src/config.ts';
import type { ScreenEntry } from '../src/types.ts';
import type { Profile } from '../src/profile/types.ts';

const fixtureRoot = resolve(import.meta.dirname, '../../../fixtures/bi-app');
const profileSource = join(fixtureRoot, 'bughunter-profile');
const acceptanceReportPath = join(fixtureRoot, 'ACCEPTANCE.md');

const temporaryDirectories: string[] = [];
const servers: ViteDevServer[] = [];
const managers: SessionManager[] = [];

after(async () => {
  await Promise.all(managers.map((manager) => manager.closeAll()));
  await Promise.all(servers.map((server) => server.close()));
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

/** Профиль кладётся в stateDir так же, как его кладёт пользователь настоящего проекта. */
async function copyProfile(stateDir: string): Promise<void> {
  const entry = join(stateDir, 'profiles', 'bi');
  await mkdir(entry, { recursive: true });
  await cp(join(profileSource, 'index.ts'), join(entry, 'index.ts'));
}

export type BiAcceptanceContext = {
  baseUrl: string;
  stateDir: string;
  config: Config;
  close(): Promise<void>;
};

/**
 * Стенд приёмки: живой vite фикстуры плюс временный stateDir, в который профиль приложения
 * скопирован так же, как его кладёт пользователь настоящего проекта. Каталог `state/`
 * репозитория не затрагивается, поэтому прогоны приёмки не оставляют следов в доказательствах.
 */
export async function biAcceptanceContext(): Promise<BiAcceptanceContext> {
  const { createServer } = await import('../../../fixtures/bi-app/node_modules/vite/dist/node/index.js');
  const server: ViteDevServer = await createServer({
    root: fixtureRoot,
    configFile: resolve(fixtureRoot, 'vite.config.ts'),
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  servers.push(server);
  const address = server.httpServer?.address();
  assert.ok(address && typeof address === 'object', 'vite не отдал адрес порта');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const stateDir = await mkdtemp(join(tmpdir(), 'bh-bi-acceptance-'));
  temporaryDirectories.push(stateDir);
  await writeJsonAtomic(join(stateDir, 'known-bugs.json'), []);
  await writeJsonAtomic(join(stateDir, 'suppressions.json'), []);

  await copyProfile(stateDir);

  const config: Config = {
    baseUrl,
    allowedOrigins: [baseUrl],
    routes: ['/dashboards', '/dashboard/1', '/reports', '/report/r-001', '/wizard', '/settings', '/clean'],
    targetMap: {},
    baseBranch: 'main',
    profile: 'bi',
    limits: {
      stepsPerSession: 60,
      candidatesPerRun: 20,
      elementsPerSnapshot: 120,
      responseSettleMs: 400,
      screensPerSweep: 25,
    },
    safety: { forbiddenActionText: ['удалить', 'delete'], readOnly: false },
    testDataPrefix: 'bh_',
    detectors: {
      ignoreConsole: [],
      ignoreRequests: [],
      anomalyTexts: ['undefined', 'NaN', '[object Object]', 'Invalid Date'],
      errorBoundarySelector: '[data-error-boundary]',
    },
    tests: { unit: { command: null }, generated: { dir: 'e2e/bughunter' } },
  };
  await writeJsonAtomic(join(stateDir, 'config.json'), config);

  return {
    baseUrl,
    stateDir,
    config,
    async close() {
      const index = servers.indexOf(server);
      if (index >= 0) servers.splice(index, 1);
      await server.close();
    },
  };
}

/**
 * Сессия ядра поверх живого приложения: отдельный stateDir на сессию, чтобы журналы и артефакты
 * разных тестов не смешивались. Конфиг берётся из стенда приёмки и при необходимости правится.
 */
async function openSession(target: string, patch?: (config: Config) => void) {
  const stateDir = await mkdtemp(join(tmpdir(), 'bh-bi-session-'));
  temporaryDirectories.push(stateDir);
  await copyProfile(stateDir);
  await writeJsonAtomic(join(stateDir, 'known-bugs.json'), []);
  await writeJsonAtomic(join(stateDir, 'suppressions.json'), []);
  const config: Config = structuredClone(acceptance.config);
  patch?.(config);
  await writeJsonAtomic(join(stateDir, 'config.json'), config);
  const manager = new SessionManager(config, stateDir, profile);
  managers.push(manager);
  const { sessionId } = await manager.open('run-acceptance', target, 'новичок');
  return { manager, sessionId, stateDir };
}

function summaryOf(state: StateResult, widget: string): unknown {
  return state.screen?.widgets.find((entry) => entry.widget === widget)?.summary;
}

type WidgetPoint = { locator: string; text: string; box: { x: number; y: number; width: number; height: number } };

/**
 * Точку третьего столбца называет хук приложения, а не тест: координаты canvas-целей нельзя
 * выдумывать. Виджет ниже первого экрана, поэтому хелпер возвращает и дельту прокрутки,
 * на которую нужно сдвинуть страницу сессии, чтобы точка попала в viewport (координаты
 * `points()` viewport-относительные). Viewport совпадает с дефолтным у SessionManager (1280×720).
 */
let barTarget: { at: { x: number; y: number }; delta: number } | undefined;

async function pointOfThirdBar(): Promise<{ at: { x: number; y: number }; delta: number }> {
  if (barTarget !== undefined) return barTarget;
  const browser = await chromium.launch({ channel: 'chrome', args: ['--no-first-run', '--no-default-browser-check'] });
  try {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${acceptance.baseUrl}/dashboard/1`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('dashboard-ready').waitFor({ state: 'visible', timeout: 20_000 });
    const readPoints = () => page.evaluate(() =>
      (window as unknown as { __BHProfile: { points(widget: string): WidgetPoint[] } }).__BHProfile.points('bars'));
    const [before] = await readPoints();
    assert.ok(before, 'хук приложения не отдал цель третьего столбца');
    const delta = Math.max(Math.round(before.box.y) - 100, 0);
    await page.evaluate((offset) => window.scrollBy(0, offset), delta);
    const points = await readPoints();
    const third = points[2];
    assert.ok(third, `после прокрутки хук отдал ${points.length} целей`);
    barTarget = {
      at: {
        x: Math.round(third.box.x + third.box.width / 2),
        y: Math.round(third.box.y + third.box.height / 2),
      },
      delta,
    };
    return barTarget;
  } finally {
    await browser.close();
  }
}

/**
 * Прокрутка страницы и перерисовка canvas асинхронны, а координаты приходят из отдельного браузера:
 * без ожидания клик ловил гонку (`POINT_TARGET_UNRESOLVED`) под нагрузкой полного прогона.
 * Ждём того же, чего требует production-путь, — чтобы под точкой был элемент и хук профиля назвал цель.
 */
async function waitForPointTarget(page: Page, at: { x: number; y: number }): Promise<void> {
  const hook = profile.interactions?.resolvePoint;
  assert.ok(hook, 'профиль приёмки обязан объявлять interactions.resolvePoint');
  await page.waitForFunction(
    (input: { source: string; x: number; y: number }) => {
      if (document.elementFromPoint(input.x, input.y) === null) return false;
      const resolvePoint = new Function('point', `return (${input.source})(point);`) as
        (point: { x: number; y: number }) => { locator?: unknown } | null;
      const resolved = resolvePoint({ x: input.x, y: input.y });
      return resolved !== null && typeof resolved.locator === 'string' && resolved.locator.length > 0;
    },
    { source: hook, x: at.x, y: at.y },
    { timeout: 20_000, polling: 100 },
  );
}

let acceptance: BiAcceptanceContext;
let profile: Profile;
let crawl: CrawlResult;
let screens: ScreenEntry[];
let crawlStartedAt = 0;
let crawlFinishedAt = 0;

/**
 * Обход инвентаря выполняется один раз на файл: он же предусловие sweeps и снимков,
 * а повторять его в каждом тесте значило бы платить минуту-другую по семь раз.
 */
before(async () => {
  acceptance = await biAcceptanceContext();
  profile = await loadProfile(acceptance.stateDir, 'bi');
  crawlStartedAt = Date.now();
  crawl = await crawlScreens({
    baseUrl: acceptance.baseUrl,
    allowedOrigins: [acceptance.baseUrl],
    stateDir: acceptance.stateDir,
    profile,
    maxScreens: 400,
    maxDepth: 4,
    startPaths: ['/'],
  });
  crawlFinishedAt = Date.now();
  screens = await readScreens(acceptance.stateDir);
});

test('profile for the fixture loads and passes the schema', async () => {
  assert.equal(profile.name, 'bi');
  assert.deepEqual(
    profile.extractors.map((extractor) => extractor.widget).sort(),
    ['bars', 'line', 'scene', 'shelf', 'table'],
  );
  assert.deepEqual(profile.reset, { kind: 'storage-flag', key: SCENARIO_KEY });
  // Решение спайка S1: основной источник эталона — контекстные слушатели Playwright,
  // страничный хук MSW остаётся запасным путём и профилем не включается.
  assert.equal(profile.responseSource, 'playwright');
  assert.equal(typeof profile.interactions?.resolvePoint, 'string');
  assert.ok(profile.oracles.some((oracle) => oracle.widget === 'table'), 'нужна привязка оракула к таблице');

  const pattern = profile.navigation?.idSegmentPattern;
  assert.ok(pattern, 'профиль обязан задавать navigation.idSegmentPattern');
  assert.equal(templatisedPathname('/dashboard/12', pattern), '/dashboard/:id');
  assert.equal(templatisedPathname('/dashboard/7f3ab4c9d2', pattern), '/dashboard/:id');
  // Слаг отчёта — не идентификатор: шаблонизация не должна сливать разные экраны отчётов.
  assert.equal(templatisedPathname('/report/r-001', pattern), '/report/r-001');

  assert.deepEqual(await loadActiveProfile(acceptance.stateDir), profile);
});

test('crawl reaches every screen of the fixture', async () => {
  assert.equal(crawl.stoppedEarly, false, crawl.reason ?? 'обход остановился раньше инвентаря');
  const templates = screens.map((screen) => screen.template);

  for (const expected of ['/', '/dashboards', '/reports', '/wizard', '/settings', '/clean', '/dashboard/:id']) {
    assert.ok(templates.includes(expected), `в инвентаре нет экрана ${expected}`);
  }
  // 120 дашбордов сворачиваются ровно в один шаблон — иначе инвентарь рос бы по числу URL.
  assert.equal(templates.filter((template) => template === '/dashboard/:id').length, 1);

  const reports = templates.filter((template) => template.startsWith('/report/'));
  assert.equal(reports.length, 120, `экранов отчётов: ${reports.length}`);
  assert.equal(new Set(reports).size, 120, 'слаги отчётов обязаны оставаться отдельными экранами');
  assert.equal(templates.includes('/report/:id'), false, 'слаг отчёта не идентификатор');

  // Review Focus 5: ссылка на чужой origin не выполняется, но и не исчезает молча.
  assert.ok(
    crawl.blocked.some((url) => url.startsWith('https://docs.example.invalid/')),
    `внешняя ссылка не попала в blocked: ${JSON.stringify(crawl.blocked)}`,
  );
  assert.equal(crawl.visited, templates.length, 'обход обязан записать каждый посещённый экран');
});

let sweepRunId: string;
let sweepSeconds = 0;
let sweepCalls = 0;

async function readCursor(runId: string): Promise<number> {
  const raw = await readFile(join(acceptance.stateDir, 'runs', runId, 'sweep.json'), 'utf8');
  return (JSON.parse(raw) as { cursor: number }).cursor;
}

test('sweep visits every inventoried screen and resumes from its cursor', async () => {
  const run = await createRun('sweep', undefined, {
    config: acceptance.config,
    projectRoot: acceptance.stateDir,
    stateDir: acceptance.stateDir,
  });
  sweepRunId = run.id;
  const started = Date.now();
  const visited: string[] = [];
  const cursors: number[] = [];

  let result = await runSweep({ runId: run.id, stateDir: acceptance.stateDir, limit: 25 });
  visited.push(...result.visited);
  sweepCalls += 1;
  cursors.push(await readCursor(run.id));
  while (!result.done) {
    assert.equal(result.nextCursor, cursors.at(-1), 'курсор следующего вызова обязан совпадать с сохранённым');
    result = await runSweep({ runId: run.id, stateDir: acceptance.stateDir, limit: 25 });
    visited.push(...result.visited);
    sweepCalls += 1;
    cursors.push(await readCursor(run.id));
  }
  sweepSeconds = (Date.now() - started) / 1000;

  assert.equal(result.done, true);
  assert.equal(result.nextCursor, undefined);
  assert.equal(new Set(visited).size, visited.length, 'экран не должен проходиться дважды');
  assert.deepEqual([...visited].sort(), screens.map((screen) => screen.template).sort());
  assert.ok(sweepCalls >= Math.ceil(screens.length / 25), `вызовов: ${sweepCalls}`);
  for (const [index, cursor] of cursors.entries()) {
    assert.equal(cursor, visited.slice(0, (index + 1) * 25).length, 'курсор равен числу пройденных экранов');
    if (index > 0) assert.ok(cursor > cursors[index - 1]!, 'курсор обязан расти');
  }

  const finished = await readRun(run.id, acceptance.stateDir);
  assert.equal(finished.stages.sweep, 'done');
  assert.equal(finished.stages.findings, 'done');
  const { report } = await finishRun(run.id, acceptance.stateDir);
  assert.match(await readFile(report, 'utf8'), /## Findings/);
});

test('sweep sees responses and projections on every screen', async () => {
  const findings = await readFindings(sweepRunId, acceptance.stateDir);
  const failures = findings.filter((finding) =>
    ['extract-failed', 'navigation-failed', 'response-missing'].includes(finding.kind));

  // Защитные скрипты профиля обязаны отличать «виджет не на этом экране» от поломки экстрактора.
  assert.deepEqual(failures, [], `обход не должен давать сбойных находок: ${JSON.stringify(failures.slice(0, 3))}`);

  for (const screen of screens) {
    const captured = findings.find((finding) =>
      finding.targetRef === screen.template && finding.kind === 'response-captured');
    assert.ok(captured, `нет находки об ответах для ${screen.template}`);
    assert.ok(captured.responseHashes.length >= 1, `пустой набор ответов у ${screen.template}`);
    assert.match(captured.detail, /^Ответов: \d+, с телом: \d+$/);
  }

  // Проекция экрана видна модели: четыре виджета без ошибок и с содержательными сводками.
  const { manager, sessionId } = await openSession('/dashboard/1');
  try {
    const state = await manager.state(sessionId, { screen: true });
    const widgets = state.screen?.widgets ?? [];
    assert.deepEqual(widgets.map((widget) => widget.widget).sort(), ['bars', 'line', 'scene', 'shelf', 'table']);
    for (const widget of widgets) {
      assert.equal(widget.error, undefined, `виджет ${widget.widget} вернулся с ошибкой`);
      assert.equal(widget.truncated, false, `сводка ${widget.widget} обрезана`);
    }
    for (const name of ['bars', 'line', 'scene', 'table']) {
      assert.notEqual(summaryOf(state, name), null, `виджет ${name} не отдал проекцию`);
    }
    // Объявленный профилем виджет, которого на этом экране нет, — это null-сводка, а не поломка.
    assert.equal(summaryOf(state, 'shelf'), null, 'полки мастера на дашборде нет');
    const table = summaryOf(state, 'table') as { rowCount: number; total: number; firstVisibleId: number };
    assert.equal(table.rowCount, 12);
    assert.equal(table.firstVisibleId, 1);
  } finally {
    await manager.close(sessionId);
  }
});

test('snapshot of a dense dashboard stays under the cap and paginates', async () => {
  // На дашборде ~10 интерактивных элементов: данные виджетов живут в проекциях, а не в снимке.
  // Лимит занижен, чтобы механизм обрезки и пагинации проверялся на реальном экране.
  const cap = 5;
  const { manager, sessionId } = await openSession('/dashboard/1', (config) => {
    config.limits.elementsPerSnapshot = cap;
  });
  try {
    const first = await manager.state(sessionId);
    assert.equal(first.elements.length, cap);
    assert.equal(first.truncated, true);
    assert.ok(first.totalVisible > cap, `на экране всего ${first.totalVisible} элементов`);
    assert.ok(first.nextCursor !== undefined, 'обрезанный снимок обязан давать курсор');

    const keys = first.elements.map((element) => JSON.stringify(element.locator));
    let cursor: number | undefined = first.nextCursor;
    while (cursor !== undefined) {
      const next = await manager.state(sessionId, { cursor });
      keys.push(...next.elements.map((element) => JSON.stringify(element.locator)));
      cursor = next.nextCursor;
    }
    assert.equal(new Set(keys).size, keys.length, 'страницы снимка не должны пересекаться');

    const full = await manager.state(sessionId, { full: true });
    assert.equal(full.truncated, false);
    assert.equal(keys.length, full.elements.length, 'пагинация обязана покрыть весь список');
    assert.equal(first.totalVisible, full.elements.length);
  } finally {
    await manager.close(sessionId);
  }
});

test('drag and coordinate actions work on the fixture', async () => {
  // Перетаскивание поля на полку в мастере.
  const wizard = await openSession('/wizard');
  try {
    const state = await wizard.manager.state(wizard.sessionId);
    const byTestId = (testid: string) =>
      state.elements.find((element) => element.locator.kind === 'testid' && element.locator.value === testid);
    const field = byTestId('field-margin');
    const shelf = byTestId('shelf');
    assert.ok(field, 'перетаскиваемое поле обязано быть в снимке');
    assert.ok(shelf, 'зона сброса обязана быть в снимке');

    const dragged = await wizard.manager.act(wizard.sessionId, {
      elementId: field.id, action: 'drag', toElementId: shelf.id,
    });
    assert.equal(dragged.ok, true, dragged.error ?? 'drag не выполнен');

    const after = await wizard.manager.state(wizard.sessionId, { screen: true });
    const shelfState = summaryOf(after, 'shelf') as { items: string[] } | null;
    assert.deepEqual(shelfState?.items, ['Маржа'], 'поле обязано оказаться на полке');
  } finally {
    await wizard.manager.close(wizard.sessionId);
  }

  // Координатное действие по canvas-графику: цель резолвится хуком профиля, а не DOM.
  // В снимке элементов canvas отсутствует — он не интерактивен, поэтому точку называет приложение.
  const dashboard = await openSession('/dashboard/1');
  try {
    const { at, delta } = await pointOfThirdBar();
    const scrolled = await dashboard.manager.act(dashboard.sessionId, {
      action: 'scroll', scroll: { direction: 'down', delta },
    });
    assert.equal(scrolled.ok, true, scrolled.error ?? 'scroll страницы не выполнен');
    await waitForPointTarget(dashboard.manager.pageOf(dashboard.sessionId), at);
    const clicked = await dashboard.manager.act(dashboard.sessionId, { action: 'clickAt', at });
    assert.equal(clicked.ok, true, clicked.error ?? 'clickAt не выполнен');

    const journal = JSON.parse(await readFile(
      join(dashboard.stateDir, 'runs', 'run-acceptance', 'journals', `${dashboard.sessionId}.json`),
      'utf8',
    )) as { steps: Array<{ action: string; resolvedLocator?: string }> };
    const step = journal.steps.at(-1);
    assert.equal(step?.action, 'clickAt');
    assert.equal(step?.resolvedLocator, 'konva://dashboard/1/bars/2', 'цель обязан назвать хук профиля');
  } finally {
    await dashboard.manager.close(dashboard.sessionId);
  }

  // Скролл виртуализированного контейнера меняет видимый набор строк.
  const scrolled = await openSession('/dashboard/1?bhScenario=big');
  try {
    const before = await scrolled.manager.state(scrolled.sessionId, { screen: true });
    const container = before.elements.find((element) =>
      element.locator.kind === 'testid' && element.locator.value === 'table-scroll');
    assert.ok(container, 'контейнер виртуализированной таблицы обязан быть в снимке');
    const beforeSummary = summaryOf(before, 'table') as { firstVisibleId: number };

    const done = await scrolled.manager.act(scrolled.sessionId, {
      elementId: container.id, action: 'scroll', scroll: { direction: 'down', delta: 280 },
    });
    assert.equal(done.ok, true, done.error ?? 'scroll не выполнен');

    const after = await scrolled.manager.state(scrolled.sessionId, { screen: true });
    const afterSummary = summaryOf(after, 'table') as { firstVisibleId: number };
    assert.equal(beforeSummary.firstVisibleId, 1);
    assert.ok(afterSummary.firstVisibleId > beforeSummary.firstVisibleId,
      `видимый набор не изменился: ${beforeSummary.firstVisibleId} → ${afterSummary.firstVisibleId}`);
  } finally {
    await scrolled.manager.close(scrolled.sessionId);
  }
});

test('sweep records findings for a failing screen and keeps going', async () => {
  // Сценарий error500: API экрана отвечает 500, обход пишет находку об ответах и не падает.
  const stateDir = await mkdtemp(join(tmpdir(), 'bh-bi-error-'));
  temporaryDirectories.push(stateDir);
  await copyProfile(stateDir);
  const config: Config = structuredClone(acceptance.config);
  await writeJsonAtomic(join(stateDir, 'config.json'), config);
  await writeJsonAtomic(join(stateDir, 'known-bugs.json'), []);
  await writeJsonAtomic(join(stateDir, 'suppressions.json'), []);
  await upsertScreens(stateDir, [
    {
      template: '/dashboard/:id',
      sampleUrl: `${acceptance.baseUrl}/dashboard/1?bhScenario=error500`,
      discoveredVia: ['test'],
      widgets: [],
    },
    {
      template: '/broken',
      sampleUrl: 'http://127.0.0.1:1/broken',
      discoveredVia: ['test'],
      widgets: [],
    },
    { template: '/clean', sampleUrl: `${acceptance.baseUrl}/clean`, discoveredVia: ['test'], widgets: [] },
  ]);
  const run = await createRun('sweep', undefined, { config, projectRoot: stateDir, stateDir });

  const result = await runSweep({ runId: run.id, stateDir });

  assert.equal(result.done, true);
  assert.deepEqual(result.visited, ['/dashboard/:id', '/broken', '/clean'], 'обход обязан пройти все экраны');
  const findings = await readFindings(run.id, stateDir);
  const broken = findings.filter((finding) => finding.targetRef === '/broken');
  assert.equal(broken.length, 1);
  assert.equal(broken[0]!.kind, 'navigation-failed');
  // Экран после битого всё равно пройден: обход не обрывается на недоступном URL.
  assert.ok(findings.some((finding) => finding.targetRef === '/clean' && finding.kind === 'response-captured'));

  const degraded = findings.find((finding) => finding.targetRef === '/dashboard/:id');
  assert.equal(degraded?.kind, 'response-captured');
  assert.ok((degraded?.responseHashes.length ?? 0) >= 1, 'ответ 500 тоже должен попасть в набор эталонов');

  // Тот же экран глазами сессии: ответ 500 даёт сигнал, а проекция виджета остаётся читаемой.
  const { manager, sessionId } = await openSession('/dashboard/1?bhScenario=error500');
  try {
    const state = await manager.state(sessionId, { screen: true });
    const failed = state.signals.filter((signal) => signal.status === 500);
    // React StrictMode в dev-сборке вызывает эффекты дважды, поэтому запросов и сигналов два.
    // Фиксируем наличие и содержание сигнала, а не его количество.
    assert.ok(failed.length >= 1, `сигналы экрана: ${JSON.stringify(state.signals.map((signal) => signal.message))}`);
    for (const signal of failed) {
      assert.equal(signal.kind, 'response');
      assert.match(signal.message, /widgets\/table: HTTP 500/);
    }
    const table = summaryOf(state, 'table') as { rowCount: number } | null;
    assert.equal(table?.rowCount, 0, 'при 500 таблица пуста, но наблюдаема');
  } finally {
    await manager.close(sessionId);
  }
});

test('phase 1 detectors see behavioral bugs but not the seeded data bugs', async () => {
  // D1–D6: экран с расхождениями в данных не даёт ни сигнала, ни находки — оракула данных в фазе 1 нет.
  const dashboard = await openSession('/dashboard/1');
  try {
    const state = await dashboard.manager.state(dashboard.sessionId, { screen: true });
    assert.deepEqual(state.signals, [], 'засеянные баги данных не должны давать сигналов');
    const findings = await readFindings(sweepRunId, acceptance.stateDir);
    const dashboardFindings = findings.filter((finding) => finding.targetRef === '/dashboard/:id');
    assert.deepEqual(
      dashboardFindings.map((finding) => finding.kind),
      ['response-captured'],
      'обход не создаёт находок, указывающих на расхождения D1–D6',
    );
  } finally {
    await dashboard.manager.close(dashboard.sessionId);
  }

  // N1: необработанное исключение видно детектором как сигнал pageerror.
  const settings = await openSession('/settings');
  try {
    const state = await settings.manager.state(settings.sessionId);
    const exportButton = state.elements.find((element) =>
      element.locator.kind === 'testid' && element.locator.value === 'export-csv');
    assert.ok(exportButton, 'кнопка экспорта обязана быть в снимке');
    const acted = await settings.manager.act(settings.sessionId, { elementId: exportButton.id, action: 'click' });
    assert.equal(acted.ok, true, acted.error ?? 'клик не выполнен');
    const kinds = acted.signals.map((signal) => signal.kind);
    assert.ok(kinds.includes('pageerror'), `сигналы: ${JSON.stringify(kinds)}`);
    assert.match(JSON.stringify(acted.signals), /Cannot read properties of null/);
  } finally {
    await settings.manager.close(settings.sessionId);
  }

  // N2: гонка устаревшего ответа через ядро НЕ воспроизводится — это измеренная граница фазы 1.
  const racy = await openSession('/dashboard/1?bhScenario=latency');
  try {
    const state = await racy.manager.state(racy.sessionId);
    const filter = state.elements.find((element) =>
      element.locator.kind === 'testid' && element.locator.value === 'filter-region');
    assert.ok(filter, 'фильтр региона обязан быть в снимке');
    let signals: typeof state.signals = [];
    for (const region of ['ural', 'siberia', 'northwest']) {
      const acted = await racy.manager.act(racy.sessionId, {
        elementId: filter.id, action: 'select', value: region,
      });
      assert.equal(acted.ok, true, acted.error ?? 'select не выполнен');
      signals = [...signals, ...acted.signals];
    }
    // Баг существует (доказан на уровне фикстуры в test/bi-app.bhtest.ts), но `act` ждёт
    // успокоения сети между действиями, поэтому смена фильтра сериализуется и устаревший
    // ответ всегда приходит раньше следующего действия. Для гонок нужен режим без ожидания.
    const race = signals.find((signal) => JSON.stringify(signal).includes('RACE:'));
    assert.equal(race, undefined,
      `гонка неожиданно воспроизвелась через ядро: ${JSON.stringify(signals.map((signal) => signal.message))}`);
  } finally {
    await racy.manager.close(racy.sessionId);
  }

  // Фильтр управляется ядром: в сценарии без задержек проекция таблицы отражает выбор.
  const filtered = await openSession('/dashboard/1');
  try {
    const state = await filtered.manager.state(filtered.sessionId);
    const filter = state.elements.find((element) =>
      element.locator.kind === 'testid' && element.locator.value === 'filter-region');
    assert.ok(filter, 'фильтр региона обязан быть в снимке');
    const acted = await filtered.manager.act(filtered.sessionId, {
      elementId: filter.id, action: 'select', value: 'ural',
    });
    assert.equal(acted.ok, true, acted.error ?? 'select не выполнен');
    const after = await filtered.manager.state(filtered.sessionId, { screen: true });
    const table = summaryOf(after, 'table') as { rows: Array<{ region: string }> };
    assert.ok(table.rows.length > 0, 'после смены фильтра таблица пуста');
    assert.ok(table.rows.every((row) => row.region === 'ural'),
      `фильтр не применён: ${JSON.stringify(table.rows.map((row) => row.region))}`);
  } finally {
    await filtered.manager.close(filtered.sessionId);
  }
});

const fullSweep = process.env.BH_BI_FULL_SWEEP === '1';

/**
 * Замер стоимости детерминированного обхода. Под флагом, потому что полный проход по инвентарю
 * с чтением снимка на каждом экране — это минуты, а не секунды; в обычном прогоне тест пропускается.
 * Числа пишутся в `fixtures/bi-app/ACCEPTANCE.md`, чтобы приёмка была воспроизводимой.
 */
test('full inventory sweep measures cost per screen', { skip: !fullSweep }, async () => {
  const findings = await readFindings(sweepRunId, acceptance.stateDir);
  const responsesPerScreen = screens.map((screen) => {
    const detail = findings.find((finding) =>
      finding.targetRef === screen.template && finding.kind === 'response-captured')?.detail ?? '';
    return Number(/^Ответов: (\d+)/.exec(detail)?.[1] ?? 0);
  });

  // Срез экранов: все не-отчётные (они разные по плотности) плюс каждый двадцатый отчёт.
  // Только равномерный шаг по инвентарю дал бы почти одни экраны отчётов и скрыл плотные.
  const pathOf = (screen: ScreenEntry) => new URL(screen.sampleUrl).pathname;
  const sample = [
    ...screens.filter((screen) => !screen.template.startsWith('/report/')),
    ...screens.filter((screen, index) => screen.template.startsWith('/report/') && index % 20 === 0),
  ];
  const elementsPerScreen: number[] = [];
  const snapshotChars: number[] = [];
  const { manager, sessionId } = await openSession(pathOf(sample[0]!));
  try {
    for (const [index, screen] of sample.entries()) {
      const state = index === 0
        ? await manager.state(sessionId, { screen: true })
        : await manager.navigate(sessionId, pathOf(screen), { screen: true });
      elementsPerScreen.push(state.totalVisible);
      snapshotChars.push(JSON.stringify(state.elements).length);
    }
  } finally {
    await manager.close(sessionId);
  }

  const median = (values: number[]): number => {
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
  };
  const secondsPerScreen = sweepSeconds / screens.length;
  const crawlSeconds = (crawlFinishedAt - crawlStartedAt) / 1000;

  const report = `# Приёмка фазы 1 на фикстуре \`bi-app\`

Дата замеров: ${new Date().toISOString().slice(0, 10)}. Прогоны: \`BH_BI_FULL_SWEEP=1 node --test test/bi-app-acceptance.bhtest.ts\`.
Критерий фазы 1 — §5.5 дизайн-дока \`docs/superpowers/specs/2026-11-12-bughunter-bi-design.md\`.

## Инвентарь и стоимость детерминированного обхода

| Показатель | Значение |
| --- | --- |
| Экранов в инвентаре после \`bh_crawl\` | ${screens.length} |
| Шаблонов \`/dashboard/:id\` (120 дашбордов свёрнуты) | 1 |
| Отдельных экранов отчётов \`/report/<slug>\` | ${screens.filter((s) => s.template.startsWith('/report/')).length} |
| Время обхода инвентаря (\`bh_crawl\`) | ${crawlSeconds.toFixed(1)} с |
| Время полного \`bh_sweep\` (${sweepCalls} вызовов по 25 экранов) | ${sweepSeconds.toFixed(1)} с |
| Секунд на экран (sweep) | ${secondsPerScreen.toFixed(2)} с |
| Ответов на экран (всё, что перехватило ядро): медиана / максимум | ${median(responsesPerScreen)} / ${Math.max(...responsesPerScreen)} |
| Элементов в снимке на экран: медиана / максимум | ${median(elementsPerScreen)} / ${Math.max(...elementsPerScreen)} |
| Размер снимка (JSON элементов), символов: медиана / максимум | ${Math.round(median(snapshotChars))} / ${Math.max(...snapshotChars)} |
| Находок всего | ${findings.length} |
| Находок \`extract-failed\` / \`navigation-failed\` / \`response-missing\` | ${countKind(findings, 'extract-failed')} / ${countKind(findings, 'navigation-failed')} / ${countKind(findings, 'response-missing')} |

Замеры элементов и снимка выполнены на ${sample.length} экранах: все не-отчётные плюс каждый двадцатый отчёт.

Ответы считаются все перехваченные ядром, а не только вызовы API: в dev-сборке vite каждый модуль
приложения — отдельный ответ, поэтому числа велики. В production-сборке их на порядок меньше,
на целевом приложении показатель нужно измерить заново.

## Что фаза 1 находит на этой фикстуре

| Засеянный дефект | Находится фазой 1 | Чем |
| --- | --- | --- |
| N1 необработанное исключение на \`/settings\` | да | сигнал \`pageerror\` |
| N2 гонка устаревшего ответа | только на уровне фикстуры | через ядро не воспроизводится: \`act\` ждёт успокоения сети, смена фильтра сериализуется |
| N3 двойная отправка мастера | нет | нарушение кратности не оставляет сигнала |
| D1–D6 расхождения в данных | нет | нужен оракул данных (фаза 2); формы оракула описаны в \`SEEDED.md\` |
| L1–L4 легальные трансформации | нет (и не должно) | калибровка порога ложных срабатываний для фазы 2 |

## Критерий фазы 1: что проверено

- Обход достигает каждого экрана фикстуры, динамические сегменты свёрнуты в один шаблон.
- \`bh_sweep\` проходит весь инвентарь порциями по \`limits.screensPerSweep\`, курсор растёт,
  прерванный обход продолжается с сохранённой позиции, экраны не проходятся дважды.
- На каждом экране есть ответы приложения и проекции виджетов; сбойные находки отсутствуют.
- Снимок плотного экрана соблюдает \`limits.elementsPerSnapshot\`, отдаёт \`truncated\` и \`nextCursor\`,
  страницы покрывают весь список без пересечений.
- \`drag\`, \`clickAt\` (цель названа хуком приложения, \`konva://dashboard/1/bars/2\`) и \`scroll\`
  виртуализированного контейнера работают на реальном приложении.
- Экран с HTTP 500 и недоступный экран дают находки, обход не обрывается.
- Засеянные баги данных фазой 1 не находятся — это измеренный базовый уровень для фазы 2.
`;
  await writeFile(acceptanceReportPath, report, 'utf8');
  assert.ok(secondsPerScreen > 0);
  assert.ok(screens.length >= 127, `экранов в инвентаре: ${screens.length}`);
});

function countKind(findings: Array<{ kind: string }>, kind: string): number {
  return findings.filter((finding) => finding.kind === kind).length;
}
