# Bughunter core/preset split (фаза A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Разрезать доказанный веб-инструмент на доменно-нейтральный `core` и `presets/web`, не изменив его поведения, и закрепить границу тестами.

**Architecture:** Монорепо: `core/` — библиотека (прогоны, кандидаты, журнал, lease, триаж, память, вердикты тестов, отчёт), `presets/web/` — точка входа MCP-сервера и всё веб-специфичное. Пресет реализует 16 именованных интерфейсов контракта; core знает только контракт. Направление импортов строго `preset → core`.

**Tech Stack:** Node ≥ 22.18 (type stripping, без сборки), TypeScript ESM, `@modelcontextprotocol/sdk`, `zod`, `playwright-core` (только пресет), `node:test` (`*.bhtest.ts`, `--test-concurrency=1`).

**Spec:** `docs/superpowers/specs/2026-11-13-bughunter-core-and-presets-design.md` (утверждён 2026-11-13). Разделы, которыми план оперирует напрямую: 6.2 (состав core), 6.3 (контракт), 6.4 (инструменты), 6.5 (раскладка), 6.6 (промпты), 6.10 (разрыв схемы), 6.11 (route-репетиция).

## Global Constraints

- Поведение веб-пресета не меняется. Исключение — осознанный однократный разрыв схемы `state/*.json` и `config.json` (спецификация 6.10), миграция не пишется.
- Базовая линия до начала: `env -u PLAYWRIGHT_BROWSERS_PATH npm test` → **253 pass, 0 fail, 1 skipped (254)**, `npm run typecheck` → 0 ошибок. Каждый шаг, меняющий код, заканчивается зелёной линией: **`fail 0` и `skipped 1`**, а не буквальное число 253 — оно растёт на число тестов, добавленных предыдущими задачами.
- Зависимости: core — только `@modelcontextprotocol/sdk` и `zod`; `playwright-core` живёт исключительно в `presets/web/package.json`. Новых рантайм-зависимостей не появляется.
- Запуск без сборки: все файлы остаются `.ts` с стираемым синтаксисом (`import type`, никаких enum/namespace/параметров-свойств).
- **Core не вычисляет `stateDir` сам.** Все функции core принимают `stateDir: string` обязательным параметром; единственный резолвер по умолчанию — `presets/web/src/paths.ts`. Это устраняет сегодняшнее расхождение (`run-store.ts:9` и `config.ts:7` — `../../state`, `reproduce.ts:16` и `sweep.ts:22` — `../state`).
- В `core/**` запрещена доменная лексика (список в задаче 10). Промпты — на русском, агенты без поля `model`, без дальнейшего делегирования.
- Контракт инструментов зашит в `test/prompts.bhtest.ts` и `test/portable.bhtest.ts`: переименование инструмента или поля требует синхронной правки тестов, промптов и README в том же коммите.
- Каталоги `.qwen/` чувствительны к записи для CLI: одноразовые копии для модельных прогонов создаются в `bughunter-gate/`, не в `.qwen/`.
- Ничего не коммитится и не публикуется автоматически; `state/runs/**`, `state/auth/**`, `bughunter-gate/**` в коммит не попадают.
- Номера строк в задачах 5–13 указаны по состоянию дерева **до** задач 1–4 и после переносов сместились: ориентироваться на имена функций и модулей, номера строк — только как приблизительный указатель.
- Спецификация считает 14 интерфейсов; план называет **16 типов**: строка `Check + Replay + TestGenerator` развёрнута в три типа, `ProfileSchema` выделен отдельно. Расхождение содержательным не является.

## Review Focus

- **Старый `config.json` после разрыва схемы.** Пользователь запускает инструмент в проекте с конфигом прежней формы и обязан получить одну понятную ошибку с путём и именем поля, а не стек zod. Тест: задача 9, `config with a legacy field name is rejected naming the field`.
- **Пресет с недостающим хуком.** Сервер обязан упасть на старте с `PRESET_INVALID: <имя хука>`, а не в середине прогона. Тест: задача 2, `assertPreset rejects a preset without a required hook`.
- **Два пресета в одном проекте.** Ожидается явная ошибка `PRESET_CONFLICT`, а не молчаливая порча общего `state/`. Тест: задача 2, `assertSinglePreset rejects a second preset in the same state dir`.
- **Случайная зависимость core от пресета.** Тест границы обязан назвать файл и строку импорта, а не просто упасть. Тест: задача 10, `core does not import presets`.
- **Модель вызывает переименованный инструмент.** Контракт-тест промптов обязан ловить старое имя `bh_export_e2e` в любом промпте. Тест: задача 8, `prompts do not mention the retired tool name`.
- **Установка в чужой проект в новой раскладке.** `portable`-рукопожатие обязано работать одним `npm ci` и видеть 19 инструментов. Тест: задача 1, обновлённый `portable.bhtest.ts`.

---

### Task 1: Монорепо-скелет и перенос дерева в `presets/web`

**Files:**
- Create: `.qwen/bughunter/package.json` (корень workspaces — не корень репозитория), `.qwen/bughunter/core/package.json`, `presets/web/src/paths.ts`
- Modify: `.mcp.json`, `.gitignore`, `.qwen/bughunter/.gitignore`, `presets/web/test/portable.bhtest.ts`
- Move: `.qwen/bughunter/server/src/**` → `.qwen/bughunter/presets/web/src/**`; `.qwen/bughunter/server/test/**` → `.qwen/bughunter/presets/web/test/**`; `.qwen/bughunter/server/fixtures/**` → `.qwen/bughunter/fixtures/**`; `.qwen/bughunter/server/state` → `.qwen/bughunter/presets/web/state`; `.qwen/bughunter/server/{package.json,tsconfig.json}` → `presets/web/`; `package-lock.json` пресета удаляется — lock regenerates в корне workspaces

**Interfaces:**
- Consumes: —
- Produces: `presets/web/src/paths.ts` → `export const defaultStateDir: string` (единственный резолвер: `resolve(import.meta.dirname, '../state')`); раскладка каталогов, на которую ссылаются все последующие задачи.

- [ ] **Step 1: Проба способа импорта core (10 минут, до всякого переноса)**

