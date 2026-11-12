# Фикстура `bi-app` и приёмка фазы 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Построить acceptance-фикстуру `bi-app` (React + Vite + TS + MSW + react-konva + three.js) с засеянными багами и легальными трансформациями и принять на ней фазу 1 по критерию §5.5 дизайн-дока, измерив стоимость экрана и честно зафиксировав, какие засеянные баги данных существующие детекторы не находят.

**Architecture:** Фикстура — отдельный пакет рядом с `buggy-app`, со своими `node_modules` и MSW-worker'ом; экраны делятся на 6 рукописных типов (глубина: таблица, SVG, canvas, 3D, визард с drag&drop, форма, чистый экран) и два сгенерированных семейства (`/dashboard/:id` — 120 числовых id, шаблонизируются в одну запись инвентаря; `/report/r-*` — 120 нечисловых slug'ов, дают 120 отдельных шаблонов и тем самым проверяют масштаб). Знание о приложении живёт не в ядре, а в профиле `fixtures/bi-app/bughunter-profile/index.ts`, который приёмочный тест копирует во временный `stateDir`. Приёмка — закоммиченный тест без модели плюс один короткий модельный smoke-прогон.

**Tech Stack:** TypeScript с type stripping (Node ≥22.18, без шага сборки), Vite 6, React 19, konva 10 + react-konva 19, three 0.187, msw 3, vitest 3 (внутри фикстуры), node:test (на стороне сервера), playwright-core (уже в зависимостях сервера).

**Spec:** `docs/superpowers/specs/2026-11-12-bughunter-bi-design.md` — §5.4 (фикстура), §5.5 (критерий фазы 1), пункт «Разделение приёмки» (объём сужен до фазы 1 решением автора от 2026-11-12). План аргументирует из спеки; исполнитель читает оба документа.

## Global Constraints

- Стек фикстуры совпадает с Навигатором: **React + Vite + TypeScript + MSW + react-konva + three.js**. Без совпадения стека приёмка проверит не те пути (в частности introspection Konva и headless-WebGL).
- Версии зависимостей — те, что доказаны спайком фазы 0: `react`/`react-dom` `^19.1.0`, `konva` `^10.9.1`, `react-konva` `^19.3.2`, `three` `^0.187.0`, `@types/three` `^0.187.0`, `msw` `^3.0.5`, `vite` `^6.3.0`, `@vitejs/plugin-react` `^4.5.0`, `typescript` `^5.8.0`, `vitest` `^3.1.0`, `@playwright/test` `^1.65.0`. Новых зависимостей у сервера не появляется.
- **На настоящий Навигатор BI не заходим**: в конфигах только `http://127.0.0.1:<port>`, корпоративных URL нет ни в одном файле.
- **В `server/src/**` не должно быть названий BI-библиотек** — гард `core sources do not mention BI-specific libraries` (`test/profile.bhtest.ts`) запрещает `'konva'`, `'react-konva'`, `'three'`, `'msw'`, `\bKonva\b`, `\bTHREE\b`, `navigator-bi`. Фикстура, профиль и тесты живут вне `src/`, поэтому правило не нарушают.
- Bughunter не коммитит и не меняет код приложения: фикстура изменяется только задачами этого плана, а приёмочный тест читает её и действует в браузере.
- `state/` gitignored, поэтому профиль коммитится как `fixtures/bi-app/bughunter-profile/index.ts` и копируется тестом во временный `stateDir/profiles/bi/index.ts`.
- Тесты сервера запускаются `node --test --test-concurrency=1 test/*.bhtest.ts`; новый файл `test/bi-app-acceptance.bhtest.ts` попадает в набор автоматически, поэтому его обычная ветка обязана укладываться примерно в минуту. Полнообъёмный прогон по всему инвентарю — за env-флагом `BH_BI_FULL_SWEEP=1` и с `skip` без него.
- Все прогоны под `caffeinate -i` и с `env -u PLAYWRIGHT_BROWSERS_PATH` (урок готовности: idle sleep раздувал таймауты verifier примерно в 10 раз).
- Никаких model-прогонов, пока живой модельный гейт не завершён: браузерные сьюты конкурируют за машину (Task 15: 143/146).

## Review Focus

