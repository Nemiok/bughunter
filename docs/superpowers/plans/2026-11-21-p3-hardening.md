# P3 Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Закрыть средние弱点 ревью 2026-11-20 одним пакетом: мёртвый лимит кандидатов, флаки интерактивного settle, отсутствие reset в web-replay, обрезанная минимизация, коллизии сигнатур, мелкие корректности (node body cap, win32 escaping, sameValue, vitest parity, артефакты, diff, reset-верификация).

**Architecture:** Точечные правки в core и пресетах без новых абстракций; каждый пункт — отдельный TDD-цикл и коммит. Эвристические пункты (readOnly JS-сабмиты, кнопочная навигация crawl, видимость elementCount, red-классификация Playwright) осознанно отложены с обоснованием в конце.

**Tech Stack:** TypeScript Node ≥22.18, node:test, playwright-core 1.65, zod v4. Workspace `.qwen/bughunter`.

**Spec:** inline — backlog P3 плана 2026-11-20-critical-workflow-fixes.md + ревью реализации 2026-11-20.

## Global Constraints

- Node ≥22.18; без новых зависимостей; core доменно-нейтрален.
- Тесты per workspace `node --test --test-concurrency=1 test/*.bhtest.ts`; typecheck `npm run typecheck --workspaces`.
- Обратная совместимость состояния и контрактов инструментов; существующие golden/contract-тесты обновляются только под заявленное изменение контракта.
- Не трогать plugin/dist, plugin/release. Коммиты `fix: …` по одному на задание.

## Review Focus

1. Лимит кандидатов достигнут → заявка отклоняется кодом, а не молча проходит. → Task 1.
2. Медленный SPA-ответ (300 мс) при заданном responseSettleMs → снимок видит данные. → Task 2.
3. Журнал 30 шагов, все нужны → минимизация не обрывается бюджетом на 20-й оценке. → Task 4.
4. `/api/v1` и `/api/v2`, «HTTP 404» и «HTTP 500» → разные сигнатуры. → Task 5.
5. Ответ 100 КБ → node-сессия хранит ≤64 КБ без полного чтения в память. → Task 6.

---

### Task 1: candidatesPerRun enforcement

**Files:** Modify `presets/web/src/browser/session.ts` (reportCandidate), `presets/node/src/session.ts` (reportNodeCandidate), словари ошибок обоих пресетов (`webDomainCodes`, node-аналог). Test: `presets/web/test/session.bhtest.ts`, `presets/node/test/session.bhtest.ts`.

- [ ] **Step 1 RED:** тесты `candidates-limit-reached`: config limits.candidatesPerRun=1; первая заявка проходит, вторая rejects `/CANDIDATES_LIMIT_REACHED/`. Подсчёт: `readdir(join(stateDir,'runs',runId,'candidates'))` filter `.json` (ENOENT → 0).
- [ ] **Step 2:** реализовать проверку до reportCoreCandidate в обоих пресетах; код `CANDIDATES_LIMIT_REACHED` в словари (web: webDomainCodes; node: аналогичный список).
- [ ] **Step 3 GREEN + suite + typecheck.** Commit `fix: enforce candidatesPerRun limit`.

### Task 2: responseSettleMs в интерактивном settle

**Files:** Modify `presets/web/src/browser/session.ts` (settle). Test: `presets/web/test/session.bhtest.ts`.

- [ ] **Step 1 RED:** controls-маршрут `/slow-data`: страница рендерит `<div data-testid="late">ready</div>` через 300 мс после fetch; config responseSettleMs=1500; `manager.state` видит элемент `late`. Без ожидания сети тест падает (элемент отсутствует).
- [ ] **Step 2:** в settle после body-visible: `if (this.config.limits.responseSettleMs !== undefined) await page.waitForLoadState('networkidle', { timeout: this.config.limits.responseSettleMs }).catch(() => undefined);`
- [ ] **Step 3 GREEN + suite.** Commit `fix: honor responseSettleMs in interactive snapshots`.

### Task 3: reset в web-replay

**Files:** Modify `presets/web/src/reproduce.ts` (executeReplay). Test: `presets/web/test/reproduce.bhtest.ts`.

- [ ] **Step 1 RED:** профиль с reset mock-endpoint `/__reset` (fixture-сервер записывает вызовы); кандидат воспроизводится → сервер видел POST /__reset перед шагами.
- [ ] **Step 2:** после manager.open: `if (loaded.profile?.reset !== undefined) await applyReset(manager.pageOf(sessionId), loaded.profile, loaded.config.baseUrl);` (импорт applyReset из reset.ts); отказ reset → ошибка попадает в replayError (общий catch).
- [ ] **Step 3 GREEN + suite.** Commit `fix: reset stand before web replay`.

### Task 4: Бюджет минимизации пропорционален журналу

**Files:** Modify `core/src/reproduce.ts`. Test: `core/test/reproduce.bhtest.ts`.

- [ ] **Step 1 RED:** `minimization-budget-scales-with-journal`: 30 шагов, replay matched:true только если все шаги на месте → минимизация перебирает все 30 удалений, minimalSteps=30, evaluations=33 (attempts 3 + 30). Старый бюджет 20 обрывает → RED.
- [ ] **Step 2:** cap оценок = `Math.min(200, Math.max(reproductionBudget.maximumEvaluations, attempts + originalSteps.length * 2))`; использовать вместо статической константы в evaluate. Существующий тест «never invokes the 21st evaluation» обновить под формулу (25 шагов, always-true → evaluations 28, minimalSteps 0) — заявленное изменение контракта бюджета.
- [ ] **Step 3 GREEN + suite.** Commit `fix: scale minimization budget with journal length`.

