# Critical Workflow Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Устранить четыре критических дефекта воркфлоу bughunter, доказанных прогоном CoinApp (сессия qwen 9f134497): ложные баги из-за авто-отклонения диалогов, неудаляемая ложная запись known-bugs, тупиковые кандидаты из промоции без оракула, молчаливое превращение инфраструктурных ошибок воспроизведения в вердикт «не воспроизведён».

**Architecture:** Четыре независимых исправления в порядке приоритета: (1) web-пресет получает учёт диалогов — сигнал, явная политика на действие, запись в журнал, повтор и экспорт; (2) core убирает запись known-bugs при повторном триаже в rejected, если источник записи — этот кандидат; (3) check становится обязательным при промоции находки (схема + guard core); (4) протокол воспроизведения различает «симптом не совпал» и «повтор сломался», ошибка инфраструктуры становится ошибкой инструмента REPLAY_FAILED, а не вердиктом.

**Tech Stack:** TypeScript (Node ≥22.18, native type stripping), node:test (`*.bhtest.ts`), playwright-core, zod v4, MCP SDK. Workspace: `.qwen/bughunter` (core + presets/web + presets/node).

**Spec:** inline — каждое задание несёт постановку проблемы и доказательство из ревью реализации 2026-11-20 (сессия CoinApp 9f134497-010c-4d9e-a876-c1d532ac5db1). Отдельного spec-документа нет; требования зафиксированы в заданиях и Global Constraints.

## Global Constraints

- Node.js ≥22.18; новые зависимости запрещены.
- Core доменно-нейтрален: ни одного знания о браузере, HTTP, Playwright в `core/src` (критерий «ноль правок core» для пресетов соблюдается: поля `dialog`/`dialogs` живут только в web-пресете; core видит лишь `StepBase` и `ReplayOutcome.error`).
- Тесты: `node --test --test-concurrency=1 test/*.bhtest.ts` в каждом workspace; запуск из каталога workspace (`npm test --workspace` или `cd`). Typecheck: `npm run typecheck --workspaces` из `.qwen/bughunter`.
- Коды ошибок — заглавный префикс до двоеточия (`REPLAY_FAILED: …`); модель-facing сообщения пресетов на русском в существующем стиле.
- Обратная совместимость состояния: новые поля журналов/кандидатов опциональны; существующие прогоны читаются без миграции.
- Не трогать `plugin/dist`, `plugin/release`, `bughunter-gate` — пересборка payload и релиз 0.2.6 идут отдельным standing-процессом после мержа (production-фиксы требуют новый payload).
- Коммиты в стиле репозитория: `fix: …` / `feat: …`, один коммит на задание.
- Рабочие пути ниже относительны корню репозитория `/Users/nemiok/Desktop/projects/vault/bughunter`.

## Review Focus

Пять классов входов, которые тесты заданий обязаны закрепить (каждая строка приписана к заданию):

1. Диалог возникает при загрузке страницы (alert на goto), а не во время действия → он обязан попасть в `bh_state`/`bh_navigate`, страница не зависает. → Task 1, тест `dialog-on-load`.
2. Явный `dialog: 'accept'` на подтверждении с запретным текстом (`forbiddenActionText`) → подтверждение отклоняется, действие возвращает FORBIDDEN_ACTION. → Task 1, тест `dialog-accept-forbidden`.
3. Повторный триаж в rejected кандидата, чья сигнатура ранее подтверждена ДРУГИМ кандидатом → запись known-bugs обязана уцелеть. → Task 2, тест `rejected-keeps-foreign-known-bug`.
4. Ошибка инфраструктуры на шаге минимизации после успешных начальных повторов → вердикт остаётся reproduced, шаг не удаляется. → Task 4, тест `minimize-error-keeps-step`.
5. Промоция находки без оракула (включая виды `reset-unsupported`, `response-missing`) → отказ на границе схемы/core, тупиковый кандидат не создаётся. → Task 3, тесты `promote-requires-check`.

---

### Task 1: Диалоги в web-пресете (сигнал + политика + журнал + повтор + экспорт)

