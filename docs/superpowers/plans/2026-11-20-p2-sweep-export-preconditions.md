# P2 Sweep Integrity And Export Preconditions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Закрыть три оставшихся критических дефекта: модельный курсор sweep позволяет пропустить цели и завершить прогон по неполному инвентарю; экспортированный Playwright-тест не наследует auth и reset сессии; crawl/sweep работают анонимом и без origin-guard.

**Architecture:** (1) Курсор становится серверным: параметр `cursor` убирается из схем bh_sweep и core, возобновление идёт по множеству `progress.visited`, устойчиво к росту/переупорядочиванию инвентаря. (2) Генератор Playwright-теста наследует предусловия: `test.use({storageState})` из auth-файла состояния (с env-override для переносимости) и reset профиля перед первым goto. (3) Sweep и crawl читают `auth/storage-state.json` как SessionManager.open и ставят простой origin-guard на контекст.

**Tech Stack:** TypeScript (Node ≥22.18), node:test (`*.bhtest.ts`), playwright-core, zod v4. Workspace `.qwen/bughunter`.

**Spec:** inline — постановки в заданиях; доказательства: ревью реализации 2026-11-20 (CoinApp сессия 9f134497) и backlog P2 плана 2026-11-20-critical-workflow-fixes.md.

## Global Constraints

- Node ≥22.18; новые зависимости запрещены; core доменно-нейтрален.
- Тесты `node --test --test-concurrency=1 test/*.bhtest.ts` per workspace; typecheck `npm run typecheck --workspaces` из `.qwen/bughunter`.
- Обратная совместимость: `sweep.json` прежних прогонов читается (поля visited/cursor на месте); `cursor` в ответе bh_sweep больше не нужен модели — `nextCursor` убирается из результата.
- Auth-файл `auth/storage-state.json` не копируется в проект и не коммитится: в тесте абсолютный путь с env-override `BH_STORAGE_STATE`.
- Не трогать `plugin/dist`, `plugin/release`; релиз 0.2.6 — отдельный standing-процесс после мержа P2 и P3.
- Коммиты `fix: …`, один на задание. Пути относительны корню репозитория.

## Review Focus

1. Инвентарь вырос между вызовами bh_sweep → новые цели обязаны быть пройдены до `done`, старые не переобходятся. → Task 1, тест `sweep-visits-appended-targets`.
2. Инвентарь переупорядочен между вызовами → ни одна цель не пропускается и не дублируется. → Task 1, тест `sweep-survives-reorder`.
3. Модель передаёт `cursor` в bh_sweep → строгая схема отклоняет вызов. → Task 1, тест схемы.
4. Экспортированный тест без auth-файла состояния → строки storageState нет (прежние прогоны не ломаются). → Task 2, тест `export-without-auth`.
5. Sweep/crawl на приложении за логином → запросы несут cookie из storage-state; редирект на чужой origin блокируется. → Task 3, тесты `sweep-carries-auth`, `sweep-blocks-foreign-redirect`.

---

### Task 1: Серверный курсор sweep по множеству visited

**Проблема:** `bh_sweep.cursor` доступен модели (index.ts обоих пресетов): прыжок курсором пропускает цели, `done` достигается без полного обхода, а `finishRun` для full-sweep не проверяет покрытие по целям (`targets=[]`). Курсор-индекс также ломается при изменении порядка/состава инвентаря между вызовами.

**Files:**
- Modify: `.qwen/bughunter/core/src/sweep.ts` (SweepOptions, runSweep, SweepResult)
- Modify: `.qwen/bughunter/presets/web/src/sweep-visit.ts` (runSweep обёртка), `.qwen/bughunter/presets/web/src/index.ts` (схема bh_sweep)
- Modify: `.qwen/bughunter/presets/node/src/sweep-visit.ts`, `.qwen/bughunter/presets/node/src/index.ts`
- Modify: `.qwen/skills/bughunter-preset-card/SKILL.md:17` (аргументы bh_sweep)
- Test: `.qwen/bughunter/core/test/sweep.bhtest.ts`, `.qwen/bughunter/presets/web/test/core-integration.bhtest.ts`, `.qwen/bughunter/presets/node/test/portable.bhtest.ts`

**Interfaces:**
- Produces: `SweepOptions` без `cursor`; `SweepResult` без `nextCursor`; `runSweep` возобновляется по `progress.visited` (множество), `progress.cursor` остаётся производным счётчиком пройденных целей для наблюдателя.
- Consumes: существующие `readProgress/writeJsonAtomic`, `TargetInventory.list`.

- [ ] **Step 1: Падающие тесты core** в `sweep.bhtest.ts`:

```ts
test('sweep-visits-appended-targets', () => withStateDir(async (stateDir) => {
  // runSweep limit:1 по inventory(['/a','/b']); затем runSweep по inventory(['/a','/b','/c'])
  // второй вызов: visited === ['/b','/c'], done === true; targets всего 3
}));
test('sweep-survives-reorder', () => withStateDir(async (stateDir) => {
  // первый вызов limit:1 по ['/a','/b','/c']; второй по ['/c','/b','/a']
  // второй вызов проходит ровно ['/c','/b'] (порядок нового инвентаря), done true,
  // суммарно каждая цель ровно один раз
}));
```