Во временном каталоге вне репозитория: `core/package.json` с `"name": "@bughunter/core"`, `"type": "module"`, `"exports": { ".": "./src/index.ts" }` и файлом `src/index.ts`, экспортирующим тип и функцию; рядом `app/package.json` с `"dependencies": { "@bughunter/core": "file:../core" }` и `app/index.ts`, импортирующим `@bughunter/core`. Выполнить `cd app && npm install --no-audit --no-fund && node index.ts`.

Ожидаемо: `node index.ts` печатает результат — type stripping работает через симлинк, потому что Node резолвит realpath вне `node_modules`. Если вывод содержит ошибку про typescript/strip-types — **ветвь Б**: пресет импортирует core относительными путями (`../../../core/src/…`), корневой `package.json` с workspaces не создаётся, а в леджер вносится `Ruling: workspace-импорт невозможен под type stripping — относительные пути`. Дальнейшие задачи от ветви не зависят.

- [ ] **Step 2: Зафиксировать базовую линию**

Run: `cd .qwen/bughunter/server && env -u PLAYWRIGHT_BROWSERS_PATH npm test 2>&1 | tail -5`
Expected: `# pass 253`, `# fail 0`, `# skipped 1`

Run: `npm run typecheck`
Expected: 0 ошибок

- [ ] **Step 3: Перенести дерево (`git mv`), не меняя кода**

Перенос по списку в **Files**. В `presets/web/src/**` исправить только пути импортов и пути к фикстурам/state; логику не трогать. Корневой `package.json` (ветвь А):

```json
{ "name": "bughunter", "private": true, "type": "module",
  "workspaces": ["core", "presets/web"],
  "scripts": { "test": "npm test --workspace @bughunter/web", "typecheck": "npm run typecheck --workspace @bughunter/web" } }
```

`core/package.json`: `name` `@bughunter/core`, `type: module`, `exports` → `./src/index.ts`, зависимости `@modelcontextprotocol/sdk` и `zod`, скрипт `test` → `node --test --test-concurrency=1 test/*.bhtest.ts` (каталог `core/test/` создаётся пустым с `.gitkeep` в задаче 2).

`.mcp.json`: `args` → `[".qwen/bughunter/presets/web/src/index.ts"]`.

- [ ] **Step 4: Единый резолвер stateDir**

Создать `presets/web/src/paths.ts` с `export const defaultStateDir = resolve(import.meta.dirname, '../state');` и заменить им все четыре сегодняшних вычисления (`run-store.ts:9`, `config.ts:7`, `reproduce.ts:16`, `sweep.ts:22` — после переноса это файлы `presets/web/src/**`), передавая значение аргументом.

- [ ] **Step 5: Обновить `portable.bhtest.ts` под новую раскладку**

Тест копирует дерево в одноразовый каталог и поднимает stdio MCP. Изменить источник копии на `presets/web` + `core`, установку — на один `npm ci` в `presets/web` (ветвь А ставит core симлинком), путь точки входа — на `presets/web/src/index.ts`. Число инструментов остаётся **19**.

- [ ] **Step 6: Проверить зелёную линию и рукопожатие**

Run: `cd .qwen/bughunter/presets/web && npm ci --no-audit --no-fund && env -u PLAYWRIGHT_BROWSERS_PATH npm test 2>&1 | tail -5`
Expected: `# pass 253`, `# fail 0`, `# skipped 1`

Run: `npm run typecheck && node --test test/portable.bhtest.ts 2>&1 | tail -3`
Expected: 0 ошибок typecheck; `# pass 1` (или текущее число тестов файла), `# fail 0`

- [ ] **Step 7: Commit**

```bash
git add -A .qwen/bughunter core presets/web package.json .mcp.json .gitignore
git commit -m "refactor: move the web tool into presets/web and scaffold the core workspace"
```

---

### Task 2: Контракт пресета

**Files:**
- Create: `core/src/preset.ts`, `core/src/index.ts`, `core/tsconfig.json`, `core/test/preset-contract.bhtest.ts`
- Move: `presets/web/src/types.ts` → `core/src/types.ts` (без изменений содержимого: доменная лексика в литералах вычищается в задаче 9, но типы нужны всем последующим задачам уже здесь)
- Modify: `presets/web/src/index.ts` (регистрация пресета), `presets/web/test/portable.bhtest.ts` (если меняется число инструментов — не меняется)

**Interfaces:**
- Consumes: `presets/web/src/paths.ts` → `defaultStateDir`
- Produces: `core/src/preset.ts` — 16 типов контракта (ниже) и `export function assertPreset(preset: unknown): Preset` (бросает `PRESET_INVALID: <поле>`), `export function assertSinglePreset(stateDir: string, presetName: string): Promise<void>` (бросает `PRESET_CONFLICT: <stateDir>`). Все последующие задачи расширяют `Preset`, не переопределяя его.

```ts
export type TargetRef = string;
export type StepEnvelope = { id: string; kind: string; timestamp: string; targetRef: TargetRef; signalIds: string[]; responseHashes?: string[]; payload: unknown };
export type CheckEnvelope = { kind: string; target: string; expected?: string | number };

export type TargetInventory = { list(stateDir: string): Promise<TargetRef[]>; templateOf(value: string): TargetRef };
export type SessionHandle = { id: string; snapshot(): Promise<unknown>; act(payload: unknown): Promise<unknown>; steps(): StepEnvelope[]; artifacts(): string[]; close(): Promise<void> };
export type Session = { open(input: { runId: string; target: TargetRef; persona: string; stateDir: string }): Promise<SessionHandle> };
export type Snapshot = { compact(value: unknown): unknown };
export type Detectors = { kinds: string[]; scan(handle: SessionHandle): Promise<Signal[]> };
export type Checks = { kinds: string[]; validate(check: CheckEnvelope): void; violated(handle: SessionHandle, check: CheckEnvelope): Promise<boolean> };
export type Replay = { replay(steps: StepEnvelope[], input: { target: TargetRef; persona: string; stateDir: string }): Promise<boolean> };
export type TestGenerator = { generate(input: { candidate: Candidate; initialTarget: TargetRef; stateDir: string }): Promise<string> };
export type ProfileSchema = { load(stateDir: string, name: string): Promise<unknown>; testDataFile(profile: unknown, relativePath: string): string };
export type TestRunner = { detect(projectRoot: string, target: string): Promise<string | null>; command(kind: string, projectRoot: string, testFile: string, reportFile: string): string[]; parseReport(kind: string, raw: unknown): { passed: number; failed: number; assertionFailed: boolean }; ownsProject(packageJson: unknown): boolean; kinds: string[] };
export type Personas = { roster: readonly string[]; brief(persona: string): string };
export type FindingKinds = { kinds: string[]; syntheticStep(finding: Finding): StepEnvelope };
export type SweepVisit = { visit(input: { target: TargetRef; handle: SessionHandle; stateDir: string }): Promise<Finding[]> };
export type Reset = { supported: boolean; apply(handle: SessionHandle): Promise<void> };
export type ExportTarget = { dir(config: Config): string; kind: string; fileName(bugId: string): string };
export type Errors = { codes: Record<string, string> };
export type ReportFormat = { finding(finding: Finding): string[]; candidate(candidate: Candidate): string[] };

export type Preset = {
  name: string;
  configSchema: unknown;                     // zod-схема полей config.json, принадлежащих пресету
  inventory: TargetInventory; session: Session; snapshot: Snapshot; detectors: Detectors;
  checks: Checks; replay: Replay; generateTest: TestGenerator; profile: ProfileSchema;
  testRunner: TestRunner; personas: Personas; findingKinds: FindingKinds;
  sweepVisit: SweepVisit; reset: Reset; exportTarget: ExportTarget; errors: Errors; report: ReportFormat;
};
```