**Проблема:** Playwright авто-отклоняет `confirm()`/`alert()`/`prompt()`; в сессии CoinApp это дало ложный баг «Выйти не работает», подтверждённый ревьюером (приложение штатно ждало `confirm('Вы уверены…')`). Модель не видит диалог ни в сигналах, ни в журнале.

**Files:**
- Modify: `.qwen/bughunter/presets/web/src/types.ts` (типы DialogPolicy/DialogRecord, поля Step)
- Modify: `.qwen/bughunter/presets/web/src/detectors/signals.ts` (экспорт reportDialogSignal)
- Modify: `.qwen/bughunter/presets/web/src/detectors/index.ts` (вид 'dialog' в webDetectorKinds)
- Modify: `.qwen/bughunter/presets/web/src/browser/session.ts` (слушатель, политика, буфер, ActResult/StateResult)
- Modify: `.qwen/bughunter/presets/web/src/index.ts` (параметр `dialog` в схеме bh_act)
- Modify: `.qwen/bughunter/presets/web/src/reproduce.ts` (replayActInput передаёт политику)
- Modify: `.qwen/bughunter/presets/web/src/export-playwright.ts` (обработчик диалогов в генерируемом тесте)
- Modify: `.qwen/skills/bughunter-preset-card/SKILL.md:13` (описание параметра)
- Test: `.qwen/bughunter/presets/web/test/dialogs.bhtest.ts` (новый)
- Test: `.qwen/bughunter/presets/web/test/core-integration.bhtest.ts` (схема bh_act)

**Interfaces:**
- Produces: `DialogPolicy = 'accept' | 'dismiss'`; `DialogRecord = { type: string; message: string; handled: DialogPolicy }` (в `types.ts`); `ActInput.dialog?: DialogPolicy`; `ActResult.dialogs: DialogRecord[]`; `StateResult.dialogs: DialogRecord[]`; `Step.dialog?: DialogPolicy`, `Step.dialogs?: DialogRecord[]`; `reportDialogSignal(page: Page, config: Config, message: string): void`.
- Consumes: существующие `addSignal` (внутренняя в signals.ts), `signalSignature` core, `SessionManager.act/readState/appendStep`.

- [ ] **Step 1: Написать падающие тесты** `dialogs.bhtest.ts` по образцу `session.bhtest.ts` (controls-сервер, `createManager`, configTemplate с `forbiddenActionText: ['delete']`). Добавить в controls-сервер маршрут `/dialog` (ветка `request.url?.startsWith('/dialog')` до общей ветки):

```html
<title>Dialog</title><main>
<button data-testid="safe" onclick="if(confirm('Продолжить?')) document.title='Continued'">Safe</button>
<button data-testid="danger" onclick="if(confirm('Delete account?')) document.title='Deleted'">Danger</button>
</main>
```

и маршрут `/dialog-alert`: `<title>Alert</title><body onload="alert('Загрузка завершена')"><main>ok</main></body>`. Тесты (имена и утверждения):

```ts
test('dialog-default-dismiss', async () => {
  // open /dialog, bh-эквивалент: manager.act click по data-testid=safe без dialog
  assert.equal(result.ok, true);
  assert.deepEqual(result.dialogs, [{ type: 'confirm', message: 'Продолжить?', handled: 'dismiss' }]);
  assert.equal(await manager.pageOf(sessionId).title(), 'Dialog');
  assert.ok(result.signals.some((s) => s.kind === 'dialog' && s.message === 'confirm: Продолжить?'));
});
test('dialog-accept', async () => {
  // act click safe с dialog: 'accept'
  assert.deepEqual(result.dialogs, [{ type: 'confirm', message: 'Продолжить?', handled: 'accept' }]);
  assert.equal(await manager.pageOf(sessionId).title(), 'Continued');
  const steps = manager.stepsOf(sessionId);
  const last = steps.at(-1) as Step;
  assert.equal(last.dialog, 'accept');
  assert.deepEqual(last.dialogs, result.dialogs);
});
test('dialog-accept-forbidden', async () => {
  // act click danger с dialog: 'accept'; 'Delete account?' содержит 'delete'
  assert.equal(result.ok, false);
  assert.equal(result.error, 'FORBIDDEN_ACTION');
  assert.equal(result.dialogs[0]?.handled, 'dismiss');
  assert.equal(await manager.pageOf(sessionId).title(), 'Dialog');
  // шаг в журнал не попал
});
test('dialog-on-load', async () => {
  // open /dialog-alert (alert срабатывает на goto), затем manager.state
  assert.deepEqual(state.dialogs, [{ type: 'alert', message: 'Загрузка завершена', handled: 'dismiss' }]);
  // повторный state: буфер пуст
  assert.deepEqual((await manager.state(sessionId)).dialogs, []);
});
test('dialog-export', async () => {
  // generatePlaywrightTest на кандидате с шагами dialog: 'accept' и без
  const source = generatePlaywrightTest(candidate, config, '/dialog');
  assert.ok(source.includes("page.on('dialog'"));
  assert.ok(source.includes("dialogPolicy = \"accept\";"));
  assert.ok(source.includes("dialogPolicy = \"dismiss\";"));
  // кандидат без диалогов: обработчика нет
  assert.ok(!generatePlaywrightTest(plainCandidate, config, '/dialog').includes("page.on('dialog'"));
});
```

