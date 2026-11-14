# Bughunter: второй пресет (`bughunter-node`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сделать контракт пресета нагруженным (воспроизведение в core, все 16 хуков заполнены) и добавить второй пресет `bughunter-node` для HTTP-API локального сервиса нулевым числом правок core, с двухслойной приёмкой и приёмкой гайдлайнов свежим агентом.

**Architecture:** Core владеет методом: очередь и lease, воспроизведение с бюджетами и минимизацией, вердикты тестов, отчёт, экспорт-хост, обход с курсором. Пресет отвечает на пять вопросов: единица исследования (эндпоинт), как увидеть и действовать (HTTP-сессия на `fetch`), что симптом (детекторы статусов и тела ответа), какое нарушение проверяется (`status`/`jsonPath`/`headerContains`), как повторить и какой тест собрать (последовательность запросов → Vitest). Node-пресет — учебный пример: маленький, читаемый, без автообхода роутеров и без авторизации.

**Tech Stack:** Node ≥ 22.18 (type stripping, без сборки), npm workspaces, `@modelcontextprotocol/sdk`, `zod` v4; фикстура — голый `node:http` без рантайм-зависимостей, `vitest` только как devDependency фикстуры.

**Spec:** `docs/superpowers/specs/2026-11-13-bughunter-core-and-presets-design.md` — §6.2 (состав core, `reproduce-protocol`), §6.3 (контракт пресета), §6.7 (`bughunter-node`, критерии приёмки 1–5), §6.8 (приёмка гайдлайнов), §6.9 (конфиг и профиль), §6.10 (лексика схемы). План аргументирует от спецификации; при расхождении спецификация главнее.

## Global Constraints

- Node.js **≥ 22.18**, исполнение TypeScript снятием типов, **без шага сборки**.
- Монорепо на npm workspaces: один `package-lock.json` в `.qwen/bughunter/`, установка одним `npm ci` из `.qwen/bughunter/`.
- Рантайм-зависимости пресета: `@modelcontextprotocol/sdk`, `zod`, `@bughunter/core` (workspace). Фикстура `fixtures/node-api-app` — **ноль рантайм-зависимостей** (голый `node:http`), `vitest` только в devDependencies фикстуры.
- `@bughunter/core` остаётся `"private": true` и не публикуется (публикация — фаза D).
- Критерий приёмки 6.7.1: `bughunter-node` добавлен **нулевым числом правок в `core/`** — проверяется диффом и тестом направления импортов. Задачи 1 и 2 правят core **до** появления node-пресета и являются отдельными задачами про метод, а не правками под пресет.
- Один проект = один пресет: `assertSinglePreset`, маркер `<stateDir>/preset.json`, чужое имя → `PRESET_CONFLICT`.
- Доменно-нейтральная лексика core закреплена тестом `core/test/boundary.bhtest.ts` (18 токенов по границам слов + запрет импортов пресета). Список токенов не ослабляется без `Ruling:` в ledger.
- Команда запуска остаётся `/bughunter` для всех пресетов; пресет определяется точкой входа в `.mcp.json`.
- Промпт-слой: скиллы — core (общие для всех пресетов), агенты и карта пресета — свои у каждого пресета. Имя карты в установленной копии постоянно — `bughunter-preset-card`.
- Засеянный баг **N5 остаётся засеянным и не находится**: это измеренный базовый уровень в отчёте приёмки, а не умолчание (инвариант 7). Порог «≥ 4 из 6» это учитывает.
- Модельные прогоны — только в одноразовых копиях **вне** `.qwen/` (`bughunter-gate/…`), с точечным allow-list в `.qwen/settings.json` копии и **без** `--dangerously-skip-permissions`.
- Инструмент не меняет код приложения и ничего не коммитит. Сгенерированные тесты — единственное, что попадает в дерево проекта.
- Каждый модельный вердикт `red` перепроверяется собственным запуском, а не принимается со слов модели.
- Зелёная линия перед стартом: core 47/47, веб-пресет 260 тестов (259 pass / 1 skipped под флагом `BH_BI_FULL_SWEEP=1`). Полный набор — `cd .qwen/bughunter && npm test --workspaces --if-present` (~5.5 мин); во время его прогона не запускать ничего параллельно (известная гонка ресурсов).

## Review Focus

- **Стенд отвечает медленно или виснет.** Запрос обязан уложиться в `requestTimeoutMs` и стать сигналом/находкой, а не повесить прогон; разумное ожидание — явная ошибка с кодом, а не бесконечное ожидание. Тест: задача 5, `a hung endpoint times out and becomes a signal`.
- **Ответ уводит за пределы разрешённого стенда** (редирект на чужой хост или абсолютный URL в запросе). Ожидание — блокировка до выполнения, код `FORBIDDEN_ORIGIN`. Тест: задача 5, `requests outside allowedHosts are blocked before they are sent`.
- **Автор пресета оставил незаполненный хук.** Ожидание — явное падение `PRESET_HOOK_NOT_WIRED` при первом вызове и красный тест «нет декоративного контракта», а не молчаливая работа половины пресета. Тест: задача 2, `shipped presets wire every hook of the contract`.
- **Чужой пресет на том же каталоге состояния.** Ожидание — `PRESET_CONFLICT` с путём, а не общая порча `state/`. Тест: задача 4, `the node preset refuses a state dir owned by another preset`.
- **`jsonPath` на отсутствующем, глубоком или не-JSON значении.** Ожидание — понятная ошибка `CHECK_INVALID`/`POINTER_NOT_FOUND` с указателем, а не stack и не тихий `undefined`. Тест: задача 5, `a jsonPath check on a missing pointer reports the pointer, not a stack`.

---

## Подготовка рабочего места (один раз, до задачи 1)

Работа идёт в worktree `/Users/nemiok/Desktop/projects/vault/bughunter-phase-b` (ветка `phase-b-node-preset` от `main` = `a6d2252`). Зависимости в worktree отсутствуют: выполнить `cd .qwen/bughunter && npm ci`, а `node_modules` пяти фикстур склонировать из основного дерева через `cp -Rc` (APFS clonefile) вместо переустановки ~700 МБ — приём доказан в фазе A. Базовая линия перед первой правкой: `npm test --workspaces --if-present` → core 47/47, веб-пресет 260 тестов (259 pass / 1 skipped), `npm run typecheck --workspaces --if-present` → 0 ошибок. Если клонированные зависимости расходятся, это видно на базовой линии до правок.

---

### Task 1: Core владеет протоколом воспроизведения

**Files:**
- Create: `core/src/reproduce.ts`, `core/test/reproduce.bhtest.ts`
- Modify: `core/src/preset.ts` (расширение `Replay`), `core/src/index.ts` (барель), `presets/web/src/reproduce.ts` (остаётся веб-исполнение), `presets/web/src/runs.ts` (обёртка), `presets/web/test/reproduce.bhtest.ts` (три алгоритмических теста уезжают в core)

**Interfaces:**
- Consumes: `StepBase`, `Candidate`, `Journal`, `Check` из `core/src/types.ts`; `readRun`, `writeJsonAtomic` из `core/src/run-store.ts`
- Produces:
  - `core/src/preset.ts`: `export type ReplayOutcome = { matched: boolean; artifacts: string[] }`; `export type ReplayContext = { candidate: Candidate; journal: Journal; stateDir: string }`; `export type Replay = { replay(steps: StepBase[], context: ReplayContext): Promise<ReplayOutcome>; abort?(): Promise<void> }`
  - `core/src/reproduce.ts`: `export const reproductionBudget = { maximumAttempts: 3, maximumEvaluations: 20, maximumDurationMs: 300_000 }`; `export type ReplayAlgorithmResult = { successes: number; initialAttempts: number; evaluations: number; minimalSteps: StepBase[] }`; `export async function replayAndMinimize(steps: StepBase[], attempts: number, replay: (steps: StepBase[]) => Promise<boolean>, options?: { now?: () => number; abort?: () => Promise<void> }): Promise<ReplayAlgorithmResult>`; `export type ReproductionResult = { reproduced: \`${number}/${number}\`; steps: number; signature: string; artifacts: string[]; minimalSteps: number }`; `export async function reproduceCandidate(input: { runId: string; candidateId: string; attempts?: number; stateDir: string; replay: Replay; now?: () => number }): Promise<ReproductionResult>`
  - `presets/web/src/reproduce.ts`: `export const webReplay: Replay` и тонкая обёртка `export async function reproduceCandidate(input: { runId: string; candidateId: string; attempts?: number; stateDir?: string; now?: () => number }): Promise<ReproductionResult>`, которая инжектирует `webReplay`