- [ ] **Step 1: Тест контракта (RED)**

`core/test/preset-contract.bhtest.ts`, три теста: `assertPreset accepts a preset implementing all sixteen interfaces` (стаб-объект со всеми полями → возвращается тот же объект); `assertPreset rejects a preset without a required hook` (удалить `testRunner` → `assert.throws(/PRESET_INVALID: testRunner/)`); `assertSinglePreset rejects a second preset in the same state dir` (записать `preset.json` с именем `web`, вызвать с `node` → `assert.throws(/PRESET_CONFLICT/)`).

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd core && node --test test/preset-contract.bhtest.ts`
Expected: FAIL — `Cannot find module '…/core/src/preset.ts'`

- [ ] **Step 3: Реализовать `core/src/preset.ts` и `core/src/index.ts`**

`assertPreset` проверяет присутствие каждого из 17 полей `Preset` (включая `name` и `configSchema`) и бросает `PRESET_INVALID: <имя поля>` на первом отсутствующем. `assertSinglePreset` читает/пишет `<stateDir>/preset.json` (`{ "name": string }`, атомарно через `writeJsonAtomic`) и бросает `PRESET_CONFLICT: <stateDir>`, если имя уже другое. `core/src/index.ts` реэкспортирует `preset.ts` — это точка `exports` пакета.

- [ ] **Step 4: GREEN**

Run: `cd core && node --test test/preset-contract.bhtest.ts`
Expected: `# pass 3`, `# fail 0`

- [ ] **Step 5: Зарегистрировать веб-пресет**

В `presets/web/src/index.ts` на старте сервера: собрать объект `webPreset` (поля-заглушки допустимы для ещё не вынесенных хуков — они заполняются в задачах 3–8) и вызвать `assertPreset(webPreset)` + `await assertSinglePreset(stateDir, 'web')` до регистрации инструментов.

- [ ] **Step 6: Полная зелёная линия и commit**

Run: `cd presets/web && env -u PLAYWRIGHT_BROWSERS_PATH npm test 2>&1 | tail -3` → `# pass 253`, `# fail 0`

```bash
git add core presets/web && git commit -m "feat(core): define the preset contract and validate it at server start"
```

---

### Task 3: `TestRunner` — Playwright уходит из вердиктов

**Files:**
- Create: `presets/web/src/test-runner.ts`, `core/src/verify-red.ts`, `core/src/detect.ts`
- Move: `presets/web/src/project.ts` → `core/src/project.ts`, `presets/web/src/cli-host.ts` → `core/src/cli-host.ts` (первые core-модули, которым они нужны)
- Modify: `presets/web/src/tests/verify-red.ts` (удаляется), `presets/web/src/tests/detect.ts` (удаляется), `presets/web/src/index.ts`
- Test: `core/test/verify-red.bhtest.ts` (перенос из `presets/web/test/verify-red.bhtest.ts`), `core/test/detect.bhtest.ts`

**Interfaces:**
- Consumes: `TestRunner` из задачи 2
- Produces: `core/src/verify-red.ts` → `export async function verifyRed(testFile: string, options: { stateDir: string; runner: TestRunner; timeoutMs?: number; unitCommand?: string | null; kind?: string }): Promise<Verdict>`; `core/src/detect.ts` → `export async function detectTests(inputPath: string, options: { runner: TestRunner; unitCommand?: string | null }): Promise<{ framework: string | null; command: string | null; examples: string[] }>`. `Verdict` остаётся прежней формы (`status: 'red' | 'green' | 'broken'`, `message`, …).

- [ ] **Step 1: Тест с стаб-раннером (RED)**

В `core/test/verify-red.bhtest.ts` тест `verdict classification comes from the runner, not from a framework`: стаб-`TestRunner`, чей `parseReport` возвращает `{ passed: 0, failed: 1, assertionFailed: true }` → `verifyRed` даёт `red`; `assertionFailed: false` при `failed: 1` → `broken`; `failed: 0` → `green`. Плюс `command is taken from the runner` (проверка, что spawned-команда равна `runner.command(…)`).

- [ ] **Step 2: Убедиться, что падает**

Run: `cd core && node --test test/verify-red.bhtest.ts`
Expected: FAIL — модуль `core/src/verify-red.ts` не найден

- [ ] **Step 3: Перенести логику, вырезав Playwright**

Из `presets/web/src/tests/verify-red.ts` в `core/src/verify-red.ts` переезжают: дедлайны, `mkdtemp` для отчёта, `nearestPackageRoot`, классификация `red | green | broken`, ограничение `message` 1500 символами. В `presets/web/src/test-runner.ts` уезжают `Framework = …|'playwright'`, `classifyPlaywrightReport` (:190-249), ветка `kind === 'e2e'` с `stat(node_modules/@playwright/test/…)`, `npm exec -- playwright test`, `PLAYWRIGHT_JSON_OUTPUT_FILE` (:267-275). То же для `detect.ts`: определение jest/vitest — в core, `playwright` как фреймворк — в раннер пресета.

- [ ] **Step 4: GREEN + полная линия**