- [ ] **Step 2: Запустить тесты, убедиться что падают**

Run: `cd .qwen/bughunter/presets/web && node --test --test-concurrency=1 test/dialogs.bhtest.ts`
Expected: FAIL (`result.dialogs` undefined, `dialog` не принимается схемой act).

- [ ] **Step 3: Типы и сигнал**

В `types.ts`: `export type DialogPolicy = 'accept' | 'dismiss'; export type DialogRecord = { type: string; message: string; handled: DialogPolicy };` и поля `dialog?: DialogPolicy; dialogs?: DialogRecord[]` в `Step`.
В `signals.ts`: `export function reportDialogSignal(page: Page, config: Config, message: string): void { addSignal(page, config, { kind: 'dialog', message }); }`.
В `detectors/index.ts`: добавить `'dialog'` в `webDetectorKinds`.

- [ ] **Step 4: Слушатель и политика в SessionManager**

В `Session` (session.ts): поля `dialogPolicy: DialogPolicy` (init `'dismiss'`), `dialogs: DialogRecord[]` (init `[]`), `dialogForbidden: boolean` (init false). В `open()` после создания объекта сессии и до `page.goto`:

```ts
page.on('dialog', (dialog) => {
  const message = dialog.message();
  const forbidden = this.config.safety.forbiddenActionText.some((token) =>
    token.length > 0 && message.toLocaleLowerCase().includes(token.toLocaleLowerCase()));
  const handled: DialogPolicy = session.dialogPolicy === 'accept' && !forbidden ? 'accept' : 'dismiss';
  session.dialogs.push({ type: dialog.type(), message, handled });
  if (forbidden && session.dialogPolicy === 'accept') session.dialogForbidden = true;
  reportDialogSignal(page, this.config, `${dialog.type()}: ${message}`);
  void (handled === 'accept' ? dialog.accept() : dialog.dismiss()).catch(() => undefined);
});
```

В `act()`: до `executeAction` — `session.dialogPolicy = input.dialog ?? 'dismiss'; session.dialogForbidden = false;`. После `collectSignals`: `const dialogs = session.dialogs.splice(0);`; если `session.dialogForbidden` — вернуть `{ ok: false, error: 'FORBIDDEN_ACTION', navigated: …, signals, dialogs }` без записи шага; в успешный результат и в шаг журнала добавить `dialogs` и `...(input.dialog === undefined ? {} : { dialog: input.dialog })`. В `readState()`: `dialogs: session.dialogs.splice(0)` в возвращаемый StateResult. `ActInput.dialog?: DialogPolicy`, `ActResult.dialogs: DialogRecord[]`, `StateResult.dialogs: DialogRecord[]`.

- [ ] **Step 5: MCP-схема и повтор**