- [ ] **Step 1: Перенести три алгоритмических теста в core (RED)**

Скопировать из `presets/web/test/reproduce.bhtest.ts` в `core/test/reproduce.bhtest.ts` три теста, которые не поднимают браузер: `fake replay minimizes by removal and restores required steps exactly`, `fake replay never invokes the 21st evaluation including initial attempts`, `deadline aborts pending replay and prevents further evaluations`. Импорты перевести на `../src/reproduce.ts`, тип шагов — `StepBase` из `../src/types.ts`; тела тестов не менять, кроме импортов и типа.

- [ ] **Step 2: Убедиться, что падают**

Run: `cd core && node --test test/reproduce.bhtest.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` на `core/src/reproduce.ts`

- [ ] **Step 3: Перенести протокол в `core/src/reproduce.ts`**

Из `presets/web/src/reproduce.ts` переезжают без изменения логики: константы бюджетов (стать `reproductionBudget`), `replayAndMinimize` (сигнатура шагов — `StepBase[]`), `validId`, `readCandidate`, `readJournal`, тип `ReproductionResult` и оркестратор `reproduceCandidate`: `readRun` → чтение кандидата → `CANDIDATE_RUN_MISMATCH` / `CANDIDATE_ORACLE_REQUIRED` → чтение журнала → `replayAndMinimize` с колбэком `(steps) => replay.replay(steps, { candidate, journal, stateDir })`, накоплением `outcome.artifacts` и `abort: () => replay.abort?.()` → запись `reproduction` и `minimalSteps` через `writeJsonAtomic` → возврат `ReproductionResult`. Веб-специфики в core не остаётся: ни `Page`, ни `SessionManager`, ни имён артефактов.

В `core/src/preset.ts` заменить объявление `Replay` на версию из блока Produces и добавить `ReplayOutcome`, `ReplayContext`. В `core/src/index.ts` добавить `export * from './reproduce.ts';`.

- [ ] **Step 4: Переписать веб-пресет на новый контракт**

`presets/web/src/reproduce.ts` сохраняет `executeReplay`, `observeReplayAnomaly`, `replayActInput`, `pageFor`, `hasVisibleText`, `checkViolated` и экспортирует `webReplay: Replay`, где `replay(steps, context)` — это `executeReplay` с приведением `StepBase[]` к `Step[]` и возвратом `{ matched, artifacts }`, а `abort()` закрывает все сессии менеджера и дожидается активного повтора. Оркестратор из этого файла удаляется; остаётся обёртка `reproduceCandidate`, инжектирующая `webReplay` (тот же приём, что в `runs.ts` и `sweep-visit.ts`).

- [ ] **Step 5: GREEN + полная линия**

Run: `cd core && node --test test/reproduce.bhtest.ts` → `# fail 0`
Run: `cd core && node --test test/*.bhtest.ts` → `# fail 0`
Run: `cd presets/web && env -u PLAYWRIGHT_BROWSERS_PATH node --test test/reproduce.bhtest.ts` → все браузерные тесты зелёные, три алгоритмических удалены из файла
Run: `cd .qwen/bughunter && npm run typecheck --workspaces --if-present` → 0 ошибок

- [ ] **Step 6: Commit**

```bash
git add .qwen/bughunter/core .qwen/bughunter/presets/web && git commit -m "refactor(core)!: own the reproduction protocol and its budgets"
```

---

### Task 2: Контракт нагружен — ни одной заглушки в поставляемом пресете

**Files:**
- Modify: `presets/web/src/preset.ts` (семь слотов), `presets/web/src/session-handle.ts` (new), `presets/web/src/checks.ts` (`validate`/`violated`), `presets/web/src/personas.ts` (`brief`), `presets/web/src/index.ts` (словари в схемах)
- Create: `core/test/contract-usage.bhtest.ts`
- Test: `presets/web/test/preset-contract.bhtest.ts`, `presets/web/test/errors.bhtest.ts`

**Interfaces:**
- Consumes: `Preset`, `SessionHandle`, `Replay`, `Checks`, `Detectors`, `ProfileSchema`, `Personas` из `core/src/preset.ts`; `webReplay` из задачи 1
- Produces:
  - `presets/web/src/session-handle.ts`: `export type WebSessionHandle = SessionHandle & { page: Page }`; `export function openWebSession(input: { runId: string; target: string; persona: string; stateDir: string }): Promise<WebSessionHandle>`
  - `presets/web/src/checks.ts`: `export function validateWebCheck(check: Check): void` (бросает `CHECK_INVALID: <причина>`), `export async function webCheckViolated(handle: SessionHandle, check: Check): Promise<boolean>`
  - `presets/web/src/personas.ts`: `export function personaBrief(persona: string): string`
  - `webPreset` без `pending(`

- [ ] **Step 1: Тесты (RED)**

`core/test/contract-usage.bhtest.ts`, два теста. `every Preset field is consumed by core`: разобрать поля `export type Preset` из `core/src/preset.ts` (тот же парсинг, что в `core/test/prompts-core.bhtest.ts`), для каждого имени интерфейса найти потребление в `core/src/**` — `preset.<поле>` или деструктуризацию; утверждение печатает список незадействованных полей. `shipped presets wire every hook of the contract`: обход `presets/*/src/preset.ts`, запрет подстрок `pending(` и `PRESET_HOOK_NOT_WIRED`; утверждение печатает файл и строку.
`presets/web/test/preset-contract.bhtest.ts` дополнить тестом `the web preset answers all five questions without stubs`: для каждого из 16 полей `webPreset` вызвать его там, где это безопасно без браузера (`inventory.list`, `checks.kinds`, `checks.validate`, `personas.roster`, `personas.brief`, `profile.testDataFile`, `exportTarget.dir/fileName/kind`, `errors.codes`, `findingKinds.kinds`, `reset.supported`, `report.finding/candidate`, `snapshot.compact`, `detectors.kinds`, `testRunner.kinds`) и утвердить, что ни один вызов не бросил `PRESET_HOOK_NOT_WIRED`.

- [ ] **Step 2: Убедиться, что падают**

Run: `cd core && node --test test/contract-usage.bhtest.ts`
Expected: FAIL — список незадействованных полей (`replay`, `checks`, `session`, …) и строки с `pending(` в `presets/web/src/preset.ts`

- [ ] **Step 3: Заполнить семь слотов**

`session` → `openWebSession`: адаптер над `SessionManager` (открыть, `snapshot()` = `manager.state(id, { screen: true, limit })` через `webSnapshot.compact`, `act(payload)` = `manager.act`, `steps()`/`artifacts()` из состояния сессии, `close()` = `manager.close`), с веб-полем `page` для оракулов. `detectors.scan` → существующий сбор сигналов сессии. `checks.validate` → `validateWebCheck` (перенести inline-проверку `CHECK_INVALID` из `browser/session.ts`, оставив там вызов). `checks.violated` → `webCheckViolated` (делегирование в `checkViolated` через `page` из `WebSessionHandle`). `replay` → `webReplay` из задачи 1. `profile.load`/`profile.testDataFile` → `loadProfile`/`resolveTestDataFile` из `profile/load.ts`. `personas.brief` → `personaBrief`: тексты персон вынести из `.qwen/agents/bh-explorer.md` в `presets/web/src/personas.ts` так, чтобы агент читал их через сервер, а не дублировал (механизм — как у `bh_open`: бриф возвращается в ответе инструмента).

Удалить `pending` из `presets/web/src/preset.ts`.