- **Большой ответ (сценарий `big`, 5000 строк).** Тело больше 256 КБ должно уйти в артефакт `runs/<runId>/responses/<hash>.body` с флагом усечения, а не в журнал шага; экран при этом остаётся проходимым. Тест: `big scenario response body is stored as an artifact and the screen stays passable` (Task 2).
- **Сценарий `error500`.** Ответ ≥400 даёт сигнал, а `sweep` не падает и пишет находку по экрану. Тест: `sweep records a finding on a screen whose API answers 500` (Task 6).
- **WebGL в headless без GPU.** three.js-сцена не ронявает страницу; потеря контекста (`webglcontextlost`) не делает экран непроходимым. Тест: `3d scene renders in headless chrome without extra launch args` (Task 3).
- **Первая загрузка до активации MSW-worker'а.** Хук `window.__bhResponses` существует до первого `fetch`, иначе эталон первых ответов теряется. Тест: `response hook exists before the first fetch on a cold load` (Task 2).
- **Битая ссылка в инвентаре.** Экран, отвечающий 500/404, попадает в `blocked` обхода, а не исчезает молча. Тест: `crawl records a broken screen instead of dropping it` (Task 6).

---

### Task 1: Каркас фикстуры и её запуск из тестов сервера

**Files:**
- Create: `.qwen/bughunter/server/fixtures/bi-app/package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/main.tsx`, `src/app.tsx`, `src/router.ts`, `src/styles.css`, `src/seed.test.ts`, `public/.gitkeep`
- Test: `.qwen/bughunter/server/test/bi-app.bhtest.ts`

**Interfaces:**
- Consumes: прецедент запуска фикстуры из `test/reproduce.bhtest.ts:19-27` (`createServer` из `fixtures/<app>/node_modules/vite/dist/node/index.js`, `server: { host: '127.0.0.1', port: 0 }`, `vite.listen()`).
- Produces:
```ts
// test/bi-app.bhtest.ts — общий harness для Tasks 1–4
export async function startBiApp(): Promise<{ baseUrl: string; close(): Promise<void> }>;
// src/router.ts
export function currentPath(): string;                       // location.pathname
export function navigate(path: string): void;                // pushState + событие 'bi:navigate'
export function onNavigate(handler: (path: string) => void): () => void;
```

- [ ] **Step 1: Написать падающий тест**

`test/bi-app.bhtest.ts`: `startBiApp()` поднимает vite из каталога фикстуры; тест `app shell renders navigation and serves the spa fallback` открывает страницу через playwright-core (`chromium.launch({ channel: 'chrome' })`), идёт на `${baseUrl}/` и asserts: `title` содержит `Bughunter BI`, видны ссылки `Дашборды`, `Отчёты`, `Мастер`, `Настройки`, и переход по прямой ссылке `${baseUrl}/settings` не даёт 404 (SPA-fallback vite).

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `env -u PLAYWRIGHT_BROWSERS_PATH node --test test/bi-app.bhtest.ts`
Expected: FAIL — каталога фикстуры нет, `createServer` не резолвится (`ERR_MODULE_NOT_FOUND`).

- [ ] **Step 3: Создать пакет и установить зависимости**

`package.json` — версии из Global Constraints, `scripts: { dev, test }`, `type: module`. `tsconfig.json` — копия `fixtures/buggy-app/tsconfig.json`. `vite.config.ts` — только `plugins: [react()]` (API отдаёт MSW, а не vite-плагин, в отличие от `buggy-app`). Установка: `npm install --no-audit --no-fund` в фоне, лог в `.superpowers/sdd/<workspace>/bi-app-install.log`.

- [ ] **Step 4: Написать оболочку приложения**

`src/router.ts` — три функции из Produces, без внешних зависимостей. `src/app.tsx` — навигация и переключатель маршрутов по `currentPath()`. `src/main.tsx` — монтирует приложение. `index.html` — `<title>Bughunter BI</title>` и `<div id="root">`.

- [ ] **Step 5: Запустить тест и убедиться, что проходит**

Run: `env -u PLAYWRIGHT_BROWSERS_PATH node --test test/bi-app.bhtest.ts && npm run typecheck`
Expected: PASS (1 тест).

- [ ] **Step 6: Commit**

```bash
git add .qwen/bughunter/server/fixtures/bi-app .qwen/bughunter/server/test/bi-app.bhtest.ts
git commit -m "test(bi-app): scaffold the BI acceptance fixture and boot it from server tests"
```

---

### Task 2: MSW-слой, сценарии, сброс и хук эталона