`index.ts` bh_act: в strictObject добавить `dialog: z.enum(['accept', 'dismiss']).optional()` и пробросить в `manager().act`. Описание инструмента дополнить: «dialog: 'accept' подтверждает нативный диалог (confirm/alert/prompt) этого действия; по умолчанию 'dismiss'; каждый диалог возвращается в dialogs и сигналом kind=dialog».
`reproduce.ts` `replayActInput`: в возвращаемый ActInput добавить `...(step.dialog === undefined ? {} : { dialog: step.dialog })`.

- [ ] **Step 6: Экспорт**

В `export-playwright.ts`: `replaySource` вычисляет `const usesDialogs = steps.some((step) => step.dialog !== undefined || (step.dialogs?.length ?? 0) > 0);`. Если `usesDialogs`: перед каждой act-строкой эмитить `dialogPolicy = ${JSON.stringify(step.dialog ?? 'dismiss')};`, а в оба шаблона теста (signalSource и check-шаблон) сразу после создания page добавить:

```ts
let dialogPolicy: 'accept' | 'dismiss' = 'dismiss';
page.on('dialog', (dialog) => { if (dialogPolicy === 'accept') void dialog.accept(); else void dialog.dismiss(); });
```

(строки внутри шаблонов — с экранированием как у соседнего кода). Без диалогов обработчик не эмитится.

- [ ] **Step 7: Скилл-карта**

`.qwen/skills/bughunter-preset-card/SKILL.md:13`: дополнить описание `bh_act` параметром `dialog` и правилом: «Нативные диалоги по умолчанию отклоняются и возвращаются в `dialogs` + сигнал `dialog`; если приложение ждёт подтверждения, повтори действие с `dialog: 'accept'`; запретный текст в сообщении диалога блокирует accept (FORBIDDEN_ACTION)».

- [ ] **Step 8: Схема в core-integration**

В `core-integration.bhtest.ts` после цикла requiredInputs добавить утверждение: схема `bh_act` содержит свойство `dialog` с enum `['accept', 'dismiss']` (доступ к `listed.tools`, как в существующем цикле).

- [ ] **Step 9: Прогнать тесты и typecheck**

Run: `cd .qwen/bughunter/presets/web && node --test --test-concurrency=1 test/dialogs.bhtest.ts test/session.bhtest.ts test/core-integration.bhtest.ts test/reproduce.bhtest.ts test/export.bhtest.ts`
Expected: PASS. Затем `cd .qwen/bughunter && npm run typecheck --workspaces` — без ошибок.

- [ ] **Step 10: Commit**

```bash
git add .qwen/bughunter/presets/web/src .qwen/bughunter/presets/web/test/dialogs.bhtest.ts .qwen/bughunter/presets/web/test/core-integration.bhtest.ts .qwen/skills/bughunter-preset-card/SKILL.md
git commit -m "fix: surface and control native dialogs in web preset"
```

---

### Task 2: Отзыв known-bugs при повторном триаже в rejected

**Проблема:** `triageCandidate` пишет known-bugs только при confirmed; повторный триаж кандидата в rejected оставляет ложную запись навсегда (в сессии CoinApp запись «Выйти» пришлось удалять вручную питоном). Будущие прогоны считают тот же симптом дубликатом known-bug.

**Files:**
- Modify: `.qwen/bughunter/core/src/run-store.ts:522-568` (triageCandidate)
- Test: `.qwen/bughunter/core/test/run-store.bhtest.ts`

**Interfaces:**
- Consumes: существующие `readSharedMemory('known-bugs.json', stateDir)`, `writeJsonAtomic`, `triageCandidate(input: TriageInput)`.
- Produces: поведение (сигнатура не меняется): после `verdict: 'rejected'` запись с `signature === candidate.signature && sourceCandidate === candidate.id` удалена; чужие записи нетронуты.

- [ ] **Step 1: Написать падающие тесты** в `run-store.bhtest.ts` (хелперы создания прогона/кандидата — по образцу существующих тестов файла; кандидат обязан иметь `reproduction: { status: 'reproduced', attempts: 1 }` для триажа):