- [ ] **Step 4: Словари вместо литералов в точке входа**

`presets/web/src/index.ts`: `kind` в схеме `bh_verify_red` — из `webTestRunner.kinds`. Для этого вынести в `presets/web/src/test-runner.ts` `export const webTestKinds = [e2eKind, 'unit'] as const;`, использовать его и в `kinds: [...webTestKinds]`, и в схеме. Если статический импорт `test-runner.ts` в `index.ts` ломает startup-тест (модуль тянет значения из core), оставить литерал и зафиксировать `Ruling:` в ledger — startup-контракт дороже вывода словаря.

- [ ] **Step 5: GREEN + полная линия**

Run: `cd core && node --test test/*.bhtest.ts` → `# fail 0`
Run: `cd presets/web && env -u PLAYWRIGHT_BROWSERS_PATH npm test 2>&1 | tail -3` → `# fail 0`, `# skipped 1`
Run: `cd .qwen/bughunter && npm run typecheck --workspaces --if-present` → 0 ошибок

- [ ] **Step 6: Commit**

```bash
git add .qwen/bughunter && git commit -m "feat(web): wire every hook of the preset contract"
```

---

### Task 3: Каркас `presets/node` и фикстура `fixtures/node-api-app`

**Files:**
- Create: `presets/node/package.json`, `presets/node/tsconfig.json`, `presets/node/src/paths.ts`, `fixtures/node-api-app/{package.json,src/server.js,src/db.js,src/bugs.js,SEEDED.md,test/seeded.test.js}`
- Modify: `.qwen/bughunter/package.json` (`workspaces` += `presets/node`), `.qwen/bughunter/.gitignore` (`presets/node/state/*`)
- Test: `fixtures/node-api-app/test/seeded.test.js` (vitest)

**Interfaces:**
- Consumes: раскладку фазы A
- Produces:
  - фикстура: `GET /health`, `GET /orders`, `POST /orders`, `GET /orders/:id`, `POST /payments`, `POST /__reset`; шесть засеянных багов N1–N6 по таблице спецификации 6.7; `src/bugs.js` — реестр `export const SEEDED = [{ id: 'N1', endpoint, expected, actual, detectableBy }]`, `SEEDED.md` — его зеркало
  - `presets/node/src/paths.ts`: `export const defaultStateDir: string` (`resolve(import.meta.dirname, '../state')`)
  - `presets/node/package.json`: `name: "@bughunter/node"`, `private`, `type: module`, `engines.node >= 22.18`, deps `@bughunter/core`, `@modelcontextprotocol/sdk`, `zod`; devDeps `typescript`, `@types/node`; scripts `test`, `typecheck`, `start`

- [ ] **Step 1: Тест фикстуры (RED)**

`fixtures/node-api-app/test/seeded.test.js` (vitest, запускается из каталога фикстуры, поднимает сервер на свободном порту через `node:http`): по одному тесту на каждый засеянный баг — N1: `POST /orders` с `{"qty":"abc"}` → 500 и стек в теле; N2: `POST /orders` с `qty: -5` → 200 и бессмысленный итог; N3: `GET /orders/unknown` → 200 и `null` вместо 404; N4: два `POST /payments` одним idempotency-ключом списывают дважды; N5: `GET /orders` отдаёт то `totalCents`, то `total` (тест фиксирует разъезд схемы); N6: `POST /payments` при закрытом порту шлюза → в теле `ECONNREFUSED` и стек. Плюс контрольный тест: `GET /health` всегда `{status:'ok'}`, 200, `content-type: application/json`.

- [ ] **Step 2: Убедиться, что падают**

Run: `cd fixtures/node-api-app && npx vitest run`
Expected: FAIL — сервера и реестра нет (`ERR_MODULE_NOT_FOUND` / `ECONNREFUSED`)

- [ ] **Step 3: Написать фикстуру**

`src/db.js` — in-memory хранилище с `reset()` (исходное состояние: 3 заказа, 1 платёж). `src/bugs.js` — реестр `SEEDED` и функции-носители дефектов (каждый баг помечен комментарием `// N<номер>`). `src/server.js` — голый `node:http`: роутинг по `method`+`pathname`, JSON-парсинг тела с защитой от невалидного JSON, `POST /__reset` → `db.reset()`, порт из `process.env.PORT ?? 3000`, готовность печатается в stdout одной строкой `listening <port>`. Никаких рантайм-зависимостей. `SEEDED.md` — таблица-зеркало реестра с графой «чем обнаружим», где N5 помечен как **ожидаемый пропуск** (мини-оракул схемы ответа — фаза C).

- [ ] **Step 4: Каркас пакета пресета**

`presets/node/package.json` и `tsconfig.json` — по образцу `presets/web`; `src/paths.ts` — один резолвер `defaultStateDir`. В корневом `package.json` добавить `"presets/node"` в `workspaces`, выполнить `npm install` из `.qwen/bughunter` (обновит lockfile и создаст симлинк `@bughunter/node`). В `.qwen/bughunter/.gitignore` добавить `presets/node/state/runs/`, `presets/node/state/auth/`, `presets/node/state/preset.json`.

- [ ] **Step 5: GREEN + линии**

Run: `cd fixtures/node-api-app && npx vitest run` → все тесты зелёные (6 багов присутствуют, контроль чист)
Run: `cd .qwen/bughunter && npm run typecheck --workspaces --if-present` → 0 ошибок
Run: `cd .qwen/bughunter && npm test --workspaces --if-present` → `# fail 0`

- [ ] **Step 6: Commit**

```bash
git add .qwen/bughunter && git commit -m "feat(node): scaffold the node preset and seed the api fixture"
```

---

### Task 4: Конфиг, профиль и инвентарь node-пресета

**Files:**
- Create: `presets/node/src/config.ts`, `presets/node/src/types.ts`, `presets/node/src/inventory.ts`, `presets/node/src/profile.ts`, `presets/node/state/config.json`
- Test: `presets/node/test/config-store.bhtest.ts`, `presets/node/test/inventory.bhtest.ts`

**Interfaces:**
- Consumes: `commonConfigSchema`, `loadConfig`, `ensureConfig`, `configPath` из `@bughunter/core`; `TargetInventory`, `ProfileSchema` из `core/src/preset.ts`
- Produces:
  - `presets/node/src/types.ts`: `export type NodeStep = StepBase & { method?: string; path?: string; body?: unknown; status?: number; durationMs?: number }`; `export type EndpointEntry = { template: string; method: string; samplePath: string; description?: string }`; `export type NodeScenario = { name: 'valid' | 'empty' | 'invalid' | 'boundary'; request: { method: string; path: string; body?: unknown; headers?: Record<string, string> }; expect?: { status?: number; jsonPath?: Array<{ pointer: string; expected: unknown }> } }`
  - `presets/node/src/config.ts`: `export const nodeConfigSchema` (`commonConfigSchema.extend({ baseUrl: z.url(), allowedHosts: z.array(z.string().min(1)).min(1), scenarios: z.array(nodeScenarioSchema).min(1), reset: z.strictObject({ method: z.string(), path: z.string().startsWith('/') }).nullable(), requestTimeoutMs: z.number().int().positive().max(60_000).optional(), detectors: z.strictObject({ anomalyTexts: z.array(z.string().min(1)), ignoreStatuses: z.array(z.number().int()).optional() }) })`), `export type NodeConfig`, `export function loadNodeConfig(stateDir: string): Promise<NodeConfig>`, `export function ensureNodeConfig(stateDir: string): Promise<{ config: NodeConfig; createdPath?: string }>`
  - `presets/node/src/profile.ts`: `export const nodeProfile: ProfileSchema`, `export type NodeProfile = { endpoints: EndpointEntry[]; testDataDir?: string }`
  - `presets/node/src/inventory.ts`: `export const nodeInventory: TargetInventory`

- [ ] **Step 1: Тесты (RED)**