Run: `cd core && node --test test/verify-red.bhtest.ts test/detect.bhtest.ts` → `# fail 0`
Run: `cd presets/web && env -u PLAYWRIGHT_BROWSERS_PATH npm test 2>&1 | tail -3` → `# pass 253`, `# fail 0`, `# skipped 1`

- [ ] **Step 5: Commit**

```bash
git add core presets/web && git commit -m "refactor(core): extract the test runner hook so verdicts carry no playwright"
```

---

### Task 4: `Personas` и `ReportFormat` — `run-store` без веба

**Files:**
- Create: `core/src/run-store.ts`, `presets/web/src/personas.ts`, `presets/web/src/report-format.ts`
- Move: перенос `config.ts` в core **перенесён в задачу 9** — делить поля на общие и preset-специфичные и переименовывать их нужно одним движением, иначе файл пришлось бы резать дважды
- Modify: `presets/web/src/run-store.ts` (удаляется), `presets/web/src/index.ts`
- Test: `core/test/run-store.bhtest.ts` (новые тесты), перенос `presets/web/test/{explore-queue,report-resume,config-store}.bhtest.ts` в `core/test/` там, где они проверяют core-логику

**Interfaces:**
- Consumes: `Personas`, `ReportFormat` из задачи 2
- Produces: `core/src/run-store.ts` — те же экспорты, что сегодня (`createRun`, `leaseNextExploration`, `validateExplorationLease`, `completeExplorationLease`, `releaseExplorationLease`, `reclaimExplorationLeases`, `readRun`, `updateRun`, `recordRunStage`, `recordRouteExploration`, `readCandidate`, `findingPath`, `readFindings`, `writeFinding`, `resumeRun`, `recordCandidateTest`, `readSharedMemory`, `triageCandidate`, `finishRun`, `writeJsonAtomic`, `SharedMemoryEntry`, `TriageInput`, `ExploreNextResult`), но: `stateDir: string` обязателен везде, `EXPLORER_PERSONAS` удалён, а функции, которым нужен ростер или рендер, принимают их параметром — `createRun(input: { …; personas: readonly string[] })`, `finishRun(runId: string, stateDir: string, report: ReportFormat)`.

- [ ] **Step 1: Тесты (RED)**

`core/test/run-store.bhtest.ts`: `the persona roster comes from the caller` (два разных ростера → разные очереди задач); `findings are rendered by the preset formatter` (стаб-`ReportFormat` возвращает `['X']` → отчёт содержит `X` и не содержит `Widget:`); `recordCandidateTest accepts an arbitrary kind string` (`kind: 'api'` сохраняется и читается обратно).

- [ ] **Step 2: Убедиться, что падают**

Run: `cd core && node --test test/run-store.bhtest.ts`
Expected: FAIL — модуль не найден

- [ ] **Step 3: Перенести и вырезать**

`EXPLORER_PERSONAS` (`run-store.ts:126`) → `presets/web/src/personas.ts` как `roster: ['новичок', 'нетерпеливый', 'граничный ввод']` и `brief(persona)`. Рендер доменной части находки (`:621-628`, `### ${finding.kind}: ${finding.screenTemplate}`, `- Widget: …`) → `presets/web/src/report-format.ts`. `kind: 'e2e' | 'unit'` в `recordCandidateTest` (:442) → `kind: string`. Структура отчёта, счётчики и `Pending:` остаются в core.

- [ ] **Step 4: GREEN + полная линия**

Run: `cd core && node --test test/run-store.bhtest.ts` → `# fail 0`
Run: `cd presets/web && env -u PLAYWRIGHT_BROWSERS_PATH npm test 2>&1 | tail -3` → `# pass 253`, `# fail 0`, `# skipped 1`

- [ ] **Step 5: Commit**

```bash
git add core presets/web && git commit -m "refactor(core): move personas and report formatting into the web preset"
```

---

### Task 5: Сборка кандидата переезжает в core

**Files:**
- Create: `core/src/candidate.ts`, `core/src/signature.ts`
- Modify: `presets/web/src/browser/session.ts` (из `reportCandidate` :447-504, дедупликация :855-871, лимит шагов :815-833, журнал :843-845, артефакты :546-551), `presets/web/src/detectors/signals.ts` (из него уезжают `normalizeMessage` и `signalSignature`), `presets/web/src/index.ts`
- Test: `core/test/candidate.bhtest.ts`, `core/test/signature.bhtest.ts` (перенос соответствующих проверок из `presets/web/test/signals.bhtest.ts`)

**Interfaces:**
- Consumes: `Checks`, `Detectors` из задачи 2; `readSharedMemory`, `writeJsonAtomic` из задачи 4
- Produces: `core/src/candidate.ts` → `export async function reportCandidate(input: { runId: string; sessionId: string; target: TargetRef; title: string; expected: string; actual: string; steps: StepEnvelope[]; signalIds: string[]; artifacts: string[]; check?: CheckEnvelope; stateDir: string; checks: Checks; signatureOf(input: { kind: string; message: string; target: TargetRef; stack?: string }): string }): Promise<{ candidate: Candidate; duplicateOf?: string; suppressed: boolean }>`; бросает `LIMIT_REACHED` и пробрасывает ошибку валидации `check` без поглощения.

- [ ] **Step 1: Тесты (RED)**

`core/test/candidate.bhtest.ts`: `an invalid check surfaces the preset error` (стаб-`Checks.validate` бросает `CHECK_INVALID: …` → та же ошибка наружу, кандидат не записан); `a known signature is marked duplicate and not re-reported`; `a suppressed signature is reported as suppressed`; `step limit throws LIMIT_REACHED before writing`.

- [ ] **Step 2: Убедиться, что падают**

Run: `cd core && node --test test/candidate.bhtest.ts`
Expected: FAIL — модуль не найден

- [ ] **Step 3: Перенести логику**

Веб-часть (`page.locator(…).count()` для `elementCount`, вычисление сигналов) остаётся в пресете и приходит через `Checks.validate`/`Checks.violated` и готовые `signalIds`. Пустой `catch`, из-за которого невалидный селектор раньше проглатывался, не воспроизводится: ошибка `validate` пробрасывается.

- [ ] **Step 4: GREEN + полная линия**

Run: `cd core && node --test test/candidate.bhtest.ts` → `# fail 0`
Run: `cd presets/web && env -u PLAYWRIGHT_BROWSERS_PATH npm test 2>&1 | tail -3` → `# pass 253`, `# fail 0`, `# skipped 1`

- [ ] **Step 5: Commit**