```ts
test('rejected-revokes-own-known-bug', async () => {
  // triage confirmed → known-bugs содержит запись sourceCandidate === candidate.id
  // triage rejected того же кандидата →
  assert.deepEqual(await readSharedMemory('known-bugs.json', stateDir), []);
});
test('rejected-keeps-foreign-known-bug', async () => {
  // кандидат A confirmed (запись sourceCandidate = A.id); кандидат B с той же
  // сигнатурой reproduced → triage B rejected →
  const known = await readSharedMemory('known-bugs.json', stateDir);
  assert.equal(known.length, 1);
  assert.equal(known[0].sourceCandidate, aId);
});
test('rejected-without-known-bug-is-noop', async () => {
  // reproduced кандидат без записи → triage rejected → файл не создан/пуст
  assert.deepEqual(await readSharedMemory('known-bugs.json', stateDir), []);
});
test('duplicate-verdict-keeps-known-bug', async () => {
  // A confirmed; B reproduced той же сигнатуры → triage B duplicate → запись цела
  assert.equal((await readSharedMemory('known-bugs.json', stateDir)).length, 1);
});
```

- [ ] **Step 2: Запустить, убедиться что падают**

Run: `cd .qwen/bughunter/core && node --test --test-concurrency=1 test/run-store.bhtest.ts`
Expected: FAIL `rejected-revokes-own-known-bug` (запись остаётся).

- [ ] **Step 3: Реализовать отзыв**

В `triageCandidate` после существующей цепочки if/else (перед сборкой `updated`):

```ts
if (input.verdict === 'rejected') {
  const known = await readSharedMemory('known-bugs.json', input.stateDir);
  const remaining = known.filter((entry) =>
    !(entry.signature === candidate.signature && entry.sourceCandidate === candidate.id));
  if (remaining.length !== known.length) await writeJsonAtomic(knownPath, remaining);
}
```

- [ ] **Step 4: Прогнать тесты core**

Run: `cd .qwen/bughunter/core && npm test`
Expected: PASS (все, включая существующие триаж-тесты).

- [ ] **Step 5: Commit**

```bash
git add .qwen/bughunter/core/src/run-store.ts .qwen/bughunter/core/test/run-store.bhtest.ts
git commit -m "fix: revoke own known-bugs entry on rejected re-triage"
```

---

### Task 3: Обязательный check при промоции находки

**Проблема:** описание `bh_promote_finding` требует check, схема делает его optional. Кандидат без check и без сигналов невоспроизводим (ORACLE_REQUIRED) и нетриажируем (UNREPRODUCED) → прогон нельзя завершить никогда. В web-пресете check при промоции ещё и не валидируется (node валидирует).

**Files:**
- Modify: `.qwen/bughunter/core/src/sweep.ts:161-221` (promoteFindingToCandidate)
- Modify: `.qwen/bughunter/presets/web/src/index.ts:303-317` (схема + validateWebCheck)
- Modify: `.qwen/bughunter/presets/node/src/index.ts:116-121,292-306` (схема)
- Test: `.qwen/bughunter/core/test/sweep.bhtest.ts`
- Test: `.qwen/bughunter/presets/web/test/core-integration.bhtest.ts:207-221` (requiredInputs)
- Test: `.qwen/bughunter/presets/node/test/portable.bhtest.ts` (аналогичная таблица, если есть)

**Interfaces:**
- Consumes: `validateWebCheck(check: Check): void` (web/checks.ts), `validateNodeCheck` (node/checks.ts).
- Produces: `promoteFindingToCandidate(input: { …; check: Candidate['check']; … })` — поле обязательно в типе; runtime-guard `CANDIDATE_ORACLE_REQUIRED` при undefined. Схемы обоих пресетов: `check` в required у `bh_promote_finding`, остаётся optional у `bh_report_candidate`.

- [ ] **Step 1: Написать падающий тест core** в `sweep.bhtest.ts` (находка создаётся существующим хелпером файла):

```ts
test('promote-requires-check', async () => {
  await assert.rejects(
    promoteFindingToCandidate({ runId, findingId, title: 't', expected: 'e', actual: 'a', stateDir, findingKinds } as never),
    /CANDIDATE_ORACLE_REQUIRED/,
  );
  // кандидат не создан: каталог candidates пуст
});
```