`presets/node/test/config-store.bhtest.ts`: `missing config creates the template without starting a run` (`ensureNodeConfig` → `createdPath`, файл валиден, `scenarios` непустой); `config with an unknown field is rejected naming the field`; `targetMap value without a leading slash is rejected naming the field` (та же гарантия, что в web); `allowedHosts must not be empty`.
`presets/node/test/inventory.bhtest.ts`: `inventory lists endpoint templates from the profile` (профиль с `GET /orders`, `GET /orders/:id`, `POST /orders`, `POST /payments`, `GET /health` → список из пяти шаблонов); `templateOf reduces a concrete id to the template` (`/orders/7f3ab4c9` → `/orders/:id`, неизвестный путь → сам путь); `the node preset refuses a state dir owned by another preset` — `assertSinglePreset(stateDir, 'node')` после записи маркера `{"name":"web"}` бросает `PRESET_CONFLICT: <stateDir>`.

- [ ] **Step 2: Убедиться, что падают**

Run: `cd presets/node && node --test test/config-store.bhtest.ts test/inventory.bhtest.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` на `../src/config.ts` и `../src/inventory.ts`

- [ ] **Step 3: Реализовать**

`nodeConfigSchema` — по сигнатуре из Produces; шаблон конфига содержит `baseUrl` локального стенда фикстуры, `allowedHosts: ['127.0.0.1', 'localhost']`, четыре сценария на каждый из пяти эндпоинтов, `reset: { method: 'POST', path: '/__reset' }`, `requestTimeoutMs: 10_000`, `detectors.anomalyTexts: ['undefined', 'NaN', '[object Object]', 'ECONNREFUSED', 'at Object.<anonymous>']`. `nodeProfile.load(stateDir, name)` читает `state/profiles/<name>/index.ts` (модуль с `endpoints`), `testDataFile(profile, relative)` — путь внутри `profile.testDataDir` с отклонением выхода за каталог (`TEST_DATA_PATH_UNSAFE`). `nodeInventory.list(stateDir)` — шаблоны из профиля, `templateOf(value)` — приведение числовых и hex-сегментов к `:id`.

- [ ] **Step 4: GREEN + линии**

Run: `cd presets/node && node --test test/*.bhtest.ts` → `# fail 0`
Run: `cd .qwen/bughunter && npm run typecheck --workspaces --if-present` → 0 ошибок

- [ ] **Step 5: Commit**

```bash
git add .qwen/bughunter && git commit -m "feat(node): config schema, profile and target inventory"
```

---

### Task 5: Сессия, снимок, детекторы и оракулы node-пресета

**Files:**
- Create: `presets/node/src/session.ts`, `presets/node/src/snapshot.ts`, `presets/node/src/detectors.ts`, `presets/node/src/checks.ts`, `presets/node/src/json-pointer.ts`, `presets/node/test/harness.ts`
- Test: `presets/node/test/session.bhtest.ts`, `presets/node/test/checks.bhtest.ts`

**Interfaces:**
- Consumes: `Session`, `SessionHandle`, `Snapshot`, `Detectors`, `Checks` из `core/src/preset.ts`; `NodeConfig`, `NodeStep`, `NodeScenario` из задачи 4; `signalSignature` из `@bughunter/core`
- Produces:
  - `presets/node/test/harness.ts`: `export async function startFixture(): Promise<{ baseUrl: string; port: number; stop(): Promise<void> }>` — поднимает `fixtures/node-api-app/src/server.js` дочерним процессом на свободном порту и ждёт строки `listening <port>`
  - `presets/node/src/session.ts`: `export type NodeActInput = { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string; body?: unknown; headers?: Record<string, string> }`; `export type CapturedResponse = { method: string; path: string; status: number; headers: Record<string, string>; body: unknown; raw: string; durationMs: number }`; `export type NodeSessionHandle = SessionHandle & { responses: CapturedResponse[] }`; `export const nodeSession: Session`; `export async function performRequest(handle: NodeSessionHandle, input: NodeActInput, config: NodeConfig): Promise<{ response: CapturedResponse; signals: Signal[] }>`
  - `presets/node/src/snapshot.ts`: `export const nodeSnapshot: Snapshot`
  - `presets/node/src/detectors.ts`: `export const nodeDetectorKinds = ['status', 'stack', 'anomaly'] as const`; `export const nodeDetectors: Detectors`; `export function scanResponse(response: CapturedResponse, config: NodeConfig): Signal[]`
  - `presets/node/src/json-pointer.ts`: `export function readPointer(value: unknown, pointer: string): unknown` — бросает `POINTER_NOT_FOUND: <pointer>`
  - `presets/node/src/checks.ts`: `export const nodeCheckKinds = ['status', 'jsonPath', 'headerContains'] as const`; `export type NodeCheckKind = (typeof nodeCheckKinds)[number]`; `export type NodeCheck = Check & { kind: NodeCheckKind; pointer?: string }`; `export const nodeChecks: Checks`

- [ ] **Step 1: Тесты (RED)**

`presets/node/test/session.bhtest.ts` (на живой фикстуре из `startFixture`): `a request records the response and returns it in the journal step` (`POST /orders` с валидным телом → шаг `kind: 'act'`, в шаге `method`, `path`, `status`, `durationMs`); `a hung endpoint times out and becomes a signal` (эндпоинт фикстуры `GET /slow?ms=<requestTimeoutMs + 500>` — добавить в фикстуру — даёт сигнал вида `status` с сообщением `REQUEST_TIMEOUT` и не висит дольше `requestTimeoutMs + 1s`); `requests outside allowedHosts are blocked before they are sent` (path `http://127.0.0.1:<другой порт>/x` или заголовок `Host` вне `allowedHosts` → `FORBIDDEN_ORIGIN`, запрос не отправлен: счётчик обращений в фикстуре не вырос); `a binary or oversized body does not break the snapshot` (эндпоинт фикстуры `GET /blob` отдаёт 2 МБ не-UTF8 байтов — снимок ограничен, детекторы не падают).
`presets/node/test/checks.bhtest.ts`: `a status check compares the expected code` (`{kind:'status', target:'GET /orders/unknown', expected:404}` нарушен, потому что фикстура отдаёт 200 — N3); `a jsonPath check reads the pointer and compares the value` (`{kind:'jsonPath', target:'POST /orders', pointer:'$.total', expected:0}`); `a jsonPath check on a missing pointer reports the pointer, not a stack` (`POINTER_NOT_FOUND: $.absent`); `a headerContains check reads the header case-insensitively`; `validate rejects a check without a request line` (`CHECK_INVALID`).

- [ ] **Step 2: Убедиться, что падают**

Run: `cd presets/node && node --test test/session.bhtest.ts test/checks.bhtest.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` на `../src/session.ts`, `../src/checks.ts`, `./harness.ts`

- [ ] **Step 3: Реализовать**

Сессия на `fetch` с `AbortSignal.timeout(config.requestTimeoutMs ?? 10_000)`; каждый запрос пишет `CapturedResponse` в `handle.responses` и шаг `NodeStep` в журнал; тело читается текстом, парсится как JSON при `content-type: application/json`, иначе остаётся строкой, а бинарное тело усекается до 64 КБ с пометкой `truncated: true` в снимке. Защита границ: `path` обязан начинаться с `/` (иначе `TARGET_REQUIRED`), а абсолютный URL или `Host` вне `allowedHosts` отклоняются до отправки (`FORBIDDEN_ORIGIN`). `scanResponse` даёт сигналы трёх видов: `status` при `status >= 400` (кроме `detectors.ignoreStatuses`) и при таймауте, `stack` при совпадении тела с признаками стека или `ECONNREFUSED`, `anomaly` по токенам `detectors.anomalyTexts`; сигнатура — `signalSignature({ kind, message, target: '<METHOD> <path>', status })`. `nodeSnapshot.compact` отдаёт инвентарь эндпоинтов, последние ответы (тело усекается до 2 КБ) и новые сигналы. `readPointer` поддерживает `$.a.b[0].c` без зависимостей. `nodeChecks.violated(handle, check)` выполняет запрос из `check.target`, затем сравнивает: `status` — с `expected`, `jsonPath` — `readPointer(body, pointer)` с `expected`, `headerContains` — значение заголовка (регистронезависимо) содержит `expected`.