```bash
git add core presets/web && git commit -m "refactor(core): own candidate assembly, dedup and limits"
```

---

### Task 6: Lease-фасад жизненного цикла сессии

**Files:**
- Create: `core/src/session-lifecycle.ts`
- Modify: `presets/web/src/index.ts` (:81-108 карты и локи, :223-257 `bh_open`, :458-488 `bh_close`, :195-209 `bh_resume_run`)
- Test: `core/test/session-lifecycle.bhtest.ts`

**Interfaces:**
- Consumes: `Session`, `SessionHandle` из задачи 2; `leaseNextExploration`/`validateExplorationLease`/`completeExplorationLease`/`releaseExplorationLease`/`reclaimExplorationLeases` из задачи 4
- Produces: `core/src/session-lifecycle.ts` →
`export function createLifecycle(deps: { session: Session; stateDir: string }): Lifecycle`;
`type Lifecycle = { open(input: { runId: string; target: TargetRef; persona: string; leaseId?: string }): Promise<SessionHandle>; close(runId: string, sessionId: string, outcome: 'done' | 'failed'): Promise<void>; reclaim(runId: string): Promise<string[]>; live(): string[] }`.
Порядок в `open`: `validateExplorationLease` → `session.open` → `recordTargetExploration('exploring')`; при неудаче — `releaseExplorationLease`. Второй живой `open` того же run → `EXPLORER_BUSY`.

- [ ] **Step 1: Тесты (RED)**

`core/test/session-lifecycle.bhtest.ts` на стаб-`Session` (без браузера): `a second concurrent open of the same run throws EXPLORER_BUSY`; `open without a lease throws LEASE_REQUIRED`; `a mismatched lease throws LEASE_MISMATCH`; `a failed open releases the lease`; `close with outcome done completes the lease`; `reclaim skips leases with live sessions`.

- [ ] **Step 2: Убедиться, что падают**

Run: `cd core && node --test test/session-lifecycle.bhtest.ts`
Expected: FAIL — модуль не найден

- [ ] **Step 3: Перенести порядок вызовов из `index.ts`**

Карты `explorations`, `activeExplorerRuns`, `explorationQueueLocks`, `withExplorationQueueLock` и `liveLeaseIds` переезжают в core как состояние `Lifecycle`. `bh_open`/`bh_close` в пресете становятся обёртками: парсинг аргументов → `lifecycle.open/close` → ответ.

- [ ] **Step 4: GREEN + полная линия + рукопожатие**

Run: `cd core && node --test test/session-lifecycle.bhtest.ts` → `# fail 0`
Run: `cd presets/web && env -u PLAYWRIGHT_BROWSERS_PATH npm test 2>&1 | tail -3` → `# pass 253`, `# fail 0`, `# skipped 1`
Run: `cd presets/web && node --test test/explore-queue.bhtest.ts test/report-resume.bhtest.ts` → `# fail 0` (порядок, которым доказан resume-гейт, не изменился)

- [ ] **Step 5: Commit**

```bash
git add core presets/web && git commit -m "refactor(core): own the lease lifecycle behind a facade"
```

---

### Task 7: Sweep, reset и находки

**Files:**
- Create: `core/src/sweep.ts`, `presets/web/src/sweep-visit.ts`, `presets/web/src/reset.ts`
- Modify: `presets/web/src/sweep.ts` (удаляется), `presets/web/src/index.ts`
- Test: `core/test/sweep.bhtest.ts` (core-часть), `presets/web/test/sweep.bhtest.ts` (веб-часть)

**Interfaces:**
- Consumes: `SweepVisit`, `Reset`, `FindingKinds`, `TargetInventory` из задачи 2
- Produces: `core/src/sweep.ts` → `export async function runSweep(options: { runId: string; stateDir: string; limit?: number; cursor?: number; inventory: TargetInventory; visit: SweepVisit; reset: Reset; findingKinds: FindingKinds }): Promise<SweepResult>` и `export async function promoteFindingToCandidate(input: { runId: string; findingId: string; title: string; expected: string; actual: string; check?: CheckEnvelope; stateDir: string; findingKinds: FindingKinds }): Promise<{ candidateId: string }>`. `Finding.kind` становится `string`; словарь — у пресета.

- [ ] **Step 1: Тесты (RED)**

`core/test/sweep.bhtest.ts`: `the cursor resumes an interrupted sweep without revisiting targets`; `an unreachable target is recorded in visited and does not stop the sweep`; `a finding kind unknown to the preset is rejected` (`FINDING_KIND_INVALID`); `promote builds the synthetic step through the preset`. Все — на стаб-`SweepVisit`, без браузера.

- [ ] **Step 2: Убедиться, что падают**

Run: `cd core && node --test test/sweep.bhtest.ts`
Expected: FAIL — модуль не найден

- [ ] **Step 3: Перенести и вырезать**

В core: курсор, чекпоинты в `sweep.json`, хранилище находок, `promoteFindingToCandidate`, проверка области прогона. В пресет: `applyReset` (`sweep.ts:37-61`, `page.evaluate`), обход экрана со `settle` и ожиданием привязанного ответа, чтение `screens.json`, построение синтетического шага `kind: 'navigate'`.

- [ ] **Step 4: GREEN + полная линия**

Run: `cd core && node --test test/sweep.bhtest.ts` → `# fail 0`
Run: `cd presets/web && env -u PLAYWRIGHT_BROWSERS_PATH npm test 2>&1 | tail -3` → `# pass 253`, `# fail 0`, `# skipped 1`

- [ ] **Step 5: Commit**

```bash
git add core presets/web && git commit -m "refactor(core): own the sweep cursor and findings, delegate the visit"
```

---

### Task 8: Экспорт теста, коды ошибок, компактизация, `bh_export_test`

**Files:**
- Create: `core/src/export-host.ts`, `presets/web/src/export-playwright.ts`, `presets/web/src/errors.ts`
- Modify: `presets/web/src/export/playwright.ts` (удаляется), `presets/web/src/index.ts` (:27-33 реестр кодов, :153-158 `compactState`, :420 регистрация инструмента)
- Test: `core/test/export-host.bhtest.ts`, `presets/web/test/export.bhtest.ts`, `presets/web/test/e2e-export.bhtest.ts`, `presets/web/test/prompts.bhtest.ts`, `presets/web/test/portable.bhtest.ts`
- Modify (промпты и доки): `.qwen/skills/bughunter/SKILL.md`, `.qwen/agents/bh-test-writer.md`, `.qwen/agents/bh-reviewer.md`, `.qwen/bughunter/README.md`

