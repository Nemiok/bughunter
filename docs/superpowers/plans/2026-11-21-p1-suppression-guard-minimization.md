# P1: Suppression memory, guard attribution, robust minimization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Убрать доминирующие потери трёх прогонов CoinApp — повторное расследование средовых артефактов и раздутые «минимальные» шаги — через работающую память подавлений, атрибуцию guard-блокировок и робастную минимизацию.

**Architecture:** Четыре продуктовых изменения в core/web + docs-пакет. Подавление получает ключ по `signalSignature` и подсказку `suppressedBy`, позволяющую ревьюеру отклонять средовый артефакт без reproduce (жёсткий блок подтверждения остаётся точным по `candidate.signature`). Сигналы `requestfailed`, заблокированные origin-guard'ом, помечаются `blockedBy`. Минимизация в нестабильном режиме подтверждает удаление повторными прогонами и несёт флаг надёжности. Docs объясняют агенту новые механизмы и ориентиры качества check.

**Tech Stack:** TypeScript ESM (`.ts` imports), node:test (`*.bhtest.ts`), Playwright (web-пресет), zod (MCP-схемы).

**Spec:** `/Users/nemiok/.qwen/projects/-Users-nemiok-Desktop-projects-vault-bughunter/memory/project-bughunter-suppression-gap.md` (бэклог по трём прогонам). Дизайн-решения закреплены с оператором 2026-11-21: подавление = «подсказка + skip-reproduce»; минимизация = «B+C (повтор + флаг)».Authority — критерии оракула (`.qwen/skills/bughunter-oracles/SKILL.md`) и контракт core (`.qwen/skills/bughunter-core-contract/SKILL.md`).

## Global Constraints

- Core доменно-нейтрален: ни одного существительного предметной области в `core/src`; доменные маркеры — только явные (`legacy-envelope`, `status-code-prefix`). Guard-атрибуция (`origin-guard`) живёт в web-пресете, не в core.
- Тесты: `node --test --test-concurrency=1 test/*.bhtest.ts` в каждом workspace; `npm run typecheck --workspaces`; сюиты не параллелить, не править файлы во время прогона.
- Fixture-integrity тест требует чистого `git diff` — фикстуры коммитить до прогона.
- `Signal.details` — `Record<string, unknown>`, core его не читает: `blockedBy` добавляется пресетом без правки core-типа Signal.
- Релиз (новый payload 0.2.7 + гейты) — отдельный follow-up, в этот план не входит.
- Имена полей сквозные: `suppressedBy` (Candidate), `signalSignature` (SharedMemoryEntry), `minimization: {stable, confirmations}` (Candidate + ReplayAlgorithmResult), `blockedBy` (Signal.details).

## Review Focus

- Подавление по `signalSignature` НЕ маскирует реальный баг с тем же симптомом, но иным check (коллизия «один raw 502 → два бага»): жёсткий блок `SIGNATURE_SUPPRESSED` остаётся по `candidate.signature`, confirm-путь не меняется. Тест в Task 1.
- Skip-reproduce разрешён ТОЛЬКО для `rejected` при наличии `suppressedBy`; `confirmed`/`duplicate` и `rejected` без подсказки по-прежнему требуют `reproduced`. Тест в Task 2.
- Стабильный режим минимизации сохраняет точный детерминированный контракт (существующие тесты зелёные); нестабильный режим не выбрасывает триггер. Тесты в Task 4.
- Guard-атрибуция не помечает same-origin и не-`blockedbyclient` отказы; не меняет сигнатуру сигнала. Тест в Task 3.
- Legacy-запись подавления без `signalSignature` (check-only кандидат) по-прежнему матчится по `signature`. Тест в Task 1.

---

### Task 1: Suppression key by signalSignature + `suppressedBy` hint

**Files:**
- Modify: `.qwen/bughunter/core/src/run-store.ts` (`SharedMemoryEntry` ~340, `memoryEntry` ~525)
- Modify: `.qwen/bughunter/core/src/candidate.ts` (`findKnownSignature` ~43, `reportCandidate` ~60)
- Modify: `.qwen/bughunter/core/src/types.ts` (`Candidate` ~142)
- Modify: `.qwen/bughunter/presets/web/src/browser/session.ts:493-534` (return type + passthrough)
- Modify: `.qwen/bughunter/presets/node/src/session.ts` (reportCandidate return + passthrough)
- Test: `.qwen/bughunter/core/test/candidate.bhtest.ts`