Добавить в фикстуру два служебных эндпоинта для тестов: `GET /slow?ms=` и `GET /blob`; в `SEEDED.md` они помечены как служебные, а не засеянные баги.

- [ ] **Step 4: GREEN + линии**

Run: `cd presets/node && node --test test/*.bhtest.ts` → `# fail 0`
Run: `cd fixtures/node-api-app && npx vitest run` → зелёные (служебные эндпоинты не сломали реестр)
Run: `cd .qwen/bughunter && npm run typecheck --workspaces --if-present` → 0 ошибок

- [ ] **Step 5: Commit**

```bash
git add .qwen/bughunter && git commit -m "feat(node): http session, detectors and check kinds"
```

---

### Task 6: Повтор журнала, генератор Vitest-теста и раннер

**Files:**
- Create: `presets/node/src/replay.ts`, `presets/node/src/export-vitest.ts`, `presets/node/src/test-runner.ts`
- Test: `presets/node/test/replay.bhtest.ts`, `presets/node/test/export.bhtest.ts`

**Interfaces:**
- Consumes: `Replay`, `ReplayContext`, `ReplayOutcome`, `TestGenerator`, `TestRunner`, `TestRunSummary`, `ExportTarget` из core; `performRequest`, `nodeChecks` из задачи 5; `reproduceCandidate` из core (задача 1)
- Produces:
  - `presets/node/src/replay.ts`: `export const nodeReplay: Replay`
  - `presets/node/src/test-runner.ts`: `export const apiKind = 'api'`; `export const nodeTestKinds = [apiKind, 'unit'] as const`; `export const nodeTestRunner: TestRunner`
  - `presets/node/src/export-vitest.ts`: `export const nodeTestGenerator: TestGenerator`; `export const nodeExportTarget: ExportTarget` (`kind: apiKind`, `dir: (config) => config.tests.generated.dir`, `fileName: (bugId) => \`${bugId}.test.ts\``)

- [ ] **Step 1: Тесты (RED)**

`presets/node/test/replay.bhtest.ts` (на живой фикстуре): `replay reproduces a status violation in a clean session` — кандидат с `check: {kind:'status', target:'GET /orders/unknown', expected:404}` и журналом из одного шага: `nodeReplay.replay(steps, context)` → `matched: true`; `replay applies the reset before the journal` — после «грязного» состояния (созданный заказ) повтор начинается с чистого: `matched` по количеству записей; `replay of a signal-backed candidate matches by signature, not by check`; `replay returns the saved response dumps as artifacts` — `outcome.artifacts` содержит относительные пути под `runs/<runId>/responses/`.
`presets/node/test/export.bhtest.ts`: `the generated test replays the request sequence and asserts one symptom` — сгенерированный исходник содержит `fetch` на каждый шаг журнала, один `expect` на симптом и не содержит `sleep`/`setTimeout`; `the generated test is red on the seeded bug` — запуск сгенерированного файла через `nodeTestRunner.command(apiKind, …)` и `verifyRed` из core даёт вердикт `red`; `export refuses to overwrite an existing file` (`EXPORT_FILE_EXISTS`); `resolveKind returns api for files under tests.generated.dir and unit otherwise`.

- [ ] **Step 2: Убедиться, что падают**

Run: `cd presets/node && node --test test/replay.bhtest.ts test/export.bhtest.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` на `../src/replay.ts`, `../src/export-vitest.ts`, `../src/test-runner.ts`

- [ ] **Step 3: Реализовать**

`nodeReplay.replay(steps, context)`: новая сессия (`nodeSession.open` с `persona: 'replay'`), `nodeReset.apply` при `supported`, последовательное исполнение `NodeStep` через `performRequest`, затем сопоставление: при `candidate.signalIds.length > 0` — совпадение сигнатуры среди собранных сигналов, иначе `nodeChecks.violated(handle, candidate.check)`; в `finally` закрыть сессию; дампы ответов сохранить в `runs/<runId>/responses/<hash>.body` и вернуть их относительные пути как `artifacts`. `abort()` закрывает активную сессию.
Генератор: Vitest-тест без импортов bughunter — только `fetch` к `baseUrl` из конфига, повтор шагов журнала по порядку, сброс состояния перед прогоном (`POST /__reset`), один `expect` на симптом (статус, значение по указателю или заголовок), `test.setTimeout` вместо ожиданий. Раннер: команда `npx vitest run <file> --reporter=json --outputFile=<report>`, `parseReport` → `TestRunSummary` (`singleFile` — по одному файлу в отчёте, `assertionFailuresOnly` — все падения имеют `failureMessages`, `cleanPass` — нет `todo`/`skipped` и `numTotalTests > 0`), `ownsProject(packageJson)` — наличие `vitest` в `dependencies` или `devDependencies`.

- [ ] **Step 4: GREEN + линии**

Run: `cd presets/node && node --test test/*.bhtest.ts` → `# fail 0`
Run: `cd .qwen/bughunter && npm run typecheck --workspaces --if-present` → 0 ошибок

- [ ] **Step 5: Commit**

```bash
git add .qwen/bughunter && git commit -m "feat(node): replay, vitest export and test runner"
```

---

### Task 7: Обход, сброс стенда, находки, персоны, отчёт и коды ошибок

**Files:**
- Create: `presets/node/src/reset.ts`, `presets/node/src/finding-kinds.ts`, `presets/node/src/sweep-visit.ts`, `presets/node/src/personas.ts`, `presets/node/src/report-format.ts`, `presets/node/src/errors.ts`, `presets/node/src/runs.ts`
- Test: `presets/node/test/sweep.bhtest.ts`

**Interfaces:**
- Consumes: `Reset`, `FindingKinds`, `SyntheticStep`, `SweepVisit`, `Personas`, `ReportFormat`, `Errors` из core; `runSweep`, `createRun`, `finishRun`, `promoteFindingToCandidate` из `@bughunter/core`
- Produces:
  - `presets/node/src/reset.ts`: `export const nodeReset: Reset`
  - `presets/node/src/finding-kinds.ts`: `export const nodeFindingKindsList = ['request-failed', 'status-unexpected', 'body-anomaly', 'expectation-mismatch', 'reset-unsupported'] as const`; `export const nodeFindingKinds: FindingKinds`
  - `presets/node/src/sweep-visit.ts`: `export const nodeSweepSession: Session` (read-only: `act` бросает `SWEEP_SESSION_READ_ONLY`); `export const nodeSweepVisit: SweepVisit`; `export async function runSweep(input: { runId: string; stateDir: string; limit?: number; cursor?: number }): Promise<SweepResult>`
  - `presets/node/src/personas.ts`: `export const NODE_PERSONAS = ['интегратор', 'ревизор', 'нетерпеливый'] as const`; `export const nodePersonas: Personas`
  - `presets/node/src/report-format.ts`: `export const nodeReportFormat: ReportFormat`
  - `presets/node/src/errors.ts`: `export const nodeDomainCodes = ['ENDPOINT_NOT_FOUND', 'REQUEST_TIMEOUT', 'POINTER_NOT_FOUND', 'SCENARIO_INVALID', 'TARGET_REQUIRED', 'BODY_INVALID', 'RESET_FAILED'] as const`; `export const nodeErrors: Errors` (`INVENTORY_EMPTY`/`TARGETS_EMPTY` → `ENDPOINT_NOT_FOUND`)
  - `presets/node/src/runs.ts`: обёртки `createRun`, `leaseNextExploration`, `finishRun`, `promoteFindingToCandidate` с node-значениями по умолчанию

- [ ] **Step 1: Тесты (RED)**