**Interfaces:**
- Consumes: `ExportTarget`, `TestGenerator`, `Errors`, `Snapshot` из задачи 2; `TestRunner` из задачи 3
- Produces: `core/src/export-host.ts` → `export async function exportTest(input: { runId: string; bugId: string; stateDir: string; generate: TestGenerator; target: ExportTarget; runner: TestRunner }): Promise<{ file: string; placedInProject: boolean }>`; сохраняет write-once, `EXPORT_FILE_EXISTS`, `EXPORT_PATH_UNSAFE`, `BUG_NOT_CONFIRMED`, `CANDIDATE_UNREPRODUCED`, `BUG_ID_INVALID`, выбор ближайшего проекта через `runner.ownsProject`.

- [ ] **Step 1: Тесты (RED)**

`core/test/export-host.bhtest.ts` на стаб-генераторе: `the generated source is written once and never overwritten` (второй вызов с другим содержимым → `EXPORT_FILE_EXISTS`); `a path escaping the destination is refused` (`EXPORT_PATH_UNSAFE`); `an unconfirmed candidate is refused` (`BUG_NOT_CONFIRMED`); `the destination comes from the preset` (`target.dir(config)` и `target.fileName(bugId)`).
В `presets/web/test/prompts.bhtest.ts`: `prompts do not mention the retired tool name` — ни один файл `.qwen/skills/**` и `.qwen/agents/**` не содержит `bh_export_e2e`.

- [ ] **Step 2: Убедиться, что падают**

Run: `cd core && node --test test/export-host.bhtest.ts` → FAIL, модуль не найден
Run: `cd presets/web && node --test test/prompts.bhtest.ts` → FAIL на `bh_export_e2e` (имя ещё в промптах)

- [ ] **Step 3: Перенести и переименовать**

Генератор спека (`generatePlaywrightTest`, `signalSource`, `visibleTextPoll`, `semanticLocator`, `actionSource`) — в `presets/web/src/export-playwright.ts`; размещение, защита пути, `recordCandidateTest` — в core. Инструмент `bh_export_e2e` → **`bh_export_test`** (имя, описание, `kind: 'api'`-совместимая строка пресета). Доменные коды ошибок (`POINT_TARGET_UNRESOLVED`, `CHECK_INVALID`, `SCREEN_NOT_FOUND`, `SCREENS_STORE_CORRUPT`) — в `presets/web/src/errors.ts`, core-коды (`LEASE_REQUIRED`, `LEASE_MISMATCH`, `EXPLORER_BUSY`, `LIMIT_REACHED`, `RUN_INCOMPLETE`, `EXPORT_*`) — в core. `compactState` становится вызовом `preset.snapshot.compact`.

- [ ] **Step 4: GREEN + полная линия + рукопожатие**

Run: `cd core && node --test test/export-host.bhtest.ts` → `# fail 0`
Run: `cd presets/web && env -u PLAYWRIGHT_BROWSERS_PATH npm test 2>&1 | tail -3` → `# pass 253`, `# fail 0`, `# skipped 1`
Run: `cd presets/web && node --test test/portable.bhtest.ts` → 19 инструментов, среди них `bh_export_test`, `# fail 0`

- [ ] **Step 5: Commit**

```bash
git add core presets/web .qwen/skills .qwen/agents .qwen/bughunter/README.md
git commit -m "refactor(core)!: own export placement and rename bh_export_e2e to bh_export_test"
```

---

### Task 9: Нейтральная лексика схемы состояния

**Files:**
- Move: `presets/web/src/config.ts` → `core/src/config.ts` (загрузчик, валидация, шаблон, `CONFIG_CREATED`) с одновременным разделением полей на общие и preset-специфичные
- Modify: `core/src/types.ts`, `core/src/run-store.ts`, `core/src/candidate.ts`, `core/src/sweep.ts`, `core/src/session-lifecycle.ts`, `presets/web/src/**` (все, где встречаются старые имена), `presets/web/test/**`, `core/test/**`
- Modify: `.qwen/bughunter/fixtures/*/bughunter-config.json` и `state/config.json` в фикстурах, `.qwen/agents/*.md`, `.qwen/skills/*/SKILL.md`, `.qwen/bughunter/README.md`

**Interfaces:**
- Consumes: всё вышеперечисленное
- Produces: переименования по спецификации 6.10 — `Run.routes → Run.targets`, `Run.routeStages → Run.targetStages`, `Scope: 'route' | 'screen' → 'target'`, `Step.routeTemplate → StepEnvelope.targetRef`, `Finding.screenTemplate → Finding.targetRef`, `Candidate.route → Candidate.target`, `Signal.route → Signal.target`, `ExploreQueueItem.route → .target`, `recordRouteExploration → recordTargetExploration`, `tests.e2e.dir → tests.generated.dir`, `Config.routeMap → Config.targetMap`, коды `ROUTE_REQUIRED → TARGET_REQUIRED`, `ROUTE_NOT_ALLOWED → TARGET_NOT_ALLOWED`. `Check.kind` и `Finding.kind` — открытые словари пресета (`string`), литералы живут в `presets/web/src/checks.ts` и `presets/web/src/finding-kinds.ts`.

- [ ] **Step 1: Тест на отказ старого конфига (RED)**

В `core/test/config.bhtest.ts`: `config with a legacy field name is rejected naming the field` — конфиг с `tests.e2e.dir` и без `tests.generated.dir` → ошибка, содержащая путь к файлу и имя поля; `run.json with legacy routeStages is not silently accepted` — `readRun` бросает `RUN_SCHEMA_INVALID: routeStages`.

- [ ] **Step 2: Убедиться, что падает**

Run: `cd core && node --test test/config.bhtest.ts`
Expected: FAIL — старые имена ещё принимаются

- [ ] **Step 3: Выполнить переименования**

Механически по списку в **Produces**, включая шаблон конфига (`CONFIG_CREATED`), конфиги фикстур, промпты и README. Compat-шеймов не писать. `Run.routeStages` в старых `state/runs/**` больше не читается — это принятое решение (спецификация 6.10, 7).

- [ ] **Step 4: GREEN + полная линия**