**Files:**
- Create: `fixtures/bi-app/src/mocks/browser.ts`, `src/mocks/handlers.ts`, `src/mocks/seed.ts`, `src/mocks/scenarios.ts`, `public/mockServiceWorker.js`
- Modify: `fixtures/bi-app/src/main.tsx`
- Test: `test/bi-app.bhtest.ts` (добавить тесты), `fixtures/bi-app/src/seed.test.ts`

**Interfaces:**
- Consumes: `startBiApp()` (Task 1).
- Produces:
```ts
// src/mocks/seed.ts
export type Dataset = { dashboards: Dashboard[]; widgets: Record<string, WidgetPayload>; reports: ReportMeta[] };
export const SEED_VERSION = '2026-11-12.1';
export function dataset(scenario: ScenarioName): Dataset;
// src/mocks/scenarios.ts
export type ScenarioName = 'normal' | 'latency' | 'error500' | 'empty' | 'big';
export const SCENARIO_KEY = 'bhScenario';          // storage-флаг из §5.4
export const RESET_ENDPOINT = '/__bh/reset';       // служебный эндпоинт сброса
// src/mocks/browser.ts
export const worker: SetupWorkerApi;               // msw/browser, с хуком response:mocked (MSW 3)
// window.__bhResponses: Array<{ url: string; status: number; body: unknown; at: string }>
// window.__BHScenario: { current(): ScenarioName; set(name: ScenarioName): void }
```

- [ ] **Step 1: Написать падающие тесты**

В `test/bi-app.bhtest.ts`:
- `msw serves seeded datasets and records every mocked response` — на `/dashboards` `window.__bhResponses` содержит запись про `/api/dashboards` со `status: 200` и телом; `SEED_VERSION` виден в заголовке `x-bh-seed`.
- `scenario flag switches datasets and the reset endpoint restores the seed` — `window.__BHScenario.set('empty')` + reload даёт пустой список; `POST /__bh/reset` + reload возвращает нормальный.
- `response hook exists before the first fetch on a cold load` — `addInitScript`-независимая проверка: в свежем контексте первое же чтение `window.__bhResponses` после `goto` возвращает массив, а не `undefined` (Review Focus, пункт 4).
- `big scenario response body is stored as an artifact and the screen stays passable` — сценарий `big` отдаёт ≥5000 строк; ответ перехвачен, `document.title` не содержит аномалий из `detectors.anomalyTexts` (Review Focus, пункт 1).

В `fixtures/bi-app/src/seed.test.ts` (vitest внутри фикстуры): `dataset('normal')` детерминирован между вызовами; `dataset('big').widgets.table.rows.length >= 5000`; `dataset('empty')` не содержит строк.

- [ ] **Step 2: Запустить и убедиться, что падают**

Run: `env -u PLAYWRIGHT_BROWSERS_PATH node --test test/bi-app.bhtest.ts`
Expected: FAIL — `window.__bhResponses` undefined, эндпоинты MSW отдают 404.

- [ ] **Step 3: Реализовать слой моков**

`mockServiceWorker.js` — `npx msw init public/ --save` из каталога фикстуры. `handlers.ts` — REST-обработчики `/api/dashboards`, `/api/dashboards/:id`, `/api/dashboards/:id/widgets/:widget`, `/api/reports`, `/api/reports/:slug`, `/api/wizard/save`, `POST /__bh/reset`. Сценарий читается из `localStorage[SCENARIO_KEY]`; `latency` добавляет `await delay(800)`, `error500` отвечает 500 на `/api/dashboards/1/widgets/table`. Хук эталона — `worker.events.on('response:mocked', …)` (в MSW 3.0.5 событие переименовано относительно MSW 2) дописывает в `window.__bhResponses` и регистрируется **до** `worker.start()`, чтобы первый ответ не потерялся.

- [ ] **Step 4: Запустить тесты**

Run: `env -u PLAYWRIGHT_BROWSERS_PATH node --test test/bi-app.bhtest.ts && cd fixtures/bi-app && npx vitest run src/seed.test.ts`
Expected: PASS (4 + 3 теста).

- [ ] **Step 5: Commit**

```bash
git add .qwen/bughunter/server/fixtures/bi-app .qwen/bughunter/server/test/bi-app.bhtest.ts
git commit -m "test(bi-app): add MSW seeds, scenarios, reset endpoint and the response hook"
```

---

### Task 3: Экраны, виджеты и тестовые крючки приложения