`presets/node/test/sweep.bhtest.ts` (на живой фикстуре): `sweep runs every declared scenario per endpoint and records findings` — 5 эндпоинтов × 4 сценария = 20 визитов, среди находок есть `status-unexpected` (N3) и `body-anomaly` (N6); `sweep checkpoints the cursor after every target and resumes from it` — прерванный на середине обход продолжается с `nextCursor`, а не начинается заново; `sweep applies the reset before each endpoint and reports a missing recipe` — при `reset: null` одна находка `reset-unsupported` на прогон; `an expectation declared in the scenario becomes an expectation-mismatch finding`; `promoting a finding creates a one-step journal and a candidate` — `promoteFindingToCandidate` даёт кандидата с `steps.length === 1` и `target` из находки; `the sweep session refuses interactive actions` (`SWEEP_SESSION_READ_ONLY`).

- [ ] **Step 2: Убедиться, что падают**

Run: `cd presets/node && node --test test/sweep.bhtest.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` на `../src/sweep-visit.ts`

- [ ] **Step 3: Реализовать**

`nodeSweepVisit.visit({ target, handle, stateDir })`: для каждого сценария из `config.scenarios`, у которого `request.path` приводит к шаблону `target` — сброс стенда, запрос, `scanResponse`, сравнение с `scenario.expect` → черновики находок (`FindingDraft` с `targetRef: target`, `widget: '<METHOD> <path>'`, `kind`, `detail`, `responseHashes`). `nodeFindingKinds.syntheticStep(finding, stateDir)` возвращает `{ step, target }`, где `step` — `NodeStep` вида `act` с запросом из `detail`, а `target` — `finding.targetRef`. `nodeReset.apply(handle)` выполняет `config.reset` и бросает `RESET_FAILED: <status>` при не-2xx; `supported` — `config.reset !== null`. `nodeReportFormat.finding` печатает сценарий, статус и указатель; `candidate` — последовательность запросов. Обёртки в `runs.ts` передают `nodePersonas`, `nodeReportFormat`, `nodeExportTarget.kind`, `nodeFindingKinds`.

- [ ] **Step 4: GREEN + линии**

Run: `cd presets/node && node --test test/*.bhtest.ts` → `# fail 0`
Run: `cd core && node --test test/boundary.bhtest.ts` → `# fail 0` (лексика core не задета)
Run: `cd .qwen/bughunter && npm run typecheck --workspaces --if-present` → 0 ошибок

- [ ] **Step 5: Commit**

```bash
git add .qwen/bughunter && git commit -m "feat(node): deterministic sweep, reset, findings and personas"
```

---

### Task 8: Точка входа MCP node-пресета

**Files:**
- Create: `presets/node/src/index.ts`, `presets/node/src/cli-host.ts`
- Test: `presets/node/test/portable.bhtest.ts`

**Interfaces:**
- Consumes: все модули задач 4–7; `assertPreset`, `assertSinglePreset`, `createLifecycle` из `@bughunter/core`
- Produces: `node presets/node/src/index.ts` — stdio MCP-сервер `bughunter` с **16 инструментами**: 11 core (`bh_start_run`, `bh_resume_run`, `bh_explore_next`, `bh_finish_run`, `bh_report_candidate`, `bh_reproduce`, `bh_triage`, `bh_promote_finding`, `bh_export_test`, `bh_detect_tests`, `bh_verify_red`) и 5 пресета (`bh_open`, `bh_state`, `bh_act`, `bh_sweep`, `bh_close`); `export const nodePreset: Preset` в `presets/node/src/preset.ts`

- [ ] **Step 1: Тест (RED)**

`presets/node/test/portable.bhtest.ts` по образцу веб-версии: копирует фикстуру и поставляемое дерево без `node_modules`, `state/runs`, делает `git init`, один `npm ci` в корне workspaces копии, поднимает фикстуру, выполняет stdio-рукопожатие `initialize` → `tools/list` и утверждает: 16 инструментов, имена совпадают с ожидаемым списком, `bh_open` без lease отклоняется `LEASE_REQUIRED`, `bh_start_run` с `scope: 'target'` и целью из инвентаря создаёт прогон, `state/` копии не пересекаётся с `state/` разработчика.

- [ ] **Step 2: Убедиться, что падает**

Run: `cd presets/node && node --test test/portable.bhtest.ts`
Expected: FAIL — `ERR_MODULE_NOT_FOUND` на `../src/index.ts`

- [ ] **Step 3: Реализовать**

`presets/node/src/preset.ts` собирает `nodePreset` из всех 16 слотов и проверяется `assertPreset`. `index.ts` — по образцу веб-точки входа: проверка runtime и зависимостей с дружелюбной подсказкой на stderr (stdout зарезервирован под протокол), `assertSinglePreset(stateDir, 'node')`, регистрация 11 core-инструментов с нейтральными схемами и 5 инструментов пресета со `z.strictObject`, `errorCode`-функция рядом с реестром `nodeErrors`/`nodeDomainCodes`, `bh_open`/`bh_close` — тонкие обёртки над `createLifecycle`, `compactState = nodeSnapshot.compact`.

- [ ] **Step 4: GREEN + линии**

Run: `cd presets/node && node --test test/portable.bhtest.ts` → PASS
Run: `cd .qwen/bughunter && npm test --workspaces --if-present` → `# fail 0`
Run: `node /tmp/handshake.mjs <копия>` или встроенная в тест проверка → 16 инструментов

- [ ] **Step 5: Commit**

```bash
git add .qwen/bughunter && git commit -m "feat(node): mcp entry point with sixteen tools"
```

---

### Task 9: Промпт-слой node-пресета

**Files:**
- Create: `presets/node/agents/bh-explorer.md`, `presets/node/agents/bh-reviewer.md`, `presets/node/agents/bh-test-writer.md`, `presets/node/skills/preset-card/SKILL.md`
- Test: `presets/node/test/prompts.bhtest.ts`

**Interfaces:**
- Consumes: словарь инструментов задачи 8, виды `check` задачи 5, области прогона из core
- Produces: тексты агентов и карта node-пресета; контракт-тест, читающий их **из дерева пакета** (`presets/node/…`), а не из `.qwen/` — живая установка автора остаётся веб-пресетом, а раскладку в `.qwen/` делает установщик фазы D

- [ ] **Step 1: Тест (RED)**

`presets/node/test/prompts.bhtest.ts`: `each agent declares its exact tool allowlist` — explorer: `mcp__bughunter__bh_open`, `bh_state`, `bh_act`, `bh_report_candidate`, `bh_close`, `Skill`; reviewer: `Read`, `Grep`, `Glob`, `mcp__bughunter__bh_triage`, `Skill`; test-writer: `Read`, `Grep`, `Glob`, `Edit`, `Write`, `mcp__bughunter__bh_detect_tests`, `bh_export_test`, `bh_verify_red`, `Skill`; `the preset card lists exactly the five node interaction tools` (раздел «Инструменты пресета», набор токенов `bh_*` равен пяти, `bh_crawl`/`bh_navigate`/`bh_probe` отсутствуют); `the card names the check kinds and the pointer rule` (`status`, `jsonPath`, `headerContains`, правило «`target` — строка запроса `METHOD /path`, `pointer` — указатель JSON или имя заголовка»); `agents invoke the shared core skills` (explorer и reviewer вызывают `bughunter-oracles`, test-writer — `bughunter-red-test`, все — `bughunter-preset-card`); `the explorer knows the three node personas` (`интегратор`, `ревизор`, `нетерпеливый`).

- [ ] **Step 2: Убедиться, что падает**

Run: `cd presets/node && node --test test/prompts.bhtest.ts`
Expected: FAIL — ENOENT на `presets/node/agents/bh-explorer.md`

- [ ] **Step 3: Написать тексты**

Агенты — адаптация веб-версий под HTTP-домен: исследователь получает `runId`, `leaseId`, `target`, персону; работает циклом «`bh_state` → один запрос через `bh_act` → оценка новых сигналов»; регистрирует кандидата только при детерминированном сигнале либо при нарушении, выраженном конкретным `check`; возвращает список `candidateId` либо `RETRY_LATER: EXPLORER_BUSY` / `FAILED: <код>`, и никогда не выдаёт несостоявшееся исследование за «кандидатов нет». Карта пресета: пять инструментов, кому они принадлежат (исследователь против главного агента; `bh_sweep` — главный агент), области прогона, инвентарь эндпоинтов из профиля, виды `check` с правилом указателя, коды ошибок пресета.