**Interfaces:**
- Consumes: `candidateSignature(input)` (без изменений), `readSharedMemory('suppressions.json', stateDir)`.
- Produces: `Candidate.suppressedBy?: string`; `SharedMemoryEntry.signalSignature?: string`; `reportCandidate(...) → {candidateId, duplicateOf?, suppressedBy?}`; web/node `SessionManager.reportCandidate → {candidateId, duplicateOf?, suppressedBy?}`.

- [ ] **Step 1: Write the failing tests**

В `core/test/candidate.bhtest.ts` (используй существующий harness создания run/stateDir; если файла нет — создай по образцу `reproduce.bhtest.ts` `reproduceFixture`):

```ts
test('suppression matches by signalSignature across different checks', async () => {
  // stateDir с suppressions.json: [{id:'sup-1', signature:'old-composite', signalSignature:'sym-1', reason:'dev-stand', sourceCandidate:'c0', createdAt:'...', updatedAt:'...'}]
  const a = await reportCandidate({ ...base, signalSignature: 'sym-1', check: { kind: 'elementCount', target: '#x', expected: 0 }, target: '/a' });
  const b = await reportCandidate({ ...base, signalSignature: 'sym-1', check: { kind: 'elementCount', target: '#y', expected: 1 }, target: '/a' });
  assert.equal(a.suppressedBy, 'sup-1');
  assert.equal(b.suppressedBy, 'sup-1'); // иной check → иной candidate.signature, но тот же симптом
  assert.notEqual(a.candidateId, b.candidateId);
});

test('suppression without signalSignature falls back to signature', async () => {
  // suppressions.json: [{id:'sup-2', signature: <candidateSignature(check-only)>, reason:'...', ...}] без signalSignature
  const r = await reportCandidate({ ...base, check: { kind: 'elementCount', target: '#x', expected: 0 }, target: '/a' }); // без signalSignature
  assert.equal(r.suppressedBy, 'sup-2');
});

test('suppressed symptom does not block confirming a different-check real bug', async () => {
  // suppressions.json по sym-1; кандидат signalSignature sym-1 + иной check
  const r = await reportCandidate({ ...base, signalSignature: 'sym-1', check: { kind: 'visibleText', target: 'body', expected: 'ok' }, target: '/a' });
  assert.equal(r.suppressedBy, 'sup-1'); // подсказка есть
  // triage confirmed проходит (жёсткий блок только по candidate.signature, которого нет в suppressions):
  await reproduceToReproduced(r.candidateId); // хелпер: reproduction.status='reproduced'
  const updated = await triageCandidate({ runId, candidateId: r.candidateId, verdict: 'confirmed', reason: 'real app bug', stateDir });
  assert.equal(updated.status, 'confirmed');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd .qwen/bughunter/core && node --test --test-concurrency=1 test/candidate.bhtest.ts`
Expected: FAIL — `suppressedBy` undefined (поле не существует), `triageCandidate` бросает `SIGNATURE_SUPPRESSED` либо тест падает на отсутствующем поле.

- [ ] **Step 3: Add types**

`core/src/types.ts` Candidate: добавь `suppressedBy?: string;` рядом с `duplicateOf`.
`core/src/run-store.ts` `SharedMemoryEntry`: добавь `signalSignature?: string;`.

- [ ] **Step 4: Write signalSignature into suppression entries**

`core/src/run-store.ts` `memoryEntry`: добавь в возвращаемый объект
`...(candidate.signalSignature === undefined ? {} : { signalSignature: candidate.signalSignature }),`.

- [ ] **Step 5: Split memory lookup and compute the hint**

`core/src/candidate.ts`: замени `findKnownSignature` двумя функциями:

```ts
async function findKnownBug(signature: string, stateDir: string): Promise<string | undefined> {
  // known-bugs.json, entry.signature === signature (как прежде, только один файл)
}
async function findSuppression(input: { signature: string; signalSignature?: string }, stateDir: string): Promise<string | undefined> {
  // suppressions.json: match = (input.signalSignature !== undefined && entry.signalSignature === input.signalSignature) || entry.signature === input.signature
  // вернуть match?.id ?? match?.candidateId ?? match?.sourceCandidate
}
```

В `reportCandidate`: `const duplicateOf = await findKnownBug(signature, input.stateDir);` и
`const suppressedBy = await findSuppression({ signature, signalSignature: input.signalSignature }, input.stateDir);`.
Добавь `...(suppressedBy === undefined ? {} : { suppressedBy })` в candidate и в return. Return-тип: `{ candidateId: string; duplicateOf?: string; suppressedBy?: string }`.

- [ ] **Step 6: Surface the hint in preset managers**

`web/src/browser/session.ts:493` return-тип → `{ candidateId: string; duplicateOf?: string; suppressedBy?: string }`; деструктурируй `suppressedBy` из `reportCoreCandidate` и верни `...(suppressedBy === undefined ? {} : { suppressedBy })`.
`node/src/session.ts` reportCandidate — аналогично.

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd .qwen/bughunter/core && node --test --test-concurrency=1 test/candidate.bhtest.ts`
Expected: PASS (все три теста).

- [ ] **Step 8: Typecheck + commit**

Run: `npm run typecheck --workspaces` → 0 errors.
```bash
git add .qwen/bughunter/core/src/types.ts .qwen/bughunter/core/src/run-store.ts .qwen/bughunter/core/src/candidate.ts .qwen/bughunter/core/test/candidate.bhtest.ts .qwen/bughunter/presets/web/src/browser/session.ts .qwen/bughunter/presets/node/src/session.ts
git commit -m "feat: suppression hint by signalSignature with precise confirm block"
```

---

### Task 2: Skip-reproduce triage for hinted candidates

**Files:**
- Modify: `.qwen/bughunter/core/src/run-store.ts` (`triageCandidate` precondition ~543)
- Test: `.qwen/bughunter/core/test/run-store.bhtest.ts` (или candidate.bhtest.ts)

**Interfaces:**
- Consumes: `Candidate.suppressedBy` (Task 1), `TriageInput` (без изменений).
- Produces: ослабленный precondition `CANDIDATE_UNREPRODUCED` — только для `rejected` + `suppressedBy`.

- [ ] **Step 1: Write the failing tests**

```ts
test('hinted candidate can be rejected without reproduce', async () => {
  // кандидат с suppressedBy='sup-1', reproduction.status='unreproduced'
  const updated = await triageCandidate({ runId, candidateId, verdict: 'rejected', reason: 'same dev-stand artifact', suppress: true, stateDir });
  assert.equal(updated.status, 'rejected');
});

test('confirmed still requires reproduced even with hint', async () => {
  // suppressedBy set, reproduction.status='unreproduced'
  await assert.rejects(triageCandidate({ runId, candidateId, verdict: 'confirmed', reason: 'x', stateDir }), /CANDIDATE_UNREPRODUCED/);
});