### Task 5: Сигнатуры не схлопывают версии и HTTP-коды

**Files:** Modify `core/src/signature.ts` (normalizeMessage). Test: `core/test/signature.bhtest.ts`.

- [ ] **Step 1 RED:** `version-and-status-segments-survive`: normalizeMessage('/api/v1/x') !== normalizeMessage('/api/v2/x'); 'HTTP 404' !== 'HTTP 500'; при этом 'order 12' ≡ 'order 34' и uuid/query нормализуются как раньше.
- [ ] **Step 2:** числа сохраняются, если непосредственно перед ними `v` (версия) или `HTTP `: замена `\d+(?:\.\d+)?` через callback с проверкой префикса в исходной строке.
- [ ] **Step 3 GREEN + suite** (golden-тесты экспорта содержат копию normalize — синхронизировать шаблон export-playwright.ts и его golden, иначе живой e2e упадёт). Commit `fix: keep version and status codes distinct in signatures`.

### Task 6: Потоковый cap тела node-ответа

**Files:** Modify `presets/node/src/session.ts` (readBodyCapped). Test: `presets/node/test/session.bhtest.ts`.

- [ ] **Step 1 RED:** fixture-эндпоинт отдаёт 100 КБ текста → captured.raw.length ≤ maximumRawBytes (65536).
- [ ] **Step 2:** читать `response.body.getReader()` циклом, накапливая чанки до cap, затем `reader.cancel()`; декодировать TextDecoder(stream). Прежний arrayBuffer-путь удалить.
- [ ] **Step 3 GREEN + suite.** Commit `fix: cap node response body while streaming`.

### Task 7: Мелкие корректности — shellArgument, sameValue, vitest parity

**Files:** Modify `core/src/verify-red.ts` (shellArgument), `presets/node/src/checks.ts` (sameValue), `presets/node/src/export-vitest.ts` (requestHelper, pointerHelper). Test: `core/test/verify-red.bhtest.ts`, `presets/node/test/checks.bhtest.ts`, `presets/node/test/export.bhtest.ts`.

- [ ] **Step 1 RED:** (a) `shellArgument(value, platform)` — win32-ветка удваивает кавычки (`"` → `""`), POSIX без изменений; тесты на оба platform-аргумента. (b) sameValue: объекты с разным порядком ключей равны. (c) сгенерированный vitest: `redirect: 'manual'` в request-хелпере; valueAt разэкранирует `~1`→`/`, `~0`→`~`.
- [ ] **Step 2:** реализовать: сигнатура `shellArgument(value: string, platform: NodeJS.Platform = process.platform)`; sameValue — канонический JSON с сортировкой ключей рекурсивно; строки шаблонов vitest.
- [ ] **Step 3 GREEN + suite.** Commit `fix: correct shell escaping, deep equality and vitest export parity`.

### Task 8: Артефакты merge и diff незакоммиченных

**Files:** Modify `core/src/candidate.ts` (attachCandidateArtifacts), `core/src/run-store.ts` (diffTargets). Test: `core/test/candidate.bhtest.ts`, `core/test/run-store.bhtest.ts`.

- [ ] **Step 1 RED:** (a) кандидат с артефактами replay → attach добавляет session-артефакты, не затирая существующие (union, порядок сохранён). (b) diff-scope: fixture git-репозиторий, незакоммиченное изменение файла из targetMap → цель попадает в targets (сейчас только committed diff).
- [ ] **Step 2:** (a) `artifacts: [...new Set([...candidate.artifacts, ...input.artifacts])]`. (b) объединить `git diff --name-only base...HEAD` и `git diff --name-only HEAD` (рабочее дерево + индекс).
- [ ] **Step 3 GREEN + suite.** Commit `fix: merge candidate artifacts and include uncommitted diff targets`.

### Task 9: Верификация reset

**Files:** Modify `presets/web/src/reset.ts`. Test: `presets/web/test/sweep.bhtest.ts` (или новый reset.bhtest.ts по образцу).

- [ ] **Step 1 RED:** reset-эндпоинт отвечает 500 → находка reset-unsupported с detail RESET_FAILED (сейчас молчаливый успех); reset.url на чужой origin → RESET_FAILED без запроса.
- [ ] **Step 2:** mock-endpoint: `const response = await fetch(...); if (!response.ok) throw new Error('RESET_FAILED: HTTP ' + response.status)`; URL резолвится против baseUrl, origin обязан совпадать с origin baseUrl, иначе RESET_FAILED. storage-flag: поведение сохранить (приватный режим), документировать комментарием.
- [ ] **Step 3 GREEN + suite.** Commit `fix: verify reset outcome and origin`.

---

## Отложено (rulings, не задания)

- **readOnly JS-сабмиты:** детерминированного сигнала «клик шлёт POST» нет; эвристика по обработчикам ненадёжна. Текущий guard + forbiddenActionText — документируемый best-effort.
- **Кнопочная навигация crawl:** требует эвристик по onclick/router; отдельный дизайн, вне hardening.
- **Видимость elementCount:** смена семантики сломает контракт и golden; вместо этого добавить строку в скилл-карту «elementCount считает все DOM-узлы, включая скрытые» (docs-правка в Task 7 коммите).
- **Red-классификация Playwright по префиксу:** JSON-репорт не несёт matcherResult; таймауты всего теста уже дают broken. Ограничение документировать в скилл-карте red-test.

## Release

После мержа P3: пересборка payload 0.2.6, release-гейты standing-процессом (включая push main, отложенный с плана 1).