Существующий тест `the cursor resumes…`: убрать утверждения `nextCursor`; `progress.cursor` остаётся (3). Тест с `cursor: 5` (строка ~221): заменить на проверку, что `runSweep` с неизвестным полем не компилируется не нужно — удалить блок beyond и вместо него добавить тест `sweep-done-requires-full-coverage`: после limit:1 обхода `run.stages.sweep !== 'done'`, `finishRun` бросает RUN_INCOMPLETE: sweep (хелпер finishRun — по образцу run-store тестов, format-заглушка).

- [ ] **Step 2: RED** — `cd .qwen/bughunter/core && node --test --test-concurrency=1 test/sweep.bhtest.ts`: новые тесты падают (append пропускается индексным курсором; reorder дублирует/пропускает).

- [ ] **Step 3: Реализация core.** В `runSweep`:

```ts
const visitedSet = new Set(progress.visited);
const remaining = selected.filter((target) => !visitedSet.has(target));
const slice = remaining.slice(0, options.limit ?? remaining.length);
```

Цикл по slice: после каждой цели `visitedSet.add(target); progress.visited.push(target); progress.cursor = selected.length - remaining.length + index + 1;`. `done = visitedSet.size >= selected.length` (эквивалентно: все selected в visitedSet; при дубликатах инвентаря использовать `selected.every(t => visitedSet.has(t))`). Ответ: `{ visited, findings, done, targets: selected.length }` — без nextCursor. `SweepOptions.cursor` и `SweepResult.nextCursor` удалить. Пустой slice при непустом remaining невозможен; при пустом remaining сессия не открывается (как раньше).

- [ ] **Step 4: Пресеты.** Обёртки runSweep (web/node sweep-visit.ts): убрать проброс cursor. Схемы bh_sweep обоих index.ts: убрать `cursor`, описание дополнить «возобновление автоматическое по журналу обхода; курсор модели не передаётся». Скилл-карта: аргументы `runId`, `limit`.

- [ ] **Step 5: Тесты схем.** web/core-integration: после цикла requiredInputs добавить `assert.ok(!('cursor' in ((listed.tools.find(t=>t.name==='bh_sweep')?.inputSchema as {properties?: Record<string,unknown>}).properties ?? {})))`. node/portable.bhtest.ts: аналогично, если таблица схем есть (иначе пропустить, зафиксировать).

- [ ] **Step 6: GREEN + полный прогон.** `cd .qwen/bughunter && npm test && npm run typecheck --workspaces` — все green (web/node sweep-тесты, утверждающие nextCursor, обновить: убрать nextCursor-assertions).

- [ ] **Step 7: Commit** `fix: drive sweep resume by visited set, remove model cursor`.

---

### Task 2: Предусловия экспорта — auth и reset в генерируемом тесте

**Проблема:** экспортированный Playwright-тест стартует анонимом и без сброса данных: за логином он не достигает экрана (тупик red-вердикта), а data-зависимый баг может дать ложный green. Node-экспорт reset уже наследует — асимметрия.

**Files:**
- Modify: `.qwen/bughunter/presets/web/src/export-playwright.ts` (generatePlaywrightTest, webTestGenerator)
- Modify: `.qwen/skills/bughunter-preset-card/SKILL.md` (раздел об экспорте)
- Test: `.qwen/bughunter/presets/web/test/export.bhtest.ts`

**Interfaces:**
- Produces: `generatePlaywrightTest(candidate, config, initialRoute?, profile?, preconditions?: { storageStatePath?: string; reset?: ResetRecipe })` — новый опциональный параметр; `webTestGenerator.generate` читает `stateDir/auth/storage-state.json` (access) и профиль, передаёт preconditions.
- Consumes: `ResetRecipe` из profile/types.ts (`kind: 'storage-flag'|'mock-endpoint', key?, url?`), `loadActiveProfile`.

- [ ] **Step 1: Падающие тесты** в `export.bhtest.ts` (хелпер candidate/config файла):

```ts
test('export-with-auth-storage-state', () => {
  const source = generatePlaywrightTest(candidate(), config(), '/profile', null,
    { storageStatePath: '/state/auth/storage-state.json' });
  assert.ok(source.includes('test.use({ storageState: process.env.BH_STORAGE_STATE ?? "/state/auth/storage-state.json" });'));
});
test('export-without-auth', () => {
  assert.ok(!generatePlaywrightTest(candidate(), config()).includes('storageState'));
});
test('export-with-reset-endpoint', () => {
  const source = generatePlaywrightTest(candidate(), config(), '/profile', null,
    { reset: { kind: 'mock-endpoint', url: '/__reset' } });
  assert.ok(source.includes('await page.request.post(new URL("/__reset", "https://example.test/app/").href);'));
});
test('export-with-reset-storage-flag', () => {
  const source = generatePlaywrightTest(candidate(), config(), '/profile', null,
    { reset: { kind: 'storage-flag', key: 'bh_reset' } });
  assert.ok(source.includes('localStorage.setItem("bh_reset"'));
});
```

