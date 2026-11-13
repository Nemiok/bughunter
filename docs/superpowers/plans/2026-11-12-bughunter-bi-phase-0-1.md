# Bughunter BI: фазы 0–1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сделать ядро Bughunter пригодным для тяжёлых BI-приложений: слой профиля, захват тел ответов API (включая MSW/service worker), расширенный набор действий, ограниченный и ранжированный снимок экрана, настраиваемый запуск Chrome, обнаружение маршрутов и детерминированный `sweep` с чекпоинтами.

**Architecture:** Ядро (`server/src/**`) остаётся общим и ничего не знает о BI; всё прикладное живёт в профиле — TS-модуле, типизированном контрактом ядра. Сверка данных (оракулы) — фаза 2, поэтому `sweep` в этой фазе только доходит до экрана, извлекает проекцию и фиксирует ответы, не сравнивая их. Единица обхода — экран из инвентаря `screens.json`, а не маршрут из `config.routes`.

**Tech Stack:** Node ≥ 22.18 (type stripping, без сборки), TypeScript ESM со стираемым синтаксисом, `@modelcontextprotocol/sdk`, `playwright-core`, `zod`, `node:test`; Chrome через `channel: 'chrome'`.

**Spec:** `docs/superpowers/specs/2026-11-12-bughunter-bi-design.md` (утверждён автором 2026-11-12). План аргументирует от спеки; при расхождении приоритет у спеки.

**Область этого плана:** фаза 0 (спайки) и фаза 1 спеки. Фаза 2 (оракулы данных, областные подавления, отчёт с precision-метриками, экспорт data-теста, полная фикстура `bi-app`) и фаза 3 (сценарии, приоритизация, параллелизм, CI) — отдельные планы: каждый должен давать работающий проверяемый софт сам по себе.

## Global Constraints

- Node ≥ 22.18; только стираемый TypeScript: без `enum`, `namespace`, parameter properties; импорты с расширением `.ts`; `tsconfig.json`: `erasableSyntaxOnly`, `verbatimModuleSyntax`, `allowImportingTsExtensions`, `noEmit`.
- Зависимости сервера не расширяются без необходимости: сегодня это `@modelcontextprotocol/sdk`, `playwright-core`, `zod`.
- Браузер — только установленный Google Chrome через `channel: 'chrome'`; никаких скачиваний браузера.
- Тесты сервера: `test/*.bhtest.ts` на `node:test`; запуск `npm test` = `node --test --test-concurrency=1 test/*.bhtest.ts`; перед прогоном `env -u PLAYWRIGHT_BROWSERS_PATH` и `caffeinate -i` (иначе таймауты verifier растягиваются в десятки раз при idle-sleep).
- В `server/src/**` запрещены упоминания `konva`, `three`, `msw`, `navigator-bi` — проверяется тестом (анти-цель «BI-специфика в ядре»).
- Любая правка промптов (`.qwen/agents/*.md`, `.qwen/skills/*/SKILL.md`) сопровождается синхронной правкой контракт-теста `test/prompts.bhtest.ts`; имена встроенных инструментов Qwen CLI — PascalCase.
- `config.json` — строгая zod-схема (`strictObject`): неизвестные поля отклоняются, поэтому каждое новое поле добавляется в схему и в документацию README §5.
- Исходная демо-фикстура `fixtures/buggy-app` не изменяется: её хеши контролируются существующим тестом.
- `state/runs/`, `state/auth/`, `bughunter-gate/` не коммитятся.

## Review Focus

Входные классы и отказы, которые спека подразумевает, но которые легко пропустить; каждый закреплён тестом в задаче-владельце.

1. **Ответ, обслуженный service worker (MSW), не виден page-слушателю.** Разумное ожидание: захват на уровне `BrowserContext`, а если и он не видит — явная ошибка `RESPONSE_SOURCE_UNAVAILABLE` в журнале, а не тихий пропуск (иначе оракул фазы 2 молча деградирует). Тест: Task 3, `network capture sees service-worker-served responses or reports RESPONSE_SOURCE_UNAVAILABLE`.
2. **Тело ответа огромно (мегабайты JSON, бинарь).** Ожидание: усечение с флагом `truncated`, полный текст отдельным артефактом, журнал не раздувается. Тест: Task 3, `oversized response body is truncated, hashed and stored as an artifact`.
3. **Координатное действие попадает на запрещённый элемент** (например «Удалить» под точкой клика). Ожидание: отклонение `FORBIDDEN_ACTION`, а не выполнение; в `readOnly` — также блокировка отправки формы. Тест: Task 4, `coordinate actions resolve a semantic target before forbidden and readOnly guards`.
4. **Экран с сотнями интерактивных элементов.** Ожидание: снимок ограничен, порядок детерминирован, курсорная пагинация без повторов и пропусков. Тест: Task 5, `snapshot is ranked, capped and paginated without duplicates or gaps`.
5. **Динамические маршруты** (`/dashboard/5f2c…`, `/report/123`). Ожидание: шаблонизация в `/dashboard/:id`, инвентарь не взрывается, повторный crawl инкрементален. Тест: Task 7, `crawl templates dynamic segments and is incremental`.
6. **Прерванный `sweep` на середине инвентаря.** Ожидание: продолжение с курсора, посещённые экраны не перепроходятся, `bh_finish_run` не требует `routeStages` по всем `routes`. Тест: Task 8, `interrupted sweep resumes from its cursor and finishRun accepts sweep scope`.

---

## File Structure

**Новые файлы**