Существующие тесты промоции, вызывающие её без check, дополняют валидным check fixtures (например `{ kind: 'elementCount', target: '[data-testid="x"]', expected: 1 }` для web-хелперов; для core-теста — любой объект, core вид не проверяет).

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `cd .qwen/bughunter/core && node --test --test-concurrency=1 test/sweep.bhtest.ts`
Expected: FAIL (промоция без check проходит).

- [ ] **Step 3: Guard core**

В `promoteFindingToCandidate`: тип поля `check: Candidate['check']` (убрать `?`); первой строкой после resolve stateDir: `if (input.check === undefined) throw new Error('CANDIDATE_ORACLE_REQUIRED');`.

- [ ] **Step 4: Схемы пресетов**

web/index.ts: вынести общий `const webCheckSchema = z.strictObject({ kind: z.enum(webCheckKinds), target: z.string().min(1), expected: z.union([z.string(), z.number()]).optional() }).describe(…существующий текст…)`; в `bh_report_candidate` — `check: webCheckSchema.optional()`, в `bh_promote_finding` — `check: webCheckSchema`; перед promote добавить `validateWebCheck(input.check);`.
node/index.ts: существующий `const check = z.strictObject({…}).describe(…)` переименовать в `checkShape` (без optional); `const check = checkShape.optional();` для report; в promote — `check: checkShape` (validateNodeCheck уже вызывается).

- [ ] **Step 5: Таблицы required**

`core-integration.bhtest.ts`: `bh_promote_finding: ['actual', 'check', 'expected', 'findingId', 'runId', 'title']`. В `node/test/portable.bhtest.ts` найти аналогичную таблицу required и обновить так же (если таблицы нет — пропустить, зафиксировать в коммите).

- [ ] **Step 6: Прогнать тесты и typecheck**

Run: `cd .qwen/bughunter/core && npm test && cd ../presets/web && node --test --test-concurrency=1 test/core-integration.bhtest.ts && cd ../node && node --test --test-concurrency=1 test/portable.bhtest.ts`
Expected: PASS. `cd .qwen/bughunter && npm run typecheck --workspaces` — без ошибок.

- [ ] **Step 7: Commit**

```bash
git add .qwen/bughunter/core/src/sweep.ts .qwen/bughunter/core/test/sweep.bhtest.ts .qwen/bughunter/presets/web/src/index.ts .qwen/bughunter/presets/node/src/index.ts .qwen/bughunter/presets/web/test/core-integration.bhtest.ts .qwen/bughunter/presets/node/test/portable.bhtest.ts
git commit -m "fix: require oracle check when promoting a finding"
```

---

### Task 4: Ошибки инфраструктуры воспроизведения — ошибка инструмента, не вердикт

**Проблема:** `replay(steps).catch(() => false)` (core/reproduce.ts:94) и catch-all пресетов превращают падение стенда, невалидный селектор и отсутствующее поле в «не воспроизведён 0/3». Частный случай: node-оракул `jsonPath` по отсутствующему полю бросает POINTER_NOT_FOUND (checks.ts:57) → баги «поле пропало из ответа» невоспроизводимы в принципе.

**Files:**
- Modify: `.qwen/bughunter/core/src/preset.ts:48` (ReplayOutcome)
- Modify: `.qwen/bughunter/core/src/reproduce.ts` (evaluate, replayAndMinimize, reproduceCandidate)
- Modify: `.qwen/bughunter/presets/web/src/reproduce.ts:117-119` (catch)
- Modify: `.qwen/bughunter/presets/node/src/replay.ts:65-66` (catch)
- Modify: `.qwen/bughunter/presets/node/src/checks.ts:54-64` (jsonPath)
- Modify: `.qwen/bughunter/presets/web/src/errors.ts:58` и `.qwen/bughunter/presets/node/src/errors.ts:58` (код REPLAY_FAILED)
- Test: `.qwen/bughunter/core/test/reproduce.bhtest.ts`
- Test: `.qwen/bughunter/presets/node/test/checks.bhtest.ts:108`
- Test: `.qwen/bughunter/presets/node/test/replay.bhtest.ts`
- Test: `.qwen/bughunter/presets/web/test/reproduce.bhtest.ts`