**Files:**
- Create: `fixtures/bi-app/src/screens/{home,dashboards,dashboard,reports,report,wizard,settings,clean}.tsx`, `src/widgets/{table-widget,line-chart,bar-canvas,scene3d}.tsx`, `src/bh-profile.ts`
- Modify: `fixtures/bi-app/src/app.tsx`
- Test: `test/bi-app.bhtest.ts`, `fixtures/bi-app/src/seed.test.ts`

**Interfaces:**
- Consumes: `dataset()` (Task 2), `navigate()`/`onNavigate()` (Task 1).
- Produces:
```ts
// src/bh-profile.ts — единственный контракт приложения с профилем Bughunter
declare global { interface Window { __BHProfile: BhProfileHook } }
export type BhProfileHook = {
  version: string;
  widgets(): Array<{ widget: string; kind: 'table' | 'chart' | 'scene' | 'dom'; node: string }>;
  extract(widget: string): unknown;                       // проекция виджета как JSON
  resolvePoint(point: { x: number; y: number }): { locator: string; text: string; role?: string } | null;
  sceneInfo(): { objects: number; layers: string[] } | null;   // three.js scene graph
};
```
Маршруты и их `data-testid`: `/` (`nav-*`), `/dashboards` (`dashboard-link-<id>`, `pager-*`), `/dashboard/:id` (`widget-table`, `widget-line`, `widget-bars`, `widget-scene`, `filter-region`), `/reports` (`report-link-<slug>`, `pager-*`), `/report/:slug` (`report-title`), `/wizard` (`field-<name>`, `shelf`, `wizard-step`, `wizard-save`), `/settings` (`settings-form`, `export-csv`), `/clean` (`clean-marker`).

- [ ] **Step 1: Написать падающие тесты**

В `test/bi-app.bhtest.ts`:
- `every screen renders its widgets and exposes them through __BHProfile` — обход всех 8 маршрутов: на `/dashboard/1` `__BHProfile.widgets()` возвращает 4 записи (`table`, `line`, `bars`, `scene`), `extract('table')` даёт `{ rows, total }`, `extract('bars')` — массив столбцов, прочитанный из графа сцены, а не из DOM.
- `konva bar is reachable by coordinates through the profile hook` — `__BHProfile.resolvePoint({x,y})` в центре третьего столбца возвращает `{ locator: 'konva://dashboard/1/bars/2', text: 'Март' }`; в точке вне canvas — `null`.
- `3d scene renders in headless chrome without extra launch args` — `__BHProfile.sceneInfo()` возвращает `{ objects: >0, layers: [...] }`, `pageerror`-сигналов нет (Review Focus, пункт 3).
- `dashboard ids template into one inventory entry while report slugs stay distinct` — `/dashboards` содержит 120 ссылок `/dashboard/<number>`, `/reports` — 120 ссылок `/report/r-<slug>` по 10 на страницу.
- `wizard moves a field onto the shelf by drag and drop` — после `dragTo` полка содержит поле, `wizard-step` меняется.

- [ ] **Step 2: Запустить и убедиться, что падают**

Run: `env -u PLAYWRIGHT_BROWSERS_PATH node --test test/bi-app.bhtest.ts`
Expected: FAIL — маршруты отдают оболочку без экранов, `window.__BHProfile` undefined.

- [ ] **Step 3: Реализовать экраны и виджеты**

Таблица — обычный DOM с `data-testid`. Линейный график — inline-SVG. Столбчатый — `react-konva` (`Stage`/`Layer`/`Rect`), координаты столбцов считает сам компонент и публикует их в `__BHProfile.resolvePoint` через `Konva.stages`. 3D — `three` (`WebGLRenderer` + 3 `Mesh`), `sceneInfo()` обходит `scene.children`. Визард — три шага, перетаскивание на HTML5 drag events. Генерируемые семейства — из `dataset()`, не хардкодом.

- [ ] **Step 4: Запустить тесты**

Run: `env -u PLAYWRIGHT_BROWSERS_PATH node --test test/bi-app.bhtest.ts && npm run typecheck`
Expected: PASS (5 новых тестов + предыдущие).

- [ ] **Step 5: Commit**

```bash
git add .qwen/bughunter/server/fixtures/bi-app .qwen/bughunter/server/test/bi-app.bhtest.ts
git commit -m "test(bi-app): add BI screens with DOM, SVG, canvas and 3D widgets plus introspection hooks"
```

---

### Task 4: Засеянные баги, легальные трансформации и манифест