| Файл | Ответственность |
| --- | --- |
| `server/src/profile/types.ts` | Контракт профиля: типы экстракторов, привязок оракулов, контракта полей, рецепта сброса, правил навигации, тестовых данных |
| `server/src/profile/load.ts` | Загрузка и валидация профиля из `state/profiles/<name>/index.ts`; ошибки `PROFILE_NOT_FOUND`, `PROFILE_INVALID` |
| `server/src/browser/network.ts` | Контекстный захват ответов: слушатели на `BrowserContext`, чтение тел, лимит, хэш, артефакты, очередь на шаг журнала |
| `server/src/browser/point.ts` | Разрешение координаты в семантическую цель (`document.elementFromPoint` + хук профиля) для guard'ов и журнала |
| `server/src/discovery/screens-store.ts` | Чтение/запись/слияние инвентаря `state/screens.json` |
| `server/src/discovery/crawl.ts` | Обход ссылок и клиентских переходов, шаблонизация, инкрементальное пополнение инвентаря |
| `server/src/sweep.ts` | Детерминированный обход экрана: `reset → navigate → extract → capture`; курсор и чекпоинты; находки `finding` |
| `server/test/profile.bhtest.ts` | Контракт и загрузка профиля, запрет BI-специфики в ядре |
| `server/test/network.bhtest.ts` | Захват ответов, лимит тел, артефакты, SW-ветка |
| `server/test/actions.bhtest.ts` | Новые действия, guard'ы для координат, журнал и воспроизведение новых шагов |
| `server/test/snapshot.bhtest.ts` | Ранжирование, лимит, курсор, структура экрана |
| `server/test/discovery.bhtest.ts` | Шаблонизация, инкрементальность, инвентарь |
| `server/test/sweep.bhtest.ts` | Обход, чекпоинты, находки, взаимодействие со стадиями и `finishRun` |
| `server/fixtures/bi-spike/` | Одноразовая песочница фазы 0 (Vite+React+MSW+react-konva+three); не acceptance-фикстура, после фазы 0 остаётся только как источник проверенных команд |

**Изменяемые файлы**

| Файл | Что меняется |
| --- | --- |
| `server/src/types.ts` | Расширение `Step`/`ActInput` новыми действиями; `Config.browser`, `Config.limits.elementsPerSnapshot`, `Config.profile`; тип `Finding` |
| `server/src/config.ts` | Новые поля строгой схемы с дефолтами |
| `server/src/browser/session.ts` | Слушатели сети на контексте, вызов `network.ts`, новые действия, guard'ы через `point.ts`, `settle()` с ожиданием привязанного ответа |
| `server/src/browser/elements.ts` | Ранжирование, лимит, курсор, блок «структура экрана» |
| `server/src/index.ts` | Инструменты `bh_crawl`, `bh_sweep`, расширение `bh_state` курсором, маппинг новых ошибок |
| `server/src/run-store.ts` | Области `screen`/`sweep`, статусы sweep-прогона, учёт области в `finishRun` |
| `server/src/reproduce.ts` | Повтор шагов новых видов (drag/scroll/координаты/upload) |
| `server/src/export/playwright.ts` | Генерация новых видов шагов |
| `.qwen/agents/bh-explorer.md`, `.qwen/skills/bughunter/SKILL.md`, `.qwen/skills/bughunter-oracles/SKILL.md` | Структура экрана, новые действия, области `screen`/`sweep` |
| `server/test/prompts.bhtest.ts` | Контракты новых формулировок |
| `.qwen/bughunter/README.md` | §5 новые поля конфига, §6 новые области, §12 новые ограничения |

---

### Task 1: Спайки фазы 0

Спайки — выбрасываемый код без тестов (правило brainstorming): их результат — письменные ответы и правило ветвления для Task 3 и Task 5. Песочница `/tmp/bh-bi-spike` (вне репозитория); если нужна воспроизводимость, копия лежит в `server/fixtures/bi-spike/` и в тесты не включается.

**Files:**
- Create: `/tmp/bh-bi-spike/{index.html,vite.config.ts,src/main.tsx,src/App.tsx,src/mocks/{browser.ts,handlers.ts},public/mockServiceWorker.js}`
- Create: `/tmp/bh-bi-spike/spike.mjs` (Playwright-скрипт проверок)
- Create: `docs/superpowers/specs/2026-11-12-bi-phase0-spike-results.md` (ответы)

**Interfaces:**
- Produces: четыре ответа `S1..S4` и два правила ветвления, на которые ссылаются Task 3 и Task 5:
  - `S1` — видны ли ответы MSW слушателям `context.on('response')` и читаются ли тела (`response.body()`);
  - `S2` — как читается граф Konva: `window.Konva.stages`, контейнер `.konvajs-content` + React fiber, или нужен app-крючок;
  - `S3` — рендерится ли WebGL в headless Chrome и какие launch args обязательны;
  - `S4` — какой сброс сценария MSW надёжен: storage-флаг + reload или служебный эндпоинт мока.

- [ ] **Step 1: Собрать песочницу**

Минимальное приложение: одна страница с DOM-таблицей, SVG-линейным графиком, Konva-столбчатым графиком и three.js-сценой; данные — из MSW (`GET /api/widgets`); сценарии переключаются флагом `localStorage['bhScenario']` и эндпоинтом `POST /__mocks/reset`.

- [ ] **Step 2: Проверить S1 (сеть через SW)**