**Interfaces:**
- Produces: `ReplayOutcome = { matched: boolean; artifacts: string[]; error?: string }`; `ReplayAlgorithmResult` дополнен `errors: number; lastError?: string`; новый код ошибки `REPLAY_FAILED: <причина>` (бросается core, проходит через errorCode обоих пресетов). Кандидат при всех-ошибках НЕ перезаписывается.
- Consumes: существующий `replayAndMinimize(originalSteps, attempts, replay, options)` — сигнатура replay-колбэка меняется на `(steps) => Promise<ReplayOutcome>` (уже так в reproduceCandidate; прямой колбэк в тестах core обновить).

- [ ] **Step 1: Написать падающие тесты core** в `reproduce.bhtest.ts` (журнал/кандидат — по образцу существующих тестов файла):

```ts
test('all-attempts-error-throws-replay-failed', async () => {
  // replay: async () => { throw new Error('STAND_DOWN'); }
  await assert.rejects(reproduceCandidate({ …, replay }), /REPLAY_FAILED: STAND_DOWN/);
  const stored = JSON.parse(await readFile(candidateFile, 'utf8'));
  assert.deepEqual(stored.reproduction, { status: 'unreproduced', attempts: 0 }); // не тронут
});
test('error-then-match-reproduces', async () => {
  // replay: первые 2 вызова throw, 3-й → { matched: true, artifacts: [] }
  const result = await reproduceCandidate({ …, attempts: 3, replay });
  assert.equal(result.reproduced, '1/3');
});
test('minimize-error-keeps-step', async () => {
  // replay: начальные 3 вызова matched:true; вызовы минимизации → { matched:false, artifacts:[], error:'FLAKY' }
  const result = await reproduceCandidate({ …, replay });
  assert.equal(result.reproduced, '3/3');
  assert.equal(result.minimalSteps, originalSteps.length); // ни один шаг не удалён
});
test('outcome-error-field-counts-as-error', async () => {
  // replay: async () => ({ matched: false, artifacts: [], error: 'CHECK_INVALID: bad selector' })
  await assert.rejects(reproduceCandidate({ …, replay }), /REPLAY_FAILED: CHECK_INVALID/);
});
```

- [ ] **Step 2: Запустить, убедиться что падают**

Run: `cd .qwen/bughunter/core && node --test --test-concurrency=1 test/reproduce.bhtest.ts`
Expected: FAIL (вместо REPLAY_FAILED — тихий unreproduced).

- [ ] **Step 3: Протокол core**

`preset.ts`: `error?: string` в ReplayOutcome.
`reproduce.ts`:
- `evaluate` возвращает `Promise<boolean | 'error' | undefined>`; внутри: `const work = Promise.resolve().then(() => replay(steps)).then((outcome) => { if (outcome.error !== undefined) { lastError = outcome.error; return 'error' as const; } return outcome.matched; }).catch((error) => { lastError = error instanceof Error ? error.message : String(error); return 'error' as const; });` (`lastError` — переменная области replayAndMinimize).
- `ReplayAlgorithmResult`: добавить `errors: number; lastError?: string`; в начальном цикле `'error'` → `errors += 1` (initialAttempts считать); в минимизации `'error'` → `index += 1` (шаг сохраняется), `errors += 1`.
- `reproduceCandidate` после алгоритма, до записи кандидата:

```ts
if (algorithm.successes === 0 && algorithm.initialAttempts > 0 && algorithm.errors === algorithm.initialAttempts) {
  throw new Error(`REPLAY_FAILED: ${algorithm.lastError ?? 'replay failed'}`);
}
```

- [ ] **Step 4: Пресеты отдают error вместо глотания**

web/reproduce.ts `executeReplay`: catch сохраняет сообщение (`replayError = errorMessage(error)`), matched остаётся false, закрытие сессии и сбор артефактов выполняются как раньше; ранний возврат `if (!sessionId)` тоже обязан нести ошибку: `return { matched: false, artifacts: [], ...(replayError === undefined ? {} : { error: replayError }) };`; финальный возврат — `{ matched, artifacts, ...(replayError === undefined ? {} : { error: replayError }) }`.
node/replay.ts: `catch (error) { return { matched: false, artifacts, error: error instanceof Error ? error.message : String(error) }; }`.
node/checks.ts `nodeCheckViolated` case jsonPath:

```ts
let actual: unknown;
try { actual = readPointer(response.body, oracle.pointer as string); }
catch { return true; } // отсутствующее поле ≠ ожидаемому значению
return !sameValue(actual, oracle.expected);
```

errors.ts обоих пресетов: добавить `REPLAY_FAILED` в regex нейтральных кодов core (строка с `EXPLORER_BUSY|FINDING_NOT_CANDIDATE|…`).

- [ ] **Step 5: Обновить/добавить тесты пресетов**

- node/checks.bhtest.ts:108: тест отсутствующего указателя теперь утверждает `assert.equal(await nodeCheckViolated(handle, check), true)` (имя теста: `jsonPath-missing-field-is-violation`).
- node/replay.bhtest.ts: новый тест `replay-step-incomplete-surfaces-error`: журнал с шагом без `method` → `createNodeReplay().replay([step], context)` возвращает `{ matched: false, error: /REPLAY_STEP_INCOMPLETE/ }` (context — по образцу файла).
- web/reproduce.bhtest.ts: новый тест по образцу существующих (fixture-сессия, кандидат с шагом, чей локатор не находится): `reproduceCandidate` rejects `/REPLAY_FAILED: REPLAY_ELEMENT_NOT_FOUND/`.

- [ ] **Step 6: Прогнать все тесты и typecheck**

Run: `cd .qwen/bughunter && npm test && npm run typecheck --workspaces`
Expected: PASS во всех трёх workspace (core 77+, web 260+, node 52+ — counts вырастут).

- [ ] **Step 7: Commit**

```bash
git add .qwen/bughunter/core/src/preset.ts .qwen/bughunter/core/src/reproduce.ts .qwen/bughunter/core/test/reproduce.bhtest.ts .qwen/bughunter/presets/web/src/reproduce.ts .qwen/bughunter/presets/web/src/errors.ts .qwen/bughunter/presets/web/test/reproduce.bhtest.ts .qwen/bughunter/presets/node/src/replay.ts .qwen/bughunter/presets/node/src/checks.ts .qwen/bughunter/presets/node/src/errors.ts .qwen/bughunter/presets/node/test/checks.bhtest.ts .qwen/bughunter/presets/node/test/replay.bhtest.ts
git commit -m "fix: surface replay infrastructure errors instead of silent unreproduced"
```

---

## Backlog (отдельные планы, не задания этого плана)

**P2 — следующие критические (каждый — отдельный план):**
1. Целостность sweep-курсора: убрать модельный `cursor` из схемы bh_sweep (или сделать монотонным), покрытие по целям в finishRun для full-sweep; курсор-индекс против живого инвентаря (core/sweep.ts, presets/*/index.ts).
2. Предусловия экспорта: storageState (auth) и reset профиля в генерируемом Playwright-тесте; требование Playwright в проекте документировать в скилле (export-playwright.ts).
3. Auth и navigation guard в crawl/sweep (sweep-visit.ts, discovery/crawl.ts читают auth/storage-state.json как SessionManager.open).

**P3 — средние (одним планом «hardening»):**
`candidatesPerRun` enforcement; `responseSettleMs` в интерактивном settle(); reset в web-replay; бюджет минимизации пропорционален журналу; нормализация сигнатур не схлопывает `/v1`≠`/v2`; red-классификация Playwright не по префиксу сообщения; readOnly hardening (JS-сабмиты); верификация reset (response.ok, origin); потоковый cap тела в node; win32 shellArgument; elementCount видимость + toHaveCount parity; sameValue deep-equal; vitest-экспорт redirect/pointer parity; crawl кнопочной навигации; attachCandidateArtifacts merge вместо перезаписи; diffTargets незакоммиченные изменения.

## Release

После мержа всех четырёх заданий: пересборка payload (`plugin/build.mjs`), версия 0.2.6, release-гейты standing-процессом (memory: production-фиксы требуют новый payload). В рамках этого плана dist/release не меняются.