**Files:**
- Create: `fixtures/bi-app/SEEDED.md`, `fixtures/bi-app/src/mocks/bugs.ts`
- Modify: `fixtures/bi-app/src/mocks/seed.ts`, виджеты из Task 3 (только отображение seeded-значений)
- Test: `fixtures/bi-app/src/seed.test.ts`, `test/bi-app.bhtest.ts`

**Interfaces:**
- Consumes: `dataset()` (Task 2), `__BHProfile.extract` (Task 3).
- Produces:
```ts
// src/mocks/bugs.ts
export type SeededId = 'D1'|'D2'|'D3'|'D4'|'D5'|'D6'|'L1'|'L2'|'L3'|'L4'|'N1'|'N2'|'N3';
export const SEEDED: Record<SeededId, { kind: 'data' | 'legal' | 'behavior'; screen: string; widget?: string;
  expected: string; actual: string }>;
```
Содержимое (ровно то, что проверяют тесты и что попадает в `SEEDED.md`):
- `D1` итог не равен сумме строк: строки `1200.50 + 800.25 + 399.25 = 2400.00`, `total: 2410.00`.
- `D2` округление не в ту сторону: `1234.565` → `1234.56` вместо `1234.57` (KPI-плитка).
- `D3` сдвиг часового пояса: `2026-03-01T00:00:00Z` → `28.02.2026`.
- `D4` фильтр применён к одному виджету: `?region=ural` уходит в запрос таблицы и не уходит в запрос линейного графика.
- `D5` дубль строки на второй странице: `/api/dashboards?page=2` повторяет `id: 7`.
- `D6` доля от неверной базы: `37%` вместо `52%` (знаменатель — все строки вместо отфильтрованных).
- `L1` сокращение `1.2K` для `1234` — легально.
- `L2` локальный формат `1 234,57` для `1234.5678` — легально.
- `L3` дата в локальной зоне `01.03.2026` для `2026-03-01T09:00:00+03:00` — легально.
- `L4` итог, округлённый до копеек: `2400.00` из `2400.004` — легально.
- `N1` необработанное исключение: клик `export-csv` бросает `TypeError` (сигнал `pageerror`).
- `N2` гонка при быстрой смене фильтра: устаревший ответ перерисовывает виджет поверх нового (сигнал `console.error`).
- `N3` двойная отправка: `wizard-save` не блокируется, два клика дают два `POST /api/wizard/save` (сигнала нет — только проверка кратности).

- [ ] **Step 1: Написать падающие тесты**

`fixtures/bi-app/src/seed.test.ts`: `SEEDED` содержит 6 записей `kind: 'data'`, 4 `kind: 'legal'`, 3 `kind: 'behavior'`; для каждого `data`-бага `dataset('normal')` действительно содержит расхождение из поля `actual` (например `total !== сумма rows`); для каждой `legal`-записи трансформация арифметически верна (`1234 → '1.2K'`, `1234.5678 → '1 234,57'`).

`test/bi-app.bhtest.ts`:
- `every seeded data bug is observable through the widget projection` — для `D1`–`D6` значение из `__BHProfile.extract(widget)` совпадает с `actual` из манифеста.
- `behavioral bugs fire the signals the detectors can see` — `N1` даёт `pageerror`, `N2` даёт `console.error`, а `N3` **не даёт ни одного сигнала** (это и есть честная граница существующих детекторов).
- `legal transformations produce no anomaly text` — на экранах с `L1`–`L4` `scanSignals` не находит ни одной аномалии из `detectors.anomalyTexts`.

- [ ] **Step 2: Запустить и убедиться, что падают**

Run: `cd fixtures/bi-app && npx vitest run src/seed.test.ts` и `env -u PLAYWRIGHT_BROWSERS_PATH node --test test/bi-app.bhtest.ts`
Expected: FAIL — `SEEDED` не определён, расхождений в данных нет.

- [ ] **Step 3: Реализовать засеянные расхождения и манифест**

`bugs.ts` — реестр `SEEDED` и чистые функции трансформаций; `seed.ts` применяет их к датасету так, чтобы баг жил в данных, а не в рендере (иначе оракул фазы 2 его не увидит). `SEEDED.md` — таблица `id | класс | экран | виджет | ожидалось | получено | чем обнаружим сегодня` со строкой «ничем, нужен оракул данных» для `D1`–`D6`.

- [ ] **Step 4: Запустить тесты**