Run: `cd /tmp/bh-bi-spike && node spike.mjs --check responses`
Скрипт: поднять Chromium (`channel: 'chrome'`), зарегистрировать `context.on('response')` и `context.on('request')`, открыть страницу, дождаться `GET /api/widgets`, попробовать `await response.body()`, напечатать `{ seenByContext, seenByPage, bodyReadable, bytes }`.
Expected: JSON с четырьмя полями; значение `seenByContext` фиксирует ветку Task 3.

- [ ] **Step 3: Проверить S2 (Konva)**

Run: `node spike.mjs --check konva`
Expected: печатает, каким из трёх способов прочитан граф (`Konva.stages` / `.konvajs-content` + fiber / app-hook) и JSON-размер графа для лимита усечения.

- [ ] **Step 4: Проверить S3 (WebGL headless)**

Run: `node spike.mjs --check webgl` и тот же запуск с `--use-gl=swiftshader --enable-unsafe-swiftshader`
Expected: для каждого варианта `{ contextCreated, renderer, sceneObjects }`; если без args `contextCreated === false`, аргументы становятся обязательными в Task 6.

- [ ] **Step 5: Проверить S4 (сброс сценария)**

Run: `node spike.mjs --check reset`
Expected: после каждого из двух механизмов состояние данных возвращается к seed (сравнение ответа API и отрисованных строк), и ни один механизм не меняет `location.pathname`.

- [ ] **Step 6: Записать ответы и правила ветвления**