- [ ] **Step 4: GREEN + линии**

Run: `cd presets/node && node --test test/*.bhtest.ts` → `# fail 0`
Run: `cd presets/web && node --test test/prompts.bhtest.ts` → `# fail 0` (веб-промпты не задеты)

- [ ] **Step 5: Commit**

```bash
git add .qwen/bughunter && git commit -m "feat(node): agents and preset card"
```

---

### Task 10: Детерминированная приёмка node-пресета

**Files:**
- Create: `presets/node/test/node-api-acceptance.bhtest.ts`, `presets/node/state/profiles/demo/index.ts`
- Modify: `presets/node/package.json` (script `acceptance`)

**Interfaces:**
- Consumes: весь node-пресет; фикстуру задачи 3
- Produces: повторяемая приёмка без модели — обход, промоция, воспроизведение, экспорт, вердикт `red`; измеренный базовый уровень по шести засеянным багам

- [ ] **Step 1: Тест (RED)**

`presets/node/test/node-api-acceptance.bhtest.ts`, весь файл под флагом `BH_NODE_ACCEPTANCE=1` (без флага — `skip`, как в `bi-app-acceptance.bhtest.ts`). Тесты: `sweep covers five endpoints with four scenarios and finds at least four seeded bugs` (находки маппятся на `SEEDED` по эндпоинту и признаку; N5 остаётся ненайденным и это утверждается явно как измеренный пропуск); `every promoted finding reproduces and exports a red vitest test` — для каждой промоции `reproduceCandidate` → `confirmed` после `bh_triage`-эквивалента → `exportTest` → `verifyRed` → вердикт `red`; `the acceptance report lists the measured baseline` — в сгенерированном отчёте есть секция с числом найденных и пропущенных багов; `no false positives on the control endpoint` — `/health` не даёт ни находки, ни кандидата.

- [ ] **Step 2: Убедиться, что падает**

Run: `cd presets/node && BH_NODE_ACCEPTANCE=1 node --test test/node-api-acceptance.bhtest.ts`
Expected: FAIL — профиля `demo` и сценариев в конфиге нет

- [ ] **Step 3: Реализовать**

Профиль `demo` объявляет пять эндпоинтов фикстуры. Конфиг приёмки задаёт четыре сценария на каждый эндпоинт (валидный, пустой, невалидный, граничный) и `reset: { method: 'POST', path: '/__reset' }`. Приёмка проходит полный цикл через публичные обёртки пресета (`createRun('sweep')` → `runSweep` → `promoteFindingToCandidate` → `reproduceCandidate` → `exportTest` → `verifyRed`), без MCP-слоя.

- [ ] **Step 4: GREEN + линии**

Run: `cd presets/node && BH_NODE_ACCEPTANCE=1 node --test test/node-api-acceptance.bhtest.ts` → PASS
Run: `cd .qwen/bughunter && npm test --workspaces --if-present` → `# fail 0`, `# skipped 2` (web-замер стоимости и node-приёмка под флагами)

- [ ] **Step 5: Commit**

```bash
git add .qwen/bughunter && git commit -m "test(node): deterministic acceptance over the seeded api fixture"
```

---

### Task 11: Документация двух пресетов

**Files:**
- Modify: `README.md` (корень), `.qwen/skills/bughunter-core-contract/SKILL.md`, `docs/concept/invariants.md`, `docs/concept/preset-guide.md`, `.qwen/bughunter/README.md`
- Create: `presets/node/README.md`
- Test: `core/test/docs.bhtest.ts` (расширение)

**Interfaces:**
- Consumes: фактическое состояние кода после задач 1–10
- Produces: корневой README описывает два пресета; контракт-скилл больше не обещает того, чего в core нет; операторский README node-пресета

- [ ] **Step 1: Тест (RED)**

Дополнить `core/test/docs.bhtest.ts`: `the root readme names both presets` (в таблице доменов есть колонки или строки `web` и `node`, и обе называют свою единицу исследования — экран и эндпоинт); `the contract skill no longer defers what core already owns` — после переноса воспроизведения в core в разделе «Что объявлено, но ещё не перенесено» **нет** строки про протокол воспроизведения, но остались строки про лимит шагов и `limits.candidatesPerRun`; `the node readme states the install command and the five tools`.

- [ ] **Step 2: Убедиться, что падает**

Run: `cd core && node --test test/docs.bhtest.ts`
Expected: FAIL — node-пресет в README не описан, строка про воспроизведение на месте

- [ ] **Step 3: Написать документацию**

Корневой README: статус с идентификаторами прогонов node-пресета (появятся в задачах 12–13, до тех пор — честно «не пройден»), таблица доменов с двумя пресетами, ссылка на `presets/node/README.md`. Контракт-скилл: раздел «Что объявлено, но ещё не перенесено» сокращается до двух пунктов, строка границы «Воспроизведение» становится фактической, `Replay` описан новой сигнатурой. `docs/concept/invariants.md` — то же сокращение. `docs/concept/preset-guide.md` — второй учебный пример (`presets/node`) как точка отсчёта вместо `presets/web` для HTTP-домена. `presets/node/README.md` — установка, `npm ci`, `.mcp.json` с точкой входа node, конфиг и сценарии, области прогона, пять инструментов, ограничения.

- [ ] **Step 4: GREEN + линии**

Run: `cd core && node --test test/*.bhtest.ts` → `# fail 0`
Run: `cd .qwen/bughunter && npm test --workspaces --if-present` → `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add README.md docs .qwen && git commit -m "docs: describe two presets and the honest core boundary"
```

---

### Task 12: Модельный прогон node-пресета

**Files:**
- Create: `.superpowers/sdd/<workspace>/node-model-run.sh`, отчёт `docs/superpowers/reports/<дата>-node-preset-model-run.md`

**Interfaces:**
- Consumes: весь node-пресет, документацию задачи 11
- Produces: доказательство критериев приёмки 6.7.2–6.7.4

- [ ] **Step 1: Собрать одноразовую копию**

`bughunter-gate/node-model/project` — **вне** `.qwen/`: фикстура `node-api-app` с `npm ci`, поставляемое дерево (`core`, `presets/node`), `npm ci` в корне workspaces, `.mcp.json` с точкой входа `presets/node/src/index.ts`, в `.qwen/agents/` — агенты node-пресета, в `.qwen/skills/bughunter-preset-card/` — карта node-пресета (имя карты постоянно, содержимое пресетное), точечный allow-list в `.qwen/settings.json` копии, стенд фикстуры на свободном порту `127.0.0.1`, `config.json` копии — с этим портом и пятью эндпоинтами.

- [ ] **Step 2: Прогон**

```bash
cd "$GATE" && caffeinate -i qwen -p '/bughunter full' --output-format stream-json \
  --no-session-persistence --allowed-mcp-server-names bughunter \
  > ../node-model.stdout.jsonl 2> ../node-model.stderr.log
```
Ожидаемо: 15 задач очереди (5 эндпоинтов × 3 персоны), бюджет ~4 ч, exit 0.

- [ ] **Step 3: Проверить критерии своими чтениями**

По JSONL: assistant-сообщений с более чем одним `tool_use` → **0**; чередование `bh_explore_next` → ровно один `Agent(bh-explorer)`; `bh_triage`/`bh_export_test`/`bh_verify_red` только внутри субагентов. По `run.json`: `finished`, все стадии `done`, `Pending: None`. По кандидатам: **≥ 4 из 6** засеянных багов подтверждены, **0** подтверждённых ложных срабатываний, N5 опубликован как измеренный пропуск. По тестам: на каждый подтверждённый баг Vitest-тест с вердиктом `red`, перепроверенный собственным запуском `npx vitest run <файл>`, а не со слов модели.

- [ ] **Step 4: Отчёт и очистка**