Reset-строки обязаны стоять ДО первого `page.goto` в обоих шаблонах (signal и check); storageState-строка — после импортов, до test().

- [ ] **Step 2: RED** — `node --test --test-concurrency=1 test/export.bhtest.ts`: новые тесты падают.

- [ ] **Step 3: Реализация.** `preconditionsSource(preconditions, config): string` возвращает: storageState → `test.use({ storageState: process.env.BH_STORAGE_STATE ?? ${JSON.stringify(path)} });\n`; reset mock-endpoint → блок перед goto `const resetResponse = await page.request.post(new URL(${JSON.stringify(url)}, ${JSON.stringify(config.baseUrl)}).href);\n  expect(resetResponse.ok()).toBeTruthy();\n`; storage-flag → `await page.addInitScript((key) => { try { localStorage.setItem(key, new Date().toISOString()); sessionStorage.setItem(key, new Date().toISOString()); } catch {} }, ${JSON.stringify(key)});\n`. Вставить в оба шаблона: `test.use` после импортов; reset-блок первой строкой тела теста (до dialogSetup/goto). `webTestGenerator.generate`: `access(join(stateDir,'auth','storage-state.json'))` → путь или undefined; профиль уже загружается.

- [ ] **Step 4: Скилл-карта.** Добавить: «Экспортированный e2e наследует auth (storageState из состояния bughunter, переопределяется env BH_STORAGE_STATE) и reset профиля; для запуска в проекте нужен @playwright/test и доступный стенд».

- [ ] **Step 5: GREEN + полный прогон** (живой e2e-export suite обязан остаться green: fixture без auth/reset → прежний источник). `npm test && npm run typecheck --workspaces`.

- [ ] **Step 6: Commit** `fix: inherit auth and reset preconditions in exported playwright tests`.

---

### Task 3: Auth и origin-guard в sweep/crawl

**Проблема:** `webSweepSession.open` и `crawlScreens` создают контекст без `storageState` (аноним за логином) и без route-guard (редирект уводит за разрешённые origins). Интерактивные сессии auth читают — обход нет.

**Files:**
- Create: `.qwen/bughunter/presets/web/src/browser/guard.ts`
- Modify: `.qwen/bughunter/presets/web/src/sweep-visit.ts`, `.qwen/bughunter/presets/web/src/discovery/crawl.ts`
- Test: `.qwen/bughunter/presets/web/test/sweep.bhtest.ts`, `.qwen/bughunter/presets/web/test/discovery.bhtest.ts`

**Interfaces:**
- Produces: `installOriginGuard(context: BrowserContext, allowedOrigins: string[]): Promise<void>` — route '**/*': http/https без credentials и origin из списка → continue, иначе abort('blockedbyclient'); `readStorageStatePath(stateDir): Promise<string | undefined>` — access-проверка `auth/storage-state.json`.
- Consumes: существующий `isAllowedOrigin`-паттерн (URL.origin сравнение).

- [ ] **Step 1: Падающие тесты.** В sweep.bhtest.ts (controls-сервер файла или новый): маршрут `/needs-cookie` отвечает 200 только при cookie `bh_auth=1`, иначе 302 на `/login-redirect`; сервер пишет полученные cookie в массив. Тест `sweep-carries-auth`: stateDir с `auth/storage-state.json` (cookies: [{name:'bh_auth', value:'1', domain:'127.0.0.1', path:'/'}]), screens.json с шаблоном `/needs-cookie` (sampleUrl controls-origina), runSweep → находка response-captured, сервер видел cookie. Тест `sweep-blocks-foreign-redirect`: маршрут `/escape` редиректит на второй (foreign) сервер; foreign-счётчик запросов остаётся 0, находка navigation-failed либо response-missing (редирект оборван). В discovery.bhtest.ts аналог `crawl-carries-auth` по образцу файла.

- [ ] **Step 2: RED** — тесты падают (cookie не приходит; foreign получает запрос).

- [ ] **Step 3: Реализация.** guard.ts: `installOriginGuard` + `readStorageStatePath` (access, ENOENT → undefined). sweep-visit.ts open: `storageState` в newContext + `await installOriginGuard(context, config.allowedOrigins)` до newPage. crawl.ts: то же в своём контексте. SessionManager не трогать (его guard сложнее и покрыт тестами).

- [ ] **Step 4: GREEN + полный прогон.** `npm test && npm run typecheck --workspaces`.

- [ ] **Step 5: Commit** `fix: carry auth state and origin guard into sweep and crawl`.

---

## Release

После мержа P2 и P3: пересборка payload 0.2.6 standing-процессом. В рамках плана dist/release не меняются.