Create `docs/superpowers/specs/2026-11-12-bi-phase0-spike-results.md`: по каждому пункту — команда, фактический вывод, решение. Правила:
- если `S1.seenByContext && S1.bodyReadable` → Task 3 использует контекстные слушатели; иначе Task 3 добавляет источник `profile.responseSource = 'msw-hook'` и читает `window.__bhResponses`;
- если `S3.contextCreated === false` без аргументов → Task 6 добавляет эти аргументы в дефолты профиля запуска.

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/specs/2026-11-12-bi-phase0-spike-results.md
git commit -m "docs: record BI phase 0 spike results and branching rules"
```

---

### Task 2: Контракт профиля и его загрузка

**Files:**
- Create: `server/src/profile/types.ts`, `server/src/profile/load.ts`
- Modify: `server/src/types.ts` (поле `profile` в `Config`), `server/src/config.ts`
- Test: `server/test/profile.bhtest.ts`

**Interfaces:**
- Produces:
```ts
export type ExtractorKind = 'table' | 'chart' | 'scene' | 'dom';
export type ProfileExtractor = { name: string; widget: string; kind: ExtractorKind; script: string };
export type OracleBinding = { urlPattern: string; widget: string; fields: string[] };
export type FieldContract = { path: string; format?: 'number' | 'string' | 'date'; unit?: string; rounding?: number; timezone?: string; aggregation?: 'sum' | 'avg' | 'count' | 'none' };
export type ResetRecipe = { kind: 'storage-flag' | 'mock-endpoint'; key?: string; url?: string };
export type Profile = {
  name: string;
  extractors: ProfileExtractor[];
  oracles: OracleBinding[];
  contract?: FieldContract[];
  reset?: ResetRecipe;
  navigation?: { idSegmentPattern: string };
  testData?: { dir: string };
  responseSource?: 'playwright' | 'msw-hook';
  browser?: { launchArgs?: string[] };
};
export async function loadProfile(stateDir: string, name: string): Promise<Profile>   // PROFILE_NOT_FOUND | PROFILE_INVALID
export async function loadActiveProfile(stateDir: string): Promise<Profile | null>    // null, если config.profile не задан
```
- Consumes: `readConfig` из `src/config.ts`.

- [ ] **Step 1: Написать падающие тесты**

`server/test/profile.bhtest.ts`:
- `loads a valid profile module from state/profiles/<name>/index.ts` — создать временный stateDir с профилем, `loadProfile` возвращает объект с ожидаемыми `name`/`extractors.length`.
- `rejects a missing profile with PROFILE_NOT_FOUND` — `assert.rejects(..., /PROFILE_NOT_FOUND/)`.
- `rejects an invalid profile with PROFILE_INVALID` — профиль без `extractors`; сообщение содержит имя поля.
- `config accepts an optional profile field and rejects unknown fields` — схема `strictObject`.
- `core sources do not mention BI-specific libraries` — обход `server/src/**/*.ts`, `assert.ok(!/konva|three|msw|navigator-bi/i.test(source))` (проверяет анти-цель и риск R6).

- [ ] **Step 2: Запустить тесты и убедиться, что они падают**

Run: `env -u PLAYWRIGHT_BROWSERS_PATH node --test test/profile.bhtest.ts`
Expected: FAIL — `Cannot find module '../src/profile/load.ts'`.

- [ ] **Step 3: Реализовать типы и загрузчик**

`loadProfile` читает `state/profiles/<name>/index.ts` динамическим `import(pathToFileURL(...).href)`, валидирует zod-схемой профиля (отдельная схема в `load.ts`, не в `config.ts`), при отсутствии файла — `PROFILE_NOT_FOUND: <name>`, при ошибке схемы — `PROFILE_INVALID: <поле>`. Имя профиля проверяется на `^[A-Za-z0-9._-]+$` и на `.`/`..` (выход за пределы `state/profiles`).

- [ ] **Step 4: Добавить поле в конфиг**

`config.ts`: `profile: z.string().min(1).optional()`; `types.ts`: `profile?: string` в `Config`.

- [ ] **Step 5: Запустить тесты**

Run: `env -u PLAYWRIGHT_BROWSERS_PATH node --test test/profile.bhtest.ts && npm run typecheck`
Expected: PASS (5 тестов), typecheck без ошибок.

- [ ] **Step 6: Commit**

```bash
git add server/src/profile server/test/profile.bhtest.ts server/src/config.ts server/src/types.ts
git commit -m "feat(profile): add application profile contract and loader"
```

---

### Task 3: Контекстный захват ответов API с телами

**Files:**
- Create: `server/src/browser/network.ts`
- Modify: `server/src/browser/session.ts` (подключение захвата, привязка к шагу, `settle()`), `server/src/types.ts` (`CapturedResponse`, `Step.responseHashes`)
- Test: `server/test/network.bhtest.ts`

**Interfaces:**
- Consumes: `Profile.responseSource` (Task 2), правило ветвления из Task 1 (`S1`).
- Produces:
```ts
export type CapturedResponse = {
  url: string; method: string; status: number; route: string; timestamp: string;
  hash: string; bytes: number; truncated: boolean; json?: unknown; bodyPath?: string;
};
export type NetworkCapture = {
  responses(): CapturedResponse[];
  takeFor(stepId: string): CapturedResponse[];   // ответы, накопленные с предыдущего шага
  waitFor(binding: { urlPattern: string }, timeoutMs: number): Promise<CapturedResponse>;  // RESPONSE_TIMEOUT
  dispose(): Promise<void>;
};
export function attachNetworkCapture(context: BrowserContext, options: {
  stateDir: string; runId: string; maxBodyBytes: number; responseSource: 'playwright' | 'msw-hook';
}): Promise<NetworkCapture>;
export const maxResponseBodyBytes = 262_144;
```

- [ ] **Step 1: Написать падающие тесты**

`server/test/network.bhtest.ts` (локальный `node:http`-сервер как стенд, Chrome через `channel`):
- `captures method, status, url and route for same-origin responses` — `takeFor` возвращает запись с ожидаемыми полями.
- `oversized response body is truncated, hashed and stored as an artifact` — ответ 1 МБ: `truncated === true`, `bytes === 1048576`, `bodyPath` существует, `json` усечён, в журнале только хэш.
- `parses JSON bodies and keeps non-JSON as hash only` — `content-type: text/csv` → `json === undefined`, `hash` присутствует.
- `waitFor resolves on the bound response and rejects with RESPONSE_TIMEOUT` — оба случая.
- `network capture sees service-worker-served responses or reports RESPONSE_SOURCE_UNAVAILABLE` — ветка из Task 1: если `S1` положителен, тест поднимает страницу с SW-прокси (достаточно простого SW, отвечающего на `/api/sw`), иначе проверяет, что при `responseSource: 'msw-hook'` ответы читаются из `window.__bhResponses`, а при недоступном источнике журнал содержит `RESPONSE_SOURCE_UNAVAILABLE`.
- `external origin responses are not captured` — политика `allowedOrigins` сохраняется.

- [ ] **Step 2: Запустить и убедиться, что падают**

Run: `env -u PLAYWRIGHT_BROWSERS_PATH node --test test/network.bhtest.ts`
Expected: FAIL — `Cannot find module '../src/browser/network.ts'`.

- [ ] **Step 3: Реализовать `network.ts`**

Слушатели `context.on('response')` и `context.on('requestfailed')` вместо `page.on(...)`; фильтр по `allowedOrigins` (переиспользовать `isAllowed`-логику сессии, вынеся её в общую функцию); чтение тела с `maxResponseBodyBytes`; хэш `sha256` от полного тела; полный текст — в `runs/<runId>/responses/<hash>.json`; привязка к шагу через очередь «ответы с момента предыдущего шага». Для `responseSource: 'msw-hook'` — `page.exposeFunction('__bhReportResponse', …)` и `addInitScript`, читающий `window.__bhResponses` (ветка выбирается по результату Task 1).

- [ ] **Step 4: Подключить к сессии и journal**

`session.ts`: создание захвата в `open()` после `newContext`, `dispose()` в `close()` в `finally`; в `appendStep` добавлять `responseHashes: string[]`; `settle()` дополнить ожиданием привязанного ответа через `NetworkCapture.waitFor` с таймаутом из `limits.responseSettleMs` (новое поле конфига, дефолт 5000) — это устраняет класс гонок, уже встречавшийся в экспортёре.

- [ ] **Step 5: Запустить тесты**

Run: `env -u PLAYWRIGHT_BROWSERS_PATH node --test test/network.bhtest.ts && npm run typecheck`
Expected: PASS (6 тестов).

- [ ] **Step 6: Прогнать весь набор**

Run: `caffeinate -i env -u PLAYWRIGHT_BROWSERS_PATH npm test`
Expected: PASS, число тестов = прежнее + 6.

- [ ] **Step 7: Commit**

```bash
git add server/src/browser/network.ts server/src/browser/session.ts server/src/types.ts server/src/config.ts server/test/network.bhtest.ts
git commit -m "feat(network): capture response bodies at context level with size caps and artifacts"
```

---

### Task 4: Новые действия и защита координатных целей

**Files:**
- Create: `server/src/browser/point.ts`
- Modify: `server/src/types.ts`, `server/src/browser/session.ts`, `server/src/reproduce.ts`, `server/src/export/playwright.ts`
- Test: `server/test/actions.bhtest.ts`

**Interfaces:**
- Consumes: `Profile.interactions` (Task 2).
- Produces:
```ts
// types.ts
export type StepAction = 'click' | 'dblclick' | 'fill' | 'select' | 'press' | 'check' | 'hover'
  | 'drag' | 'scroll' | 'clickAt' | 'hoverAt' | 'upload';