Отчёт в `docs/superpowers/reports/`: run id, счётчики, путь к JSONL, вывод собственных запусков тестов, отклонения. Доказательства (JSONL, `run.json`, `report.md`, кандидаты, тесты) изъять в `presets/node/state/runs/node-model/` до удаления копии; стенд остановить тем же PID, который поднят скриптом; копию удалить.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/reports && git commit -m "docs: record the node preset model run"
```

---

### Task 13: Приёмка гайдлайнов свежим агентом (спецификация 6.8)

**Files:**
- Create: `.superpowers/sdd/<workspace>/guidelines-check.sh`, отчёт `docs/superpowers/reports/<дата>-guidelines-acceptance.md`, `docs/concept/examples/cli-preset/` (сохранённый игрушечный пресет)

**Interfaces:**
- Consumes: **только** поставляемые скиллы и примеры (`bughunter-core-contract`, `bughunter-preset-guide`, `bughunter-preset-card`, `bughunter-oracles`, `bughunter-red-test`, `presets/web`, `presets/node`, `docs/concept/*`)
- Produces: вердикт о пригодности гайдлайнов и список конкретных мест, где агенту пришлось угадывать

- [ ] **Step 1: Харнесс**

Отдельный headless-процесс `qwen -p` в одноразовой копии `bughunter-gate/guidelines-check/` (вне `.qwen/`), поставка читается из копии, результат пишется туда же. Действий пользователя не требуется: сервер называется `bughunter` и уже разрешён по имени в user settings.

- [ ] **Step 2: Задание агенту**

Собрать игрушечный пресет для нового вида цели — «CLI-утилита: запуск с аргументами, проверка stdout и кода выхода». Мини-фикстуру агент берёт из snippet'а в `bughunter-preset-guide` (CLI-учёт заказов с четырьмя засеянными багами), а не из `fixtures/`. Оракулы этого пресета включают `stdout` и `exitCode` — то, что веб- и node-пресетам не нужно: цель владеет процессом, поэтому детекторы читают stderr, stdout и код выхода.

- [ ] **Step 3: Доказательство работы**

stdio-рукопожатие скриптом по образцу `portable.bhtest.ts` (инструменты перечислены, состав соответствует заявленному) плюс один модельный прогон на мини-фикстуре в копии, где `.mcp.json` настроен с самого начала. Критерий: прогон завершился `finished`, нашёл не меньше трёх из четырёх засеянных багов, 0 подтверждённых ложных, red-тест перепроверен независимым запуском.

- [ ] **Step 4: Цикл при провале**

До двух итераций, каждая со свежим агентом и свежей копией. Провал трактуется как **дефект гайдлайнов**: в отчёт пишется конкретное место (скилл, раздел, строка), где агенту пришлось угадывать, и правка вносится в скилл, а не в агента.

- [ ] **Step 5: Артефакт и commit**

Отчёт в `docs/superpowers/reports/`, игрушечный пресет сохраняется в `docs/concept/examples/cli-preset/` как второй учебный пример; в `presets/` он не попадает — это не поддерживаемый пресет.

```bash
git add docs && git commit -m "docs: record the guidelines acceptance and keep the toy preset as an example"
```

---

## Self-Review

**1. Покрытие спецификации.** 6.2 (`reproduce-protocol` в core) → задача 1. 6.3 (16 интерфейсов, пять вопросов, девять хуков) → задачи 1, 2 (web) и 4–7 (node). 6.4 (11 core + 5 preset инструментов у node) → задача 8. 6.5 (раскладка, workspaces, один `npm ci`) → задача 3. 6.6 (скиллы core / агенты и карта пресета) → задача 9. 6.7 (объём, фикстура, N1–N6, N5 как заведомый пропуск, N4 без нового механизма, персоны, безопасность и сброс, sweep, экспорт Vitest, двухслойная приёмка, критерии 1–5) → задачи 3, 5–7, 10, 12; критерий 1 проверяется в задачах 3–10 диффом и тестом направления импортов, критерий 5 — задачей 13. 6.8 (приёмка гайдлайнов) → задача 13. 6.9 (поля конфига node: `baseUrl`, `allowedHosts`, `scenarios`, `reset`) → задача 4. 6.10 (нейтральная лексика) → наследуется от фазы A, проверяется `boundary.bhtest.ts` в задаче 7. Вне плана остаются 6.12 (дистрибуция, `init`, публикация) и оракул сверки данных — фаза C и D.

**2. Сканирование шагов.** Каждый шаг — одно действие с проверяемым результатом. Тела приводятся только там, где алгоритм не определён сигнатурой и тестом: `readPointer` (синтаксис указателя), `parseReport` для Vitest (поля `TestRunSummary`), правило сопоставления в `nodeReplay` (сигнатура против `check`). Остальное — сигнатуры, пути, значения из спецификации и утверждения тестов.

**3. Согласованность имён.** `ReplayOutcome`, `ReplayContext`, `Replay` (задача 1) используются в задаче 6 как `nodeReplay: Replay`. `reproductionBudget`, `replayAndMinimize`, `reproduceCandidate` (задача 1) вызываются в задачах 6 и 10. `NodeStep`, `NodeActInput`/`CapturedResponse`, `NodeScenario`, `EndpointEntry`, `NodeConfig`, `NodeProfile` (задачи 4–5) используются в 6, 7, 10. `nodeCheckKinds`/`NodeCheck` (задача 5) — в 6 и 9. `apiKind`/`nodeTestKinds`/`nodeExportTarget` (задача 6) — в 7 (`runs.ts`) и 8. `nodeFindingKindsList` (задача 7) — в 7 и 10. `nodePreset` (задача 8) — в 8 и 10. `NODE_PERSONAS` (задача 7) — в 7, 9, 12.

**4. Review Focus.** «Висящий стенд» → задача 5, `a hung endpoint times out and becomes a signal`. «Уход за пределы стенда» → задача 5, `requests outside allowedHosts are blocked before they are sent`. «Незаполненный хук» → задача 2, `shipped presets wire every hook of the contract` + `core/test/contract-usage.bhtest.ts`. «Чужой пресет на том же state» → задача 4, `the node preset refuses a state dir owned by another preset`. «`jsonPath` на отсутствующем указателе» → задача 5, `a jsonPath check on a missing pointer reports the pointer, not a stack`.

**5. Пропорции.** Спецификация — ~370 строк, из них на фазу B приходятся §6.7 (≈40 строк) и §6.8 (≈10); план — 13 задач на 5 разделов кода (core-перенос, каркас и фикстура, HTTP-домен пресета, MCP-слой, промпты и приёмки). Код в плане — только сигнатуры, имена, значения из спецификации и утверждения тестов; тел функций нет, кроме трёх алгоритмов, которые тестами не определяются.

## Отклонения от спецификации, заложенные в план (требуют `Ruling:` при исполнении)

- **Детекторы node-пресета — только HTTP.** В таблице 6.3 для node названы `uncaughtException`, `unhandledRejection`, `stderr` и код выхода; пресет не владеет процессом стенда (стенд поднимается снаружи, как vite-демо в web), поэтому эти источники недоступны. Все шесть засеянных багов N1–N6 обнаруживаются по HTTP (статус, стек в теле, внутренние токены), то есть критерий 6.7.2 не страдает. Детекторы процесса появятся там, где пресет запускает цель сам, — в игрушечном CLI-пресете задачи 13.
- **Вид `check` `stdout` из таблицы 6.3 в node-пресете не реализуется** по той же причине; он реализуется в CLI-пресете приёмки гайдлайнов. Виды node-пресета: `status`, `jsonPath`, `headerContains`.
- **Поля конфига шире списка 6.9**: добавлены `requestTimeoutMs` и `detectors` (первое нужно для Review Focus «висящий стенд», второе — для детекторов аномальных токенов). Общие поля не затрагиваются.
- **Агенты и карта node-пресета живут в `presets/node/{agents,skills}`**, а не в `.qwen/`: живая установка автора остаётся веб-пресетом, а в `.qwen/` их раскладывает установщик фазы D и харнесс модельного прогона задачи 12. Контракт-тест читает тексты из дерева пакета.
