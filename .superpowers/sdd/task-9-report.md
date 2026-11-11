# Task 9: Triage Memory and Playwright Export

## Status

Implemented in place with no commits, no new dependencies, no application edits, and no delegated agents. Task 10 red/green execution was intentionally not performed; this task verifies generated source and placement.

## RED evidence

- `node --test test/export.bhtest.ts` initially failed with `ERR_MODULE_NOT_FOUND` for `src/export/playwright.ts`, before the implementation existed. Two initial test-fixture syntax errors were corrected and the command was rerun until it reached this feature-missing failure.
- After adding MCP expectations and real calls, `node --test --test-name-pattern='real MCP stdio' test/core-integration.bhtest.ts` failed because `bh_triage` and `bh_export_e2e` were absent from the tool listing.

## Implementation

### Shared-memory triage

`server/src/run-store.ts` now exports `TriageInput`, `readCandidate`, `readSharedMemory`, and `triageCandidate`.

- `confirmed` rejects signatures already present in `suppressions.json`; otherwise it creates or updates a signature-matched entry in `known-bugs.json`. The stable existing `id` and original `createdAt` are retained, while title, route, reason, source candidate, and `updatedAt` are refreshed.
- `rejected` updates the candidate and only writes `suppressions.json` when `suppress: true`.
- `duplicate` resolves the known bug by signature and writes its stable ID to `duplicateOf`; existing links are retained and no additional known-bug entry is created.
- Candidate, known-bug, and suppression persistence uses the reviewed `writeJsonAtomic` helper. Tests also check that no temporary files remain.

### Standalone Playwright generation

`server/src/export/playwright.ts` exports `generatePlaywrightTest` and `exportE2e`.

- Generated source imports `createHash` from Node and `test`/`expect` from `@playwright/test`; it has no Bughunter or application imports.
- Signal-backed candidates recreate the reviewed normalization/signature algorithm. Listeners for page errors, console errors, failed requests, and HTTP responses are installed before the initial navigation and all replayed steps. Final DOM checks cover configured anomaly text and error boundaries. The sole assertion is the concrete `expect(matched).toBe(false)` for the saved signature.
- Check-backed candidates assert exact saved conditions: visible text with `toBeVisible()`, absent text with `not.toBeVisible()`, and element count with `toHaveCount(savedCount)`.
- Replay prefers `minimalSteps` when present (including an empty array) and otherwise uses `steps`. It supports every action, all four semantic locator forms with `.nth(index)`, allowed navigation, reload, back, and mobile viewport probes.
- Dynamic strings and values are JSON-serialized. Stored semantic locator expressions are parsed and regenerated rather than trusted as arbitrary source. Initial and navigated routes must resolve to the configured base origin and an allowed pathname.
- Every golden verifies one top-level `test(...)`, one concrete `expect(...)`, no `waitForTimeout`, and no `toBeTruthy`.

### `bugId` lookup and placement

The lookup is consistent and run-scoped:

1. Match `known-bugs.json` by stable `id`, then by `sourceCandidate`.
2. If there is no memory match, treat `bugId` as the candidate ID in the supplied run and resolve its known bug by signature.
3. Select a same-signature candidate only from the supplied run, preferring the memory entry's source candidate and then the newest candidate.
4. Require that candidate to be `confirmed` and `reproduced`; unreproduced export fails before creating an e2e directory.
5. Always name the file `<known stable id>.spec.ts`, regardless of which alias was supplied.

Placement walks from the current directory to the detected Git root and uses the nearest `package.json` containing `@playwright/test` in either dependencies or devDependencies. Project placement uses `tests.e2e.dir`; otherwise the file stays in `state/runs/<runId>/e2e/`. Identical repeat exports are idempotent. Different existing content causes `EXPORT_FILE_EXISTS`, and exclusive creation closes the creation race; unrelated content is never overwritten.

### MCP

`server/src/index.ts` registers strict-schema `bh_triage` and `bh_export_e2e` tools. The real stdio integration test lists them, validates required inputs, confirms a reproduced candidate, exports it by candidate ID, and verifies that resume no longer returns the processed candidate.

## Golden and behavioral coverage

`server/test/export.bhtest.ts` contains 18 tests covering:

- Exact source goldens for pageerror, requestfailed, response status, anomaly text, and error boundary signatures.
- Exact source goldens for visibleText, notVisibleText, and elementCount.
- Semantic locator indexes, all seven actions, navigation, and all three probes.
- JSON escaping/injection resistance and route rejection.
- Confirmed creation/update, rejection with and without suppression, duplicate linking/retention, and suppressed-confirmation rejection.
- Stable known-bug ID and current candidate ID lookup, including a stable memory entry whose original source candidate is not in the exported run.
- Project and run-directory placement, stable filenames, idempotent repeat export, unrelated-file preservation, and unreproduced rejection.

## Verification (GREEN)