Run: `cd fixtures/bi-app && npx vitest run && cd ../../.. && env -u PLAYWRIGHT_BROWSERS_PATH node --test test/bi-app.bhtest.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .qwen/bughunter/server/fixtures/bi-app .qwen/bughunter/server/test/bi-app.bhtest.ts
git commit -m "test(bi-app): seed data bugs, legal transforms and behavioral bugs with a manifest"
```

---

### Task 5: Профиль приложения `bi`

**Files:**
- Create: `fixtures/bi-app/bughunter-profile/index.ts`
- Test: `test/bi-app-acceptance.bhtest.ts` (новый файл, в этой задаче — только загрузка профиля)

**Interfaces:**
- Consumes: `loadProfile`/`loadActiveProfile` из `src/profile/load.ts`, `BhProfileHook` (Task 3).
- Produces:
```ts
// fixtures/bi-app/bughunter-profile/index.ts — default-экспорт, валидный Profile
// extractors: table (kind 'table'), line (kind 'chart'), bars (kind 'chart'), scene (kind 'scene')
//   каждый script делегирует в window.__BHProfile.extract(<widget>)
// oracles: привязка '/api/dashboards/:id/widgets/table' → widget 'table', fields ['rows', 'total']
// navigation.idSegmentPattern: '^\\d+$|^[0-9a-f]{8,}$'
// reset: { kind: 'storage-flag', key: 'bhScenario' }
// interactions.resolvePoint: '(point) => window.__BHProfile.resolvePoint(point)'
// responseSource: 'playwright'
```
```ts
// test/bi-app-acceptance.bhtest.ts — harness для Tasks 5–6
export async function biAcceptanceContext(): Promise<{
  baseUrl: string; stateDir: string; config: Config; close(): Promise<void>;
}>;   // поднимает фикстуру, создаёт временный stateDir, копирует профиль в profiles/bi/index.ts,
      // пишет config.json с baseUrl/allowedOrigins фикстуры и limits.responseSettleMs: 400
```

- [ ] **Step 1: Написать падающий тест**

`test/bi-app-acceptance.bhtest.ts`, тест `profile for the fixture loads and passes the schema`: `biAcceptanceContext()` → `loadProfile(stateDir, 'bi')` возвращает профиль с 4 экстракторами, `reset.kind === 'storage-flag'`, `navigation.idSegmentPattern` сворачивает `/dashboard/12` в `/dashboard/:id` через `templatisedPathname`; `loadActiveProfile(stateDir)` возвращает тот же профиль по `config.profile === 'bi'`.

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `env -u PLAYWRIGHT_BROWSERS_PATH node --test test/bi-app-acceptance.bhtest.ts`
Expected: FAIL — `PROFILE_NOT_FOUND: bi`.

- [ ] **Step 3: Написать профиль и harness**

Профиль — TS-модуль с `export default`, без импортов (он исполняется загрузчиком профиля). Скрипты экстракторов — строки, делегирующие в `window.__BHProfile.extract`. Harness копирует каталог профиля в `<stateDir>/profiles/bi/` и пишет `config.json` (только `127.0.0.1`, `limits.responseSettleMs: 400`, `limits.screensPerSweep: 25`).

- [ ] **Step 4: Запустить тест**

Run: `env -u PLAYWRIGHT_BROWSERS_PATH node --test test/bi-app-acceptance.bhtest.ts && npm run typecheck`
Expected: PASS (1 тест).

- [ ] **Step 5: Commit**

```bash
git add .qwen/bughunter/server/fixtures/bi-app/bughunter-profile .qwen/bughunter/server/test/bi-app-acceptance.bhtest.ts
git commit -m "test(bi-app): add the application profile that delegates to fixture introspection hooks"
```

---

### Task 6: Приёмка фазы 1 на `bi-app`

**Files:**
- Modify: `test/bi-app-acceptance.bhtest.ts`
- Create: `.qwen/bughunter/server/fixtures/bi-app/ACCEPTANCE.md` (шаблон отчёта с местами под числа)

**Interfaces:**
- Consumes: `biAcceptanceContext()` (Task 5), `crawlScreens`/`readScreens` (Task 7 фазы 1), `runSweep`/`readFindings` (Task 8 фазы 1), `SessionManager.state/act` (Tasks 4–5 фазы 1).
- Produces: `test/bi-app-acceptance.bhtest.ts` — 6 приёмочных тестов; `fixtures/bi-app/ACCEPTANCE.md` — таблица замеров.