// Step: + to?: { locator: string }; at?: { x: number; y: number }; resolvedLocator?: string;
//         file?: string; scroll?: { direction: 'up' | 'down' | 'left' | 'right'; delta: number }
// ActInput: + toElementId?: string; at?: { x: number; y: number }; file?: string;
//             scroll?: { direction: 'up' | 'down' | 'left' | 'right'; delta: number }
// point.ts
export async function resolvePointTarget(page: Page, at: { x: number; y: number }): Promise<{ locator: string; text: string; role?: string }>;
// ошибки: POINT_TARGET_UNRESOLVED, UPLOAD_FILE_NOT_FOUND, DRAG_TARGET_REQUIRED, SCROLL_INVALID
```

- [ ] **Step 1: Написать падающие тесты**

`server/test/actions.bhtest.ts` на демо-фикстуре (без её изменения — только чтение и действия):
- `drag moves a value between two elements and records both locators` — на странице с двумя drop-зонами из временной копии фикстуры; в журнале `from`/`to`.
- `scroll records direction and delta and changes the visible set`
- `clickAt and hoverAt resolve a semantic target and record it` — `resolvedLocator` совпадает с локатором элемента под точкой.
- `coordinate actions resolve a semantic target before forbidden and readOnly guards` — точка над элементом с запрещённым текстом → `FORBIDDEN_ACTION`; при `readOnly: true` точка над submit → `FORM_SUBMISSION_BLOCKED`.
- `unresolvable point is rejected with POINT_TARGET_UNRESOLVED` — точка вне документа.
- `upload takes a file from profile testData and rejects unknown paths` — `UPLOAD_FILE_NOT_FOUND` для пути вне `testData.dir`.
- `reproduce replays every new action kind` — журнал с новыми шагами воспроизводится 3/3.
- `export generates code for every new action kind` — в сгенерированном спеке есть `dragTo`, `mouse.wheel`/`scrollBy`, `mouse.click(x, y)`, `setInputFiles`.

- [ ] **Step 2: Запустить и убедиться, что падают**

Run: `env -u PLAYWRIGHT_BROWSERS_PATH node --test test/actions.bhtest.ts`
Expected: FAIL — новые действия не поддержаны (`ACTION_UNSUPPORTED`).

- [ ] **Step 3: Реализовать `point.ts` и действия**

`resolvePointTarget`: `page.evaluate` с `document.elementFromPoint`, затем построение семантического локатора существующими средствами `elements.ts`; если профиль объявил `interactions.resolvePoint`, сначала используется он. Guard'ы вызываются для разрешённой цели, а не для координаты. `drag` — `locator.dragTo(target)`; `scroll` — `mouse.wheel` для направления down/up и `scrollBy` для контейнера; `upload` — `locator.setInputFiles(path)`, путь резолвится строго внутри `profile.testData.dir`.

- [ ] **Step 4: Обновить воспроизведение и экспорт**

`reproduce.ts`: повтор новых шагов тем же путём, что и в сессии; минимизация не удаляет координатный шаг, если его удаление меняет разрешённую цель. `export/playwright.ts`: генерация кода для каждого нового действия (шаблон — в тестах Step 1).

- [ ] **Step 5: Запустить тесты**

Run: `env -u PLAYWRIGHT_BROWSERS_PATH node --test test/actions.bhtest.ts && npm run typecheck`
Expected: PASS (8 тестов).

- [ ] **Step 6: Полный набор**

Run: `caffeinate -i env -u PLAYWRIGHT_BROWSERS_PATH npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/browser/point.ts server/src/browser/session.ts server/src/types.ts server/src/reproduce.ts server/src/export/playwright.ts server/test/actions.bhtest.ts
git commit -m "feat(actions): add drag, scroll, coordinate and upload actions guarded by semantic target"
```

---

### Task 5: Ранжирование, лимит и пагинация снимка, структура экрана

**Files:**
- Modify: `server/src/browser/elements.ts`, `server/src/index.ts` (`bh_state`, `compactState`), `server/src/types.ts`, `server/src/config.ts`
- Test: `server/test/snapshot.bhtest.ts`

**Interfaces:**
- Consumes: `Profile.extractors` (Task 2), `CapturedResponse` (Task 3).
- Produces:
```ts
export type SnapshotPage = { elements: SemanticElement[]; nextCursor?: number; totalVisible: number; truncated: boolean };
export function rankElements(elements: SemanticElement[], viewport: { width: number; height: number }): SemanticElement[];
export function paginateElements(elements: SemanticElement[], limit: number, cursor?: number): SnapshotPage;
export type ScreenStructure = { widgets: Array<{ widget: string; kind: ExtractorKind; extractor?: string; summary?: unknown; truncated: boolean }> };
export async function describeScreen(page: Page, profile: Profile | null): Promise<ScreenStructure>;
// config: limits.elementsPerSnapshot (positive int, default 120)
// bh_state input: { sessionId, cursor?, limit? }; output: { ..., elements, nextCursor?, totalVisible, truncated, screen }
```

- [ ] **Step 1: Написать падающие тесты**

`server/test/snapshot.bhtest.ts`:
- `snapshot is ranked, capped and paginated without duplicates or gaps` — страница-генератор 500 кнопок (временная копия): ранжирование стабильно между вызовами, `limit` соблюдается, объединение всех страниц = полный набор без повторов.
- `elements inside the viewport rank first` — порядок: видимая область → роль → позиция.
- `structure block lists widgets declared by the profile extractor` — профиль с экстрактором `table`; в `screen.widgets` есть запись с `summary` (число строк, диапазоны).
- `extractor output over the size cap is truncated with a flag` — `truncated === true`, размер ≤ лимита.
- `extractor failure is reported, not swallowed` — `screen.widgets[].error` с кодом `EXTRACTOR_FAILED`.

- [ ] **Step 2: Запустить и убедиться, что падают**

Run: `env -u PLAYWRIGHT_BROWSERS_PATH node --test test/snapshot.bhtest.ts`
Expected: FAIL — `rankElements`/`describeScreen` не существуют.

- [ ] **Step 3: Реализовать ранжирование, лимит и структуру экрана**

Ранжирование: пересечение с viewport → роль (button/link/textbox выше декоративных) → позиция (сверху вниз, слева направо); порядок детерминирован и не зависит от порядка в DOM-выборке. `describeScreen` исполняет `extractor.script` через `page.evaluate`, требует сериализуемый JSON, применяет лимит размера (усечение с флагом), ошибку возвращает как `EXTRACTOR_FAILED: <имя>`.

- [ ] **Step 4: Расширить `bh_state` и конфиг**

`index.ts`: вход `cursor?`/`limit?`, выход с `nextCursor`, `totalVisible`, `truncated`, `screen`; `compactState` больше не отдаёт полный список без лимита. `config.ts`: `limits.elementsPerSnapshot` с дефолтом 120; README §5 дополняется строкой поля.

- [ ] **Step 5: Запустить тесты**

Run: `env -u PLAYWRIGHT_BROWSERS_PATH node --test test/snapshot.bhtest.ts && npm run typecheck`
Expected: PASS (5 тестов).

- [ ] **Step 6: Полный набор**

Run: `caffeinate -i env -u PLAYWRIGHT_BROWSERS_PATH npm test`
Expected: PASS; существующие тесты `elements.bhtest.ts` и `session.bhtest.ts` обновлены под лимит, если они этого требуют.

- [ ] **Step 7: Commit**

```bash
git add server/src/browser/elements.ts server/src/index.ts server/src/types.ts server/src/config.ts server/test/snapshot.bhtest.ts .qwen/bughunter/README.md
git commit -m "feat(state): rank, cap and paginate the element snapshot and add screen structure"
```

---

### Task 6: Настраиваемый запуск Chrome

**Files:**
- Modify: `server/src/config.ts`, `server/src/types.ts`, `server/src/browser/session.ts`
- Test: `server/test/config-store.bhtest.ts` (добавить случаи), `server/test/session.bhtest.ts` (добавить случай)

**Interfaces:**
- Consumes: правило ветвления `S3` (Task 1), `Profile.browser.launchArgs` (Task 2).
- Produces:
```ts
// config.ts
browser: z.strictObject({
  launchArgs: z.array(z.string()).max(64).default([]),
  proxy: z.string().min(1).optional(),
  ignoreHTTPSErrors: z.boolean().default(false),
}).optional();
// session.ts
export function resolveLaunchOptions(config: Config, profile: Profile | null): { args: string[]; proxy?: { server: string }; ignoreHTTPSErrors: boolean };
```

- [ ] **Step 1: Написать падающие тесты**

- `config accepts a browser section and rejects unknown browser fields` — `strictObject`.
- `resolveLaunchOptions merges profile args after config args and deduplicates` — порядок и дедупликация.
- `launch args from the spike are applied when WebGL requires them` — если `S3` показал необходимость swiftshader, дефолт профиля песочницы содержит эти args и сессия стартует; иначе тест проверяет, что произвольный `--window-size=1280,800` доходит до браузера (`page.evaluate(() => window.innerWidth)`).
- `proxy and ignoreHTTPSErrors are passed to launch and context` — проверка через `browser.proxy`/`context` опции (без реального прокси).

- [ ] **Step 2: Запустить и убедиться, что падают**

Run: `env -u PLAYWRIGHT_BROWSERS_PATH node --test test/config-store.bhtest.ts test/session.bhtest.ts`
Expected: FAIL — `resolveLaunchOptions` не существует.

- [ ] **Step 3: Реализовать**

`resolveLaunchOptions` объединяет `config.browser.launchArgs` и `profile.browser.launchArgs` (профильные после конфига, дубликаты по имени флага отбрасываются), добавляет обязательный минимум (`--no-first-run`, `--no-default-browser-check`), передаёт `proxy` в `chromium.launch`, `ignoreHTTPSErrors` — в `newContext`. Запрещены аргументы, отключающие безопасность профиля (`--disable-web-security`): ошибка `LAUNCH_ARG_FORBIDDEN`.

- [ ] **Step 4: Запустить тесты и полный набор**

Run: `env -u PLAYWRIGHT_BROWSERS_PATH node --test test/config-store.bhtest.ts test/session.bhtest.ts && caffeinate -i env -u PLAYWRIGHT_BROWSERS_PATH npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/config.ts server/src/types.ts server/src/browser/session.ts server/test/config-store.bhtest.ts server/test/session.bhtest.ts
git commit -m "feat(browser): configurable Chrome launch args, proxy and HTTPS error policy"
```

---

### Task 7: Обнаружение экранов, шаблонизация и инвентарь

**Files:**
- Create: `server/src/discovery/screens-store.ts`, `server/src/discovery/crawl.ts`
- Modify: `server/src/index.ts` (`bh_crawl`), `server/src/types.ts`
- Test: `server/test/discovery.bhtest.ts`

**Interfaces:**
- Consumes: `Profile.navigation.idSegmentPattern` (Task 2), политику `isAllowed` (существующая).
- Produces:
```ts
export type ScreenEntry = {
  template: string; sampleUrl: string; discoveredVia: string[];
  widgets: string[]; lastCheckedAt?: string; cursorState?: number;
};
export function templatisedPathname(pathname: string, idSegmentPattern: string): string;   // '/dashboard/5f2c…' -> '/dashboard/:id'
export async function readScreens(stateDir: string): Promise<ScreenEntry[]>;
export async function upsertScreens(stateDir: string, entries: ScreenEntry[]): Promise<{ added: number; updated: number; total: number }>;
export async function crawlScreens(options: {
  baseUrl: string; allowedOrigins: string[]; stateDir: string; profile: Profile | null;
  maxScreens: number; maxDepth: number; startPaths: string[];
}): Promise<{ added: number; total: number; stoppedEarly: boolean; reason?: string }>;
// bh_crawl input: { maxScreens?, maxDepth?, startPaths? }
// ошибки: CRAWL_LIMIT_REACHED (не ошибка, а reason), SCREENS_STORE_CORRUPT
```

- [ ] **Step 1: Написать падающие тесты**

`server/test/discovery.bhtest.ts` на копии демо-фикстуры:
- `crawl templates dynamic segments and is incremental` — искусственные ссылки `/orders/12`, `/orders/7f3a…` дают один шаблон `/orders/:id`; повторный crawl не дублирует запись, `updated > 0`.
- `crawl stays inside allowed origins and records blocked hops` — внешняя ссылка не обходится, факт записан.
- `crawl stops at maxScreens with stoppedEarly and a reason`
- `screens store survives concurrent upsert and reports corruption` — повреждённый JSON → `SCREENS_STORE_CORRUPT`, а не тихая перезапись.
- `bh_crawl is reachable over real stdio MCP` — handshake и вызов через `Client` (по образцу `portable.bhtest.ts`).

- [ ] **Step 2: Запустить и убедиться, что падают**

Run: `env -u PLAYWRIGHT_BROWSERS_PATH node --test test/discovery.bhtest.ts`
Expected: FAIL — модули не найдены.

- [ ] **Step 3: Реализовать шаблонизацию и хранилище**

`templatisedPathname`: сегменты,matching `idSegmentPattern` (по умолчанию `^[0-9a-f]{8,}$|^\d+$`), заменяются на `:id`. `screens-store.ts`: атомарная запись через временный файл и rename (как в `run-store.ts`), слияние по `template`, сохранение `discoveredVia` как множества.

- [ ] **Step 4: Реализовать crawl и инструмент**

Обход в ширину: очередь URL, глубина, лимит экранов, только разрешённые origin; на каждом экране — сбор ссылок (`a[href]`, элементы с `role=link`) и вызов `describeScreen` (Task 5) для списка виджетов. Регистрация инструмента `bh_crawl` в `index.ts` с zod-схемой и компактным ответом.

- [ ] **Step 5: Запустить тесты и полный набор**

Run: `env -u PLAYWRIGHT_BROWSERS_PATH node --test test/discovery.bhtest.ts && caffeinate -i env -u PLAYWRIGHT_BROWSERS_PATH npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/discovery server/src/index.ts server/src/types.ts server/test/discovery.bhtest.ts
git commit -m "feat(discovery): crawl screens, template dynamic routes and keep an incremental inventory"
```

---

### Task 8: Области `screen`/`sweep`, детерминированный обход и чекпоинты

**Files:**
- Create: `server/src/sweep.ts`
- Modify: `server/src/run-store.ts` (области, стадии, `finishRun`), `server/src/index.ts` (`bh_sweep`, `bh_start_run` scope), `server/src/types.ts` (`Finding`)
- Test: `server/test/sweep.bhtest.ts`, дополнить `server/test/report-resume.bhtest.ts`

**Interfaces:**
- Consumes: `screens.json` (Task 7), `describeScreen` (Task 5), `NetworkCapture` (Task 3), `Profile.reset` (Task 2).
- Produces:
```ts
export type Finding = {
  id: string; runId: string; screenTemplate: string; widget?: string;
  kind: 'extract-failed' | 'response-missing' | 'response-captured' | 'navigation-failed';
  detail: string; responseHashes: string[]; status: 'new' | 'promoted' | 'dismissed';
  createdAt: string;
};
export type SweepProgress = { visited: string[]; cursor: number; startedAt: string; updatedAt: string };
export async function runSweep(options: {
  runId: string; stateDir: string; limit?: number; cursor?: number;
}): Promise<{ visited: string[]; nextCursor?: number; findings: number; done: boolean }>;
export async function applyReset(page: Page, profile: Profile | null): Promise<void>;   // RESET_UNSUPPORTED, если рецепта нет
export async function readFindings(runId: string, stateDir: string): Promise<Finding[]>;
export async function promoteFindingToCandidate(input: { runId: string; findingId: string; title: string; expected: string; actual: string; stateDir?: string }): Promise<{ candidateId: string }>;
// bh_sweep input: { runId, limit?, cursor? }; scope 'sweep' | 'screen' в bh_start_run
```

- [ ] **Step 1: Написать падающие тесты**

`server/test/sweep.bhtest.ts` на копии демо-фикстуры:
- `sweep visits every inventoried screen without a model and records responses` — после `bh_crawl` sweep обходит все экраны, на каждом есть ≥ 1 `response-captured` или явная находка.
- `sweep applies the profile reset before each screen` — сценарий MSW/состояние возвращается к seed; при отсутствии `reset` — `RESET_UNSUPPORTED` и явная пометка в finding.
- `interrupted sweep resumes from its cursor and finishRun accepts sweep scope` — прервать после N экранов (ограничение `limit`), повторно вызвать: `visited` не пересекается, `bh_finish_run` завершает прогон без `RUN_INCOMPLETE` по `routeStages`.
- `findings are not candidates until promoted` — `bh_triage` по `findingId` отклоняется (`FINDING_NOT_CANDIDATE`), после `promoteFindingToCandidate` обычный поток работает.
- `screen scope restricts the run to one template` — `bh_start_run { scope: 'screen', route: '/orders/:id' }`.

Дополнить `report-resume.bhtest.ts`: `finishRun` для области `sweep` не требует `routeStages` по всем `routes` (существующее поведение для `full`/`route` сохраняется — регрессионный случай остаётся).

- [ ] **Step 2: Запустить и убедиться, что падают**

Run: `env -u PLAYWRIGHT_BROWSERS_PATH node --test test/sweep.bhtest.ts test/report-resume.bhtest.ts`
Expected: FAIL — `runSweep` не существует / `finishRun` требует `routeStages`.

- [ ] **Step 3: Реализовать sweep**

Один браузерный контекст на обход; на каждый экран: `applyReset` → `page.goto(sampleUrl)` → `settle()` с ожиданием привязанных ответов → `describeScreen` → фиксация `CapturedResponse` как находок `response-captured`. Курсор и `visited` — в `runs/<runId>/sweep.json`, запись после каждого экрана (чекпоинт). Lease/`activeExplorerRuns` не задействуются: sweep не открывает сессию исследователя.

- [ ] **Step 4: Обновить run-store и инструменты**

`createRun` принимает `scope: 'sweep' | 'screen'`; для `screen` очередь не строится, маршрут один; для `sweep` стадии — `sweep`/`findings` вместо `explore`. `finishRun` проверяет завершённость по фактической области. Регистрация `bh_sweep` и расширение `bh_start_run`.

- [ ] **Step 5: Обновить промпты и их контракт-тест**

`.qwen/skills/bughunter/SKILL.md`: области `screen`/`sweep`, правило «не запускать модель там, где достаточно `sweep`». `.qwen/agents/bh-explorer.md`: работа со «структурой экрана» и новыми действиями. `test/prompts.bhtest.ts`: новые обязательные строки (`sweep`, `screen`, `structure экрана`, `drag`, `scroll`).

Run: `env -u PLAYWRIGHT_BROWSERS_PATH node --test test/prompts.bhtest.ts`
Expected: сначала FAIL (контракт строже промпта), затем PASS после правки промптов.

- [ ] **Step 6: Запустить тесты и полный набор**

Run: `caffeinate -i env -u PLAYWRIGHT_BROWSERS_PATH npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Обновить README**