test('rejected without hint still requires reproduced', async () => {
  // suppressedBy undefined, reproduction.status='unreproduced'
  await assert.rejects(triageCandidate({ runId, candidateId, verdict: 'rejected', reason: 'x', stateDir }), /CANDIDATE_UNREPRODUCED/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd .qwen/bughunter/core && node --test --test-concurrency=1 test/run-store.bhtest.ts`
Expected: FAIL — первый тест бросает `CANDIDATE_UNREPRODUCED`.

- [ ] **Step 3: Relax the precondition**

`core/src/run-store.ts` `triageCandidate`, замени строку precondition:

```ts
const hinted = candidate.suppressedBy !== undefined;
if (candidate.reproduction?.status !== 'reproduced' && !(input.verdict === 'rejected' && hinted)) {
  throw new Error(`CANDIDATE_UNREPRODUCED: ${input.candidateId}`);
}
```

Жёсткий блок `SIGNATURE_SUPPRESSED` (по `candidate.signature`) и ветку `suppress:true` не менять.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd .qwen/bughunter/core && node --test --test-concurrency=1 test/run-store.bhtest.ts`
Expected: PASS.

- [ ] **Step 5: Full core suite + commit**

Run: `cd .qwen/bughunter/core && node --test --test-concurrency=1 test/*.bhtest.ts` → all pass.
```bash
git add .qwen/bughunter/core/src/run-store.ts .qwen/bughunter/core/test/run-store.bhtest.ts
git commit -m "feat: allow rejecting suppressed-hint candidates without reproduce"
```

---

### Task 3: Guard-block attribution in requestfailed signals

**Files:**
- Modify: `.qwen/bughunter/presets/web/src/detectors/signals.ts` (`DetectedSignal` ~32, `addSignal` ~34, `requestfailed` listener ~72)
- Test: `.qwen/bughunter/presets/web/test/signals.bhtest.ts`

**Interfaces:**
- Consumes: `Config.allowedOrigins`, `request.failure()?.errorText`.
- Produces: `Signal.details.blockedBy === 'origin-guard'` для запросов, заблокированных guard'ом (`net::ERR_BLOCKED_BY_CLIENT`). Сигнатура сигнала не меняется.

- [ ] **Step 1: Write the failing test**

В `signals.bhtest.ts` добавь серверный маршрут `/foreign`, отдающий HTML с внешним скриптом (порт ≠ origin), и тест:

```ts
test('requestfailed blocked by client is attributed to origin guard', async () => {
  const page = await browser.newPage();
  await page.route('**/*', (route) => {
    const url = route.request().url();
    return url.startsWith(origin) ? route.continue() : route.abort('blockedbyclient');
  });
  await page.goto(`${origin}/foreign`); // /foreign грузит скрипт с чужого порта
  const signals = await scanSignals(page, configTemplate());
  const blocked = signals.find((s) => s.kind === 'requestfailed' && s.details?.blockedBy === 'origin-guard');
  assert.ok(blocked, 'guard-blocked request must carry blockedBy');
  await page.close();
});

test('ordinary network failure is not attributed to guard', async () => {
  // запрос на закрытый порт (ERR_CONNECTION_REFUSED) без route.abort
  const page = await browser.newPage();
  await page.goto(`${origin}/foreign`); // foreign script → connection refused
  const signals = await scanSignals(page, configTemplate());
  const failed = signals.filter((s) => s.kind === 'requestfailed');
  assert.ok(failed.length > 0);
  assert.ok(failed.every((s) => s.details?.blockedBy === undefined));
  await page.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd .qwen/bughunter/presets/web && node --test --test-concurrency=1 test/signals.bhtest.ts`
Expected: FAIL — `blockedBy` undefined.

- [ ] **Step 3: Annotate guard-blocked failures**

`signals.ts`: расширь `DetectedSignal` полем `blockedBy?: string`; в `addSignal` добавь в `details`
`...(input.blockedBy === undefined ? {} : { blockedBy: input.blockedBy })`.
В listener `requestfailed`:

```ts
const reason = request.failure()?.errorText ?? 'Request failed';
const blockedBy = /blockedbyclient/i.test(reason) ? 'origin-guard' : undefined;
addSignal(page, config, { kind: 'requestfailed', message: `${request.method()} ${url}: ${reason}`, url, ...(blockedBy === undefined ? {} : { blockedBy }) });
```

В controlled-браузере пресета нет расширений: `blockedbyclient` порождает только guard (`route.abort('blockedbyclient')`). Сигнатура (`signalSignature`) не зависит от `details` — не меняется.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd .qwen/bughunter/presets/web && node --test --test-concurrency=1 test/signals.bhtest.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck --workspaces` → 0 errors.
```bash
git add .qwen/bughunter/presets/web/src/detectors/signals.ts .qwen/bughunter/presets/web/test/signals.bhtest.ts
git commit -m "feat: attribute guard-blocked requests in requestfailed signals"
```

---

### Task 4: Robust minimization (repeat confirmation + reliability flag)

**Files:**
- Modify: `.qwen/bughunter/core/src/reproduce.ts` (`ReplayAlgorithmResult` ~18, `replayAndMinimize` ~75, `reproduceCandidate` ~194)
- Modify: `.qwen/bughunter/core/src/types.ts` (`Candidate.minimization`)
- Modify: `.qwen/skills/bughunter-core-contract/SKILL.md:77` (формула бюджета)
- Test: `.qwen/bughunter/core/test/reproduce.bhtest.ts`

**Interfaces:**
- Consumes: `Replay.replay(steps) → ReplayOutcome` (без изменений).
- Produces: `ReplayAlgorithmResult.minimization: {stable: boolean; confirmations: number}`; `Candidate.minimization?: {stable: boolean; confirmations: number}`; константа `minimizationConfirmations = 3`.

- [ ] **Step 1: Write the failing test (unstable deletion confirmation)**

В `reproduce.bhtest.ts`:

```ts
test('unstable replay confirms deletion before keeping an extraneous step', async () => {
  const steps = algorithmSteps(2); // step-0 посторонний, step-1 триггер
  const calls = new Map<string, number>();
  const key = (s: StepBase[]) => s.map((x) => x.id).join(',');
  const result = await replayAndMinimize(steps, 3, async (s) => {
    const k = key(s); const n = (calls.get(k) ?? 0) + 1; calls.set(k, n);
    if (!s.some((x) => x.id === 'step-1')) return matched(false);
    if (k === 'step-0,step-1') return matched(n === 1); // initial: true,false,false → 1/3
    return matched(n >= 2); // reduced {step-1}: первый false, затем true
  });
  assert.equal(result.successes, 1);
  assert.equal(result.minimization.stable, false);
  assert.equal(result.minimization.confirmations, 3);
  assert.deepEqual(result.minimalSteps.map((s) => s.id), ['step-1']);
});

test('unstable replay keeps the trigger when removal never reproduces', async () => {
  const steps = algorithmSteps(2);
  const calls = new Map<string, number>();
  const key = (s: StepBase[]) => s.map((x) => x.id).join(',');
  const result = await replayAndMinimize(steps, 3, async (s) => {
    const k = key(s); const n = (calls.get(k) ?? 0) + 1; calls.set(k, n);
    if (!s.some((x) => x.id === 'step-1')) return matched(false);
    if (k === 'step-0,step-1') return matched(n === 1);
    return matched(false); // reduced {step-1} тоже плавающий: все false
  });
  assert.equal(result.minimization.stable, false);
  assert.deepEqual(result.minimalSteps.map((s) => s.id), ['step-0', 'step-1']); // триггер не выброшен
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd .qwen/bughunter/core && node --test --test-concurrency=1 test/reproduce.bhtest.ts`
Expected: FAIL — первый тест получает `['step-0','step-1']` (одиночная оценка false → шаг оставлен); `result.minimization` undefined.

- [ ] **Step 3: Add the flag types and constant**

`core/src/reproduce.ts`: `export const minimizationConfirmations = 3;`.
`ReplayAlgorithmResult`: добавь `minimization: { stable: boolean; confirmations: number };`.
`core/src/types.ts` Candidate: добавь `minimization?: { stable: boolean; confirmations: number };`.

- [ ] **Step 4: Implement confirmation-aware minimization**

В `replayAndMinimize`:
- `let evaluationCap = reproductionBudget.maximumEvaluations;` (провизорный, достаточен для ≤3 initial-попыток).
- После initial-цикла: `const stable = successes > 0 && successes === initialAttempts;`
  `const confirmations = stable ? 1 : minimizationConfirmations;`
  `evaluationCap = Math.min(200, Math.max(reproductionBudget.maximumEvaluations, attempts + originalSteps.length * (stable ? 2 : confirmations)));`
- Цикл удаления (замени текущий):

```ts
const minimalSteps = [...originalSteps];
if (successes > 0) {
  for (let index = 0; index < minimalSteps.length;) {
    const reduced = minimalSteps.filter((_, i) => i !== index);
    let removable = false;
    let exhausted = false;
    for (let c = 0; c < confirmations; c += 1) {
      const m = await evaluate(reduced);
      if (m === undefined) { exhausted = true; break; }
      if (m === 'error') { errors += 1; break; } // отказ инфраструктуры не доказывает ненужность
      if (m) { removable = true; break; }
      // false → подтверждаем ещё раз (нестабильный режим); при confirmations=1 цикл завершается
    }
    if (exhausted) break;
    if (removable) minimalSteps.splice(index, 1);
    else index += 1;
  }
}
```

При `confirmations=1` (стабильный режим) поведение идентично прежнему — существующие детерминированные тесты остаются зелёными.
- В return добавь `minimization: { stable, confirmations }`.
- В `reproduceCandidate`: `if (reproduced) { updated.minimalSteps = algorithm.minimalSteps; updated.minimization = algorithm.minimization; } else { delete updated.minimalSteps; delete updated.minimization; }`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd .qwen/bughunter/core && node --test --test-concurrency=1 test/reproduce.bhtest.ts`
Expected: PASS — новые тесты зелёные, существующие (детерминированные, бюджеты) зелёные.

- [ ] **Step 6: Update the contract budget doc**

`.qwen/skills/bughunter-core-contract/SKILL.md:77`: замени описание бюджета на
«бюджет оценок max(20, попытки + шаги×2) в стабильном режиме и max(20, попытки + шаги×3) в нестабильном, потолок 200; минимизация подтверждает удаление повторными прогонами при нестабильном воспроизведении и несёт флаг `minimization:{stable,confirmations}`».

- [ ] **Step 7: Full core suite + typecheck + commit**

Run: `cd .qwen/bughunter/core && node --test --test-concurrency=1 test/*.bhtest.ts` → all pass; `npm run typecheck --workspaces` → 0.
```bash
git add .qwen/bughunter/core/src/reproduce.ts .qwen/bughunter/core/src/types.ts .qwen/bughunter/core/test/reproduce.bhtest.ts .qwen/skills/bughunter-core-contract/SKILL.md
git commit -m "feat: confirmation-aware minimization with reliability flag"
```

---

### Task 5: Docs guidance bundle (oracle, explorer, reviewers, preset card)

**Files:**
- Modify: `.qwen/skills/bughunter-oracles/SKILL.md` (после строки 25)
- Modify: `.qwen/agents/bh-explorer.md` (после строки 27)
- Modify: `.qwen/agents/bh-reviewer.md` (после строки 15)
- Modify: `.qwen/bughunter/presets/node/agents/bh-reviewer.md` (подавление)
- Modify: `.qwen/skills/bughunter-preset-card/SKILL.md` (guard-атрибуция)

**Interfaces:**
- Consumes: `suppressedBy` (Task 1), skip-reproduce (Task 2), `blockedBy` (Task 3), `minimization` (Task 4).
- Produces: отрендеренные скиллы/агенты с новыми ориентирами (проверяется сборкой).

Docs — исключение TDD (конфигурация/документация): правки проверяются рендером сборки и контент-assertion, не RED-тестом.

- [ ] **Step 1: Oracle — dev-stand, guard, suppression criteria**

В `bughunter-oracles/SKILL.md` после строки 25 добавь абзац:
«Dev-стенд не приложение: оверлеи инструментов сборки (`iframe#react-refresh-overlay`, vite/webpack error overlay) и их перехват указателя — артефакт дев-рантайма, не нарушение контракта; не строй на них check. `ERR_BLOCKED_BY_CLIENT` на внешнем origin — блокировка origin-guard'ом пресета (сигнал `requestfailed` с `details.blockedBy:'origin-guard'`); последствия заблокированного внешнего ресурса (pageerror загрузчика, пустой контент) не баг приложения. Подавляй (`bh_triage suppress:true`) только устойчивые средовые/harness-артефакты, НЕ нестабильное воспроизведение — за ним может стоять реальный плавающий баг.»

- [ ] **Step 2: Explorer — check quality**

В `bh-explorer.md` после строки 27 добавь:
«Check — инвариант контракта приложения, а не дев-стенда: не используй оверлеи сборки (`#react-refresh-overlay` и подобные) как check. Предпочитай относительные/дельта-инварианты (было N → стало N+1) абсолютным магическим числам, привязанным к текущим данным. Изолируй триггер: регистрируй кандидата с коротким сценарием вокруг одного действия/навигации, а не с длинной цепочкой посторонних действий — неминимальный сценарий плохо воспроизводится и будет отклонён.»

- [ ] **Step 3: Web reviewer — suppression hint workflow**

В `bh-reviewer.md` после строки 15 добавь:
«Если у кандидата есть `suppressedBy`, прочитай причину записи в `suppressions.json`. Если согласен, что это тот же средовый/harness-артефакт (дев-стенд, guard-block, внешний сервис), вызови `bh_triage` `rejected` с `suppress:true` БЕЗ `bh_reproduce`. Если считаешь баг реальным (иной check/контракт приложения) — вызови `bh_reproduce` и подтверди как обычно; подсказка не запрещает подтверждение. Поле `minimization.stable=false` означает нестабильное воспроизведение: проверяй, что минимальные шаги действительно изолируют триггер, и не считай раздутый набор минимальным.»

- [ ] **Step 4: Node reviewer — suppression parity**

В `presets/node/agents/bh-reviewer.md` добавь тот же абзац про `suppressedBy`/`suppress:true` (без web-специфики про оверлеи; guard-блокировок в node нет).

- [ ] **Step 5: Web preset card — guard attribution**

В `bughunter-preset-card/SKILL.md` в раздел сигналов добавь:
«Сигнал `requestfailed` с `details.blockedBy:'origin-guard'` — запрос заблокирован origin-guard'ом пресета (внешний origin вне `allowedOrigins`). Это ожидаемое поведение детерминированного обхода, не баг; не регистрируй кандидаты на последствиях заблокированных внешних ресурсов.»

- [ ] **Step 6: Verify rendering + content**

Run: `node plugin/build.mjs --host qwen`
Затем проверь контент отрендеренных файлов:
Run: `grep -l "suppressedBy" plugin/dist/qwen/*/agents/bh-reviewer.md && grep -l "blockedBy" plugin/dist/qwen/*/skills/bughunter-preset-card-web/SKILL.md && grep -l "react-refresh" plugin/dist/qwen/*/skills/bughunter-oracles/SKILL.md`
Expected: все три grep находят файлы (подстановка путей уточни по фактическому `plugin/dist`).

- [ ] **Step 7: Full suite + typecheck + commit**

Run: `npm run typecheck --workspaces` → 0; полные сюиты core/web/node по очереди → all pass.
```bash
git add .qwen/skills/bughunter-oracles/SKILL.md .qwen/agents/bh-explorer.md .qwen/agents/bh-reviewer.md .qwen/bughunter/presets/node/agents/bh-reviewer.md .qwen/skills/bughunter-preset-card/SKILL.md
git commit -m "docs: suppression workflow, guard attribution, check-quality guidance"
```

---

## Self-Review

**1. Spec coverage:** P1.1 (suppressions) → Tasks 1+2+5(docs); P1.2 (guard) → Task 3+5(docs); P1.3 (check quality) → Task 5(docs); P1.4 (minimization) → Task 4. Все четыре пункта покрыты. P2/P3/верификация — вне скоупа (явно исключены оператором).

**2. Step scan:** каждый шаг — одно действие с проверяемым результатом; тела функций даны только там, где алгоритм не выводится из сигнатуры и теста (цикл минимизации, lookup подавлений). Test-шаги несут точные ассерты.

**3. Type consistency:** `suppressedBy`, `signalSignature`, `minimization:{stable,confirmations}`, `blockedBy` — одинаковые имена во всех задачах и docs. `reportCandidate` return расширен согласованно в core и обоих пресетах.

**4. Review Focus:** все пять пунктов имеют тесты в владеющих задачах (Task 1 ×2, Task 2 ×3, Task 3 ×2, Task 4 ×2). Остаточный риск шума (ложный true при удалении триггера) признан ограничением нестабильного режима — confirmations снижают, но не устраняют; флаг `stable` делает это видимым ревьюеру.

**5. Proportion:** план соразмерен четырём продуктовым изменениям; код-блоки только для алгоритмов, не выводимых из тестов. Docs-задача — точные вставки, не транскрипт.