- [ ] **Step 1: Написать падающие тесты** (по одному на пункт критерия §5.5)

- `crawl reaches every screen of the fixture` — `crawlScreens({ startPaths: ['/'], maxDepth: 4, maxScreens: 400 })` даёт инвентарь, в котором есть `/`, `/dashboards`, `/dashboard/:id`, `/reports`, `/report/r-a01` … (120 отдельных шаблонов отчётов), `/wizard`, `/settings`, `/clean`; всего ≥128 записей; `/dashboard/:id` ровно один.
- `sweep visits every inventoried screen and resumes from its cursor` — серия `runSweep({ limit: 25 })` до `done: true`; объединение `visited` равно инвентарю без повторов; после каждого вызова `runs/<runId>/sweep.json` содержит растущий `cursor`; прерывание имитируется просто невызовом следующего шага.
- `sweep sees responses and projections on every screen` — для каждого экрана есть находка `response-captured` с ≥1 хэшем либо явная находка (`extract-failed`, `navigation-failed`, `response-missing`); на `/dashboard/1` структура экрана содержит 4 виджета без `error`.
- `snapshot of a dense dashboard stays under the cap and paginates` — на `/dashboard/1` `state()` возвращает ≤ `limits.elementsPerSnapshot` элементов при `totalVisible` больше лимита, `truncated: true`, `nextCursor`; объединение страниц равно полному списку.
- `drag and coordinate actions work on the fixture` — `drag` поля на полку в `/wizard` меняет состояние приложения; `clickAt` в центре третьего столбца canvas даёт `resolvedLocator === 'konva://dashboard/1/bars/2'` и тултип в DOM; `scroll` контейнера виртуализированной таблицы (сценарий `big`) меняет видимый набор строк.
- `sweep records a finding on a screen whose API answers 500` и `crawl records a broken screen instead of dropping it` — сценарий `error500` (Review Focus, пункт 2) и маршрут, отвечающий 500 (пункт 5).
- `seeded data bugs are not detected by phase 1 detectors` — честный базовый уровень: на `/dashboard/1` с `D1`–`D6` `scanSignals` не даёт сигналов, а обход не создаёт находок, указывающих на эти расхождения; `N1` и `N2` при этом находятся существующими детекторами.

- [ ] **Step 2: Запустить и убедиться, что падают**

Run: `env -u PLAYWRIGHT_BROWSERS_PATH node --test test/bi-app-acceptance.bhtest.ts`
Expected: FAIL — инвентарь пуст (`crawlScreens` ещё не запускался на этой фикстуре), часть утверждений про снимок и действия не проходит.

- [ ] **Step 3: Реализовать недостоющее**

Ожидается, что ломаться будет не фикстура, а стыки: `crawl` не находит ссылки внутри пагинированного индекса (нужен обход страниц пагинации), `resolvePoint`-хук профиля возвращает `null` из-за порядка аргументов, снимок дашборда не влезает в лимит из-за декоративных узлов. Править ядро только там, где тест показывает дефект ядра; каждое такое исправление — отдельный RED→GREEN с записью в ledger.

- [ ] **Step 4: Запустить тесты и зафиксировать замеры**

Run: `caffeinate -i env -u PLAYWRIGHT_BROWSERS_PATH BH_BI_FULL_SWEEP=1 node --test test/bi-app-acceptance.bhtest.ts`
Expected: PASS (7 тестов); тест `full inventory sweep measures cost per screen` под флагом пишет в `fixtures/bi-app/ACCEPTANCE.md` фактические числа: экранов в инвентаре, секунд на экран, элементов на экран (медиана и максимум), ответов на экран, размер снимка в символах JSON.

- [ ] **Step 5: Commit**

```bash
git add .qwen/bughunter/server/test/bi-app-acceptance.bhtest.ts .qwen/bughunter/server/fixtures/bi-app/ACCEPTANCE.md
git add .qwen/bughunter/server/src   # если Step 3 потребовал правок ядра
git commit -m "test(bi-app): accept phase 1 on the BI fixture and measure cost per screen"
```

---

### Task 7: Модельный smoke-прогон, отчёт и документация

**Files:**
- Create: `docs/superpowers/reports/2026-11-12-bi-app-phase1-acceptance.md`, `.superpowers/sdd/<workspace>/bi-smoke.sh`
- Modify: `.qwen/bughunter/README.md` (§5 профиль `bi` как пример, §10 запуск фикстур, §12 что фаза 1 принята на `bi-app`, а баги данных — нет)