Run: `cd core && node --test test/*.bhtest.ts` → `# fail 0`
Run: `cd presets/web && env -u PLAYWRIGHT_BROWSERS_PATH npm test 2>&1 | tail -3` → `# pass 253`, `# fail 0`, `# skipped 1`
Run: `cd presets/web && npm run typecheck` → 0 ошибок

- [ ] **Step 5: Commit**

```bash
git add -A core presets/web .qwen fixtures docs
git commit -m "refactor(core)!: replace domain words in the state schema with neutral ones"
```

---

### Task 10: Тесты границы

**Files:**
- Create: `core/test/boundary.bhtest.ts`
- Modify: `core/package.json` (скрипт `test` уже покрывает `test/*.bhtest.ts`)

**Interfaces:**
- Consumes: раскладку из задачи 1, весь вынесенный код задач 3–9
- Produces: постоянный запрет — тест, который падает при появлении доменной лексики в `core/**` или импорта из пресета.

- [ ] **Step 1: Тест (RED)**

`core/test/boundary.bhtest.ts`, два теста. `core sources contain no domain lexicon`: обход `core/src/**/*.ts`, для каждого файла проверка regexp'ом по границам слов на токены `playwright`, `konva`, `three`, `msw`, `browser`, `chrome`, `dom`, `locator`, `viewport`, `click`, `hover`, `scroll`, `screen`, `route`, `endpoint`, `http`, `e2e`, `spec`; утверждение печатает `файл:строка:токен`. `core does not import presets`: обход тех же файлов, поиск `from '.*presets/` и `from '@bughunter/web` — утверждение печатает файл и строку импорта.

- [ ] **Step 2: Убедиться, что падает**

Run: `cd core && node --test test/boundary.bhtest.ts`
Expected: FAIL со списком конкретных `файл:строка:токен` (остатки лексики после задач 3–9)

- [ ] **Step 3: Добить остатки**

Каждую строку из вывода устранить по существу: переименовать, вынести в пресет или — если токен нейтрален (например, `spec` в комментарии) — сузить regexp и зафиксировать это `Ruling:` в леджере. Ослабление списка токенов без ruling запрещено.

- [ ] **Step 4: GREEN + полная линия**

Run: `cd core && node --test test/*.bhtest.ts` → `# fail 0`
Run: `cd presets/web && env -u PLAYWRIGHT_BROWSERS_PATH npm test 2>&1 | tail -3` → `# pass 253`, `# fail 0`, `# skipped 1`

- [ ] **Step 5: Commit**

```bash
git add core && git commit -m "test(core): forbid domain lexicon and preset imports in core"
```

---

### Task 11: Промпт-слой — скиллы core, агенты пресета

**Files:**
- Move: `.qwen/agents/{bh-explorer,bh-reviewer,bh-test-writer}.md` → `.qwen/bughunter/presets/web/agents/`
- Move: `.qwen/skills/{bughunter-oracles,bughunter-red-test}/` → `.qwen/bughunter/skills/` (core-скиллы)
- Create: `.qwen/bughunter/skills/bughunter-core-contract/SKILL.md`, `.qwen/bughunter/skills/bughunter-preset-guide/SKILL.md`, `.qwen/bughunter/presets/web/skills/preset-card/SKILL.md`
- Modify: `.qwen/skills/bughunter/SKILL.md` (остаётся точкой входа `/bughunter`), `presets/web/test/prompts.bhtest.ts`
- Test: `core/test/prompts-core.bhtest.ts`, `presets/web/test/prompts.bhtest.ts`

**Interfaces:**
- Consumes: контракт из задачи 2 (16 типов), раскладку из задачи 1
- Produces: разделение промпт-контракта — core-тест проверяет оркестрационные фразы entry-скилла и наличие core-скиллов; preset-тест проверяет словарь инструментов пресета и allowlist/forbidden агентов.

- [ ] **Step 1: Тесты (RED)**

`core/test/prompts-core.bhtest.ts`: `the entry skill states the orchestration contract without naming preset tools` — в `.qwen/skills/bughunter/SKILL.md` есть фраза про один `Agent` в сообщении и цикл lease, и **нет** ни одного из `bh_open`, `bh_act`, `bh_navigate`, `bh_probe`, `bh_crawl`, `bh_sweep`, `bh_state`, `bh_close`; `the contract skill names all sixteen interfaces` — в `bughunter-core-contract/SKILL.md` встречаются все 16 имён типов из `core/src/preset.ts` (список берётся парсингом экспортов файла, а не хардкодом); `the preset guide states the copy-the-example-depend-on-core rule` — наличие фразы про «пример копируй, core подключай» и критерия «ноль правок core».
`presets/web/test/prompts.bhtest.ts`: `the preset card lists exactly the eight web interaction tools`; `agents allowlist and forbidden lines are unchanged` (существующие проверки, пути обновлены под новый layout).

- [ ] **Step 2: Убедиться, что падают**

Run: `cd core && node --test test/prompts-core.bhtest.ts` → FAIL (скиллов нет)
Run: `cd presets/web && node --test test/prompts.bhtest.ts` → FAIL (пути и словарь не обновились)

- [ ] **Step 3: Написать скиллы и перенести агентов**

`bughunter-core-contract`: семь инвариантов (спецификация 6.1), пять вопросов к пресету, 16 интерфейсов с ответственностью, критерий «ноль правок core». `bughunter-preset-guide`: пошагово от копии `presets/web` до приёмки, включая минимальный snippet целевого приложения (нужен задаче 6.8 спецификации, фаза B). `preset-card` (web): 8 инструментов, области прогона, виды `check` с правилом «`elementCount.target` — селектор, для текста используйте `text=…`». Entry-скилл `bughunter`: только оркестрация и вызов `preset-card`. Агенты пресета вызывают core-скиллы через `Skill` (механизм доказан на `bughunter-oracles`).

- [ ] **Step 4: GREEN + полная линия**

Run: `cd core && node --test test/prompts-core.bhtest.ts` → `# fail 0`
Run: `cd presets/web && env -u PLAYWRIGHT_BROWSERS_PATH npm test 2>&1 | tail -3` → `# pass 253`, `# fail 0`, `# skipped 1`

- [ ] **Step 5: Commit**

```bash
git add .qwen core presets/web && git commit -m "feat(prompts): split the method into core skills and preset agents"
```

---

### Task 12: Документация концепции