§5 — новые поля конфига (`profile`, `limits.elementsPerSnapshot`, `limits.responseSettleMs`, `browser.*`); §6 — области `screen`/`sweep`; §7 — новые артефакты (`responses/`, `screens.json`, `findings/`, `sweep.json`); §12 — ограничения фазы 1 (сверка данных ещё не выполняется, `sweep` только собирает проекции и ответы).

- [ ] **Step 8: Commit**

```bash
git add server/src/sweep.ts server/src/run-store.ts server/src/index.ts server/src/types.ts server/test/sweep.bhtest.ts server/test/report-resume.bhtest.ts server/test/prompts.bhtest.ts .qwen/agents .qwen/skills .qwen/bughunter/README.md
git commit -m "feat(sweep): deterministic screen sweep with checkpoints, findings and screen scope"
```

---

## Self-Review (выполнено автором плана)

**Покрытие спеки.** §5.1 слои → Task 2; §5.2.1 области → Task 8; §5.2.2 crawl/инвентарь → Task 7; §5.2.3–4 сеть и тела → Task 3; §5.2.5 привязка ответа и момент сверки → Task 3 (`waitFor` + `settle`), сами оракулы — фаза 2, отдельный план; §5.2.6 `finding` → Task 8; §5.2.7 новые действия → Task 4; §5.2.8 reset → Task 8 (`applyReset`), полный режим повтора находок — фаза 2; §5.2.9 снимок → Task 5; §5.2.10 областные подавления — фаза 2; §5.2.11 отчёт — фаза 2; §5.2.12 экспорт data-теста — фаза 2, экспорт новых шагов → Task 4; §5.3 промпты → Task 8 Step 5; §5.4 фикстура `bi-app` — фаза 2 (в этой фазе только выбрасываемая песочница Task 1); §5.5 фазы 2–3 — отдельные планы. Пробелов в области фаз 0–1 нет.

**Сквозные типы.** `Profile` (Task 2) используется в Tasks 3–8 под одним именем; `CapturedResponse`/`NetworkCapture` (Task 3) — в Tasks 5 и 8; `describeScreen`/`ScreenStructure` (Task 5) — в Tasks 7 и 8; `ScreenEntry` (Task 7) — в Task 8; `Finding` (Task 8) объявлен в `types.ts` и не переопределяется. Имена ошибок уникальны и не пересекаются с существующими (`LEASE_*`, `EXPLORER_BUSY`, `RUN_INCOMPLETE`, `CANDIDATE_UNREPRODUCED`, `ROUTE_NOT_ALLOWED`).

**Пропорция.** План описывает решения (имена, сигнатуры, значения, тесты), тела алгоритмов оставлены исполнителю, кроме мест, где поведение неоднозначно (ранжирование, дедупликация launch args, правило шаблонизации).