**Interfaces:**
- Consumes: `ACCEPTANCE.md` (Task 6), `SEEDED.md` (Task 4), одноразовая копия фикстуры по образцу `.superpowers/sdd/northern-plain-gannet/full-gate.sh`.

- [ ] **Step 1: Собрать одноразовую копию и поднять демо**

Копия `bughunter-gate/bi-smoke/project` (вне `.qwen/`, gitignored): фикстура + `.qwen` без `state/runs`, `.mcp.json`, allow-list в `.qwen/settings.json` копии, `npm ci`, vite на свободном порту, `config.json` с `profile: 'bi'` и маршрутом `/dashboard/1`.

- [ ] **Step 2: Прогнать модельный smoke-тест**

Run: `caffeinate -i qwen -p '/bughunter route /dashboard/1' --output-format stream-json --no-session-persistence --allowed-mcp-server-names bughunter`
Expected: run `finished`, 0 батчей (чередование `bh_explore_next` → один `Agent(bh-explorer)`), исследователь реально применил хотя бы одно координатное действие или `drag` и прочитал структуру экрана.

- [ ] **Step 3: Независимо перепроверить вердикты**

`npx playwright test e2e/bughunter --workers=1` и vitest в копии — своим запуском, не со слов модели; результат в отчёт.

- [ ] **Step 4: Написать отчёт**

`docs/superpowers/reports/2026-11-12-bi-app-phase1-acceptance.md`: таблица замеров из `ACCEPTANCE.md`; таблица по `SEEDED.md` — что найдено и чем, что не найдено и почему; результаты smoke-прогона (runId, число сообщений, батчи, кандидаты); явный раздел «Что фаза 1 не даёт» со ссылкой на пункт «Разделение приёмки» в дизайн-доке.

- [ ] **Step 5: Обновить README и закоммитить**

```bash
git add docs/superpowers/reports/2026-11-12-bi-app-phase1-acceptance.md .qwen/bughunter/README.md
git commit -m "docs(bi-app): record phase 1 acceptance on the BI fixture and the measured baseline"
```

---

## Self-Review (выполнено автором плана)

**Покрытие спеки.** §5.4 стек → Global Constraints + Task 1; экраны (список дашбордов с пагинацией, дашборд с 4 виджетами, визард с drag&drop, настройки, чистый экран) → Task 3; MSW (версионируемые seed-датасеты, 5 сценариев, storage-флаг + reload, служебный эндпоинт сброса, хук `response:mock`) → Task 2; засеянные баги данных 5–7 → Task 4 (`D1`–`D6`, шесть); легальные трансформации 3–4 → Task 4 (`L1`–`L4`); баги не про данные 2–3 → Task 4 (`N1`–`N3`); тестовые крючки (`window.__BHProfile`, доступ к Konva stage и three.js scene, стабильные `data-testid`) → Task 3; критерий приёмки X/Y → **не покрывается этим планом намеренно** и остаётся фазой 2 (пункт «Разделение приёмки» в дизайн-доке). Критерий фазы 1 из §5.5 → Task 6, по одному тесту на каждый пункт. Пробелов в пределах выбранного объёма нет.

**Сквозные типы.** `startBiApp()` (Task 1) используется в Tasks 2–4; `dataset`/`SCENARIO_KEY`/`RESET_ENDPOINT` (Task 2) — в Tasks 3–4; `BhProfileHook` (Task 3) — в Tasks 4–5; `SEEDED`/`SeededId` (Task 4) — в Task 6; `biAcceptanceContext()` (Task 5) — в Task 6. Имена совпадают в Interfaces и в шагах; `SEED_VERSION` объявлен в Task 2 и не переопределяется.

**Review Focus.** Все пять пунктов привязаны к тестам в владеющих задачах: большой ответ → Task 2 Step 1; `error500` → Task 6 Step 1; headless-WebGL → Task 3 Step 1; холодная загрузка до активации worker'а → Task 2 Step 1; битая ссылка → Task 6 Step 1.

**Пропорция.** План описывает решения (пути, имена, сигнатуры, конкретные числа засеянных багов, точные утверждения тестов), а не тела компонентов: рендер виджетов, обработчики MSW и содержимое скриптов экстракторов исполнитель пишет сам. Объём плана соизмерим с объёмом спеки по этой фикстуре (§5.4 — 17 строк плотных требований, которые нужно развернуть в проверяемые утверждения).