**Files:**
- Modify: `README.md` (корень — концепция), `.qwen/bughunter/README.md` (операторская документация веб-пресета)
- Create: `docs/concept/invariants.md`, `docs/concept/preset-guide.md`

**Interfaces:**
- Consumes: всё выше
- Produces: корневой README как точка входа в концепцию; `.qwen/bughunter/README.md` описывает только веб-пресет и его установку.

- [ ] **Step 1: Тест на честность документации (RED)**

`core/test/docs.bhtest.ts`: `the root readme names both domains and the copy-the-example rule` (наличие `core`, `preset`, «пример копируй, core подключай»); `the readme does not claim unverified gates` — в README нет строки `READY` без рядом стоящего run id, и каждое утверждение о модельном гейте сопровождается идентификатором прогона (проверка regexp'ом по секции гейтов).

- [ ] **Step 2: Убедиться, что падает**

Run: `cd core && node --test test/docs.bhtest.ts`
Expected: FAIL

- [ ] **Step 3: Написать документацию**

Корневой README: что такое bughunter (концепция), семь инвариантов, два домена, таблица «core / preset / файлы пользователя», как сделать свой пресет (ссылка на `bughunter-preset-guide`), статус веб-пресета с фактическими run id. `docs/concept/*` — прозаическая версия скиллов для человека. Операторский README пресета: установка, конфиг, области прогона, ограничения, расхождения CLI.

- [ ] **Step 4: GREEN + полная линия**

Run: `cd core && node --test test/*.bhtest.ts` → `# fail 0`
Run: `cd presets/web && env -u PLAYWRIGHT_BROWSERS_PATH npm test 2>&1 | tail -3` → `# pass 253`, `# fail 0`, `# skipped 1`

- [ ] **Step 5: Commit**

```bash
git add README.md docs .qwen/bughunter/README.md core && git commit -m "docs: present bughunter as a concept with core and presets"
```

---

### Task 13: Route-репетиция (модельный гейт фазы A)

**Files:**
- Create: `.superpowers/sdd/<workspace>/rehearsal.sh`, отчёт `docs/superpowers/reports/2026-11-13-phase-a-route-rehearsal.md`

**Interfaces:**
- Consumes: всю фазу A
- Produces: единственное модельное доказательство того, что разрез и переименование `bh_export_test` не сломали оркестрацию.

- [ ] **Step 1: Собрать одноразовую копию**

`GATE=.qwen/bughunter/state/runs/phase-a-rehearsal/project` — **вне** `.qwen/` (чувствительные пути): `bughunter-gate/phase-a-rehearsal/project`. Скопировать фикстуру `buggy-app`, новое дерево `core` + `presets/web`, `.qwen/agents`, `.qwen/skills`, `.mcp.json` с новым путём точки входа; точечный allow-list в `.qwen/settings.json` копии, без `--dangerously-skip-permissions`; один `npm ci` в `presets/web`; поднять vite на свободном порту `127.0.0.1`; `config.json` копии — в **новой** схеме (`tests.generated.dir`, `targets`, `targetMap`).

- [ ] **Step 2: Прогон**

```bash
cd "$GATE" && qwen -p '/bughunter route /orders/new' --output-format stream-json \
  --allowed-mcp-server-names bughunter > ../rehearsal.stdout.jsonl 2> ../rehearsal.stderr.log
```
Ожидаемо: exit 0 за ≤ 1 ч.

- [ ] **Step 3: Проверить критерии своими чтениями, не со слов модели**

Run (по JSONL): число assistant-сообщений с более чем одним `tool_use` → **0**; чередование `bh_explore_next` → ровно один `Agent(bh-explorer)`.
Run (по `run.json`): `status: finished`, все стадии `done`, `Pending: None`.
Run (по `candidates/*.json`): ≥ 1 `confirmed` с `reproduction.status: reproduced`.
Run: `npx playwright test e2e/bughunter --workers=1` в копии → спек **падает** (red), вывод сохранить в отчёт.

- [ ] **Step 4: Записать отчёт и очистить**

Отчёт: run id, счётчики, путь к JSONL, вывод запуска спека, отклонения. Демо-процесс остановить, копию оставить до фиксации и удалить после.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/reports && git commit -m "docs: record the phase A route rehearsal"
```

---

## Self-Review

**1. Покрытие спецификации.** 6.1 (инварианты) → задачи 11, 12. 6.2 (состав core) → задачи 3–8. 6.3 (16 интерфейсов) → задача 2, реализация в 3–8. 6.4 (инструменты, `bh_export_test`, lease-фасад) → задачи 6, 8. 6.5 (раскладка, workspaces, один `npm ci`, dogfooding) → задача 1. 6.6 (скиллы core / агенты пресета) → задача 11. 6.9 (общие поля конфига) → задачи 4, 9. 6.10 (разрыв схемы) → задача 9. 6.11 (route-репетиция) → задача 13. Тесты границы (C2, инвариант 6) → задача 10. 6.12 (дистрибуция, `init`) → **фаза D, вне этого плана**; 6.7–6.8 (`bughunter-node`, приёмка гайдлайнов) → **фаза B, отдельный план**. Пробелов в фазе A нет.

**2. Сканирование шагов.** Каждый шаг — одно действие с проверяемым результатом; тела функций не приводятся, кроме контракта (задача 2) и корневого `package.json` (задача 1), где состав и является решением.

**3. Согласованность имён.** `TargetRef`, `StepEnvelope`, `CheckEnvelope`, `Preset`, `assertPreset`, `assertSinglePreset`, `createLifecycle`, `runSweep`, `promoteFindingToCandidate`, `reportCandidate`, `verifyRed`, `detectTests`, `exportTest`, `defaultStateDir` — одни и те же во всех задачах. `recordTargetExploration` появляется в задаче 6 и переименовывается в задаче 9 из `recordRouteExploration`; до задачи 9 используется старое имя — расхождение осознанное и зафиксировано здесь.

**4. Review Focus.** Старый конфиг → задача 9, шаг 1. Пресет без хука → задача 2, шаг 1. Два пресета в проекте → задача 2, шаг 1. Зависимость core → preset → задача 10, шаг 1. Старое имя инструмента в промптах → задача 8, шаг 1. Портативная установка → задача 1, шаг 5.

**5. Пропорция.** План ~13 задач на спецификацию в 300 строк и 5188 строк кода; код в плане — только контракт и один манифест, остальное сигнатуры, пути и команды.