Working directory: `.kimi-code/bughunter/server`.

- `node --test test/export.bhtest.ts` — PASS, 18/18.
- `node --test --test-name-pattern='real MCP stdio' test/core-integration.bhtest.ts` — PASS, 1/1 real MCP flow.
- `node --test test/export.bhtest.ts test/reproduce.bhtest.ts` — PASS, 31/31, including all five real-Chrome seeded-symptom reproduction groups.
- `npm run typecheck` — PASS, exit 0.
- `npm test` — final run PASS, 69/69.

The first full-suite run was 68/69 because the pre-existing `navigation guards reject external URL tricks before network and allow same-origin control` test observed two pages immediately after blocked-popup cleanup. The isolated test passed, no unrelated code was changed, and the subsequent complete suite passed 69/69.

## Files changed

- `.kimi-code/bughunter/server/src/run-store.ts`
- `.kimi-code/bughunter/server/src/export/playwright.ts` (new)
- `.kimi-code/bughunter/server/src/index.ts`
- `.kimi-code/bughunter/server/test/export.bhtest.ts` (new)
- `.kimi-code/bughunter/server/test/core-integration.bhtest.ts`
- `.superpowers/sdd/task-9-report.md` (this report, outside the Bughunter workspace)

## Self-review and concerns

- No Task 10 execution verdict is claimed. Exported tests still need Task 10's actual red/green execution against broken and fixed application copies.
- Signal generation deliberately uses saved signatures because the reviewed `Candidate` persists signal IDs but not signal payloads. This supports all reviewed signal kinds, including console errors, without inventing symptom fields.
- Anomaly and error-boundary assertions inspect the final DOM; transient DOM-only symptoms that disappear before the assertion are not observed. Page error, console, and network listeners capture events throughout replay.
- Atomicity is per JSON file replacement, matching the reviewed store. There is no cross-process read-modify-write lock or transaction spanning candidate and memory files; concurrent triage writers could still lose updates.
- No test-spawned server/browser process was left running. A pre-existing relative-path `node .kimi-code/bughunter/server/src/index.ts` process (PID 26853, started before these checks) was left untouched.


## Review fixes: focused RED/GREEN

Three regression tests were added to `.kimi-code/bughunter/server/test/export.bhtest.ts` before changing production code.

### RED evidence

Command: `node --test test/export.bhtest.ts`

Result: exit 1; 21 tests, 18 passed, 3 failed. The existing 18 tests remained green. Exact failures:

1. `export starts at the persisted journal route before an SPA step that reaches the reported route` — `AssertionError: The expression evaluated to a falsy value` at the assertion that source contains initial navigation to `/`. The generated source incorrectly used the later candidate route `/profile`.
2. `export rejects malicious stable bug IDs without writing outside the selected destination` — `AssertionError: Missing expected rejection` for `../escape`.
3. `elementCount rejects non-finite, string, negative, and fractional expected values` — `AssertionError: Missing expected exception` for `NaN`.

### Fixes

- `exportE2e` now loads `state/runs/<runId>/journals/<candidate.sessionId>.json`, validates its run/session identity, and passes `journal.route` into `generatePlaywrightTest`. The generator accepts an optional initial-route argument defaulting to `candidate.route`, preserving direct unit-test compatibility while exports match reproduction's initial route. The SPA regression starts at `/`, replays a link click, and reports at `/profile`; it verifies source order and the absence of an initial `/profile` navigation.
- Resolved known stable IDs must match `^[A-Za-z0-9][A-Za-z0-9._-]*$` and cannot be `.` or `..`. The final output is resolved and checked with `relative`/`isAbsolute` against the selected project or run e2e destination before `writeExport` can create directories. Tests cover both `../escape` and an absolute path and assert that the escaped files do not exist.
- `elementCount` now accepts only a number that is finite, integral, and nonnegative; omitted values retain the reviewed default of zero. `NaN`, positive infinity, string `"2"`, `-1`, and `1.5` all fail with `ELEMENT_COUNT_EXPECTED_INVALID`, preventing invalid generated assertions such as `toHaveCount(null)`.

### GREEN and regression evidence

Working directory: `.kimi-code/bughunter/server`.

- `node --test test/export.bhtest.ts` — exit 0; 21 tests, 21 passed, 0 failed. This includes all approved triage, project/run placement, stable-ID alias, unrelated-file protection, and idempotent-export tests.
- `npm test` — exit 0; 72 tests, 72 passed, 0 failed, 0 cancelled/skipped/todo; duration 22496.633334 ms.
- `npm run typecheck` — exit 0; `tsc` produced no diagnostics.

Only `.kimi-code/bughunter/server/src/export/playwright.ts`, `.kimi-code/bughunter/server/test/export.bhtest.ts`, and this report were changed for the review fixes. No commits, dependencies, agents, or application edits were added. Task 10 execution remains the only previously documented verification boundary.
