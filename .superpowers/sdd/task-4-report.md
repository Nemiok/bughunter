# Task 4 report: Signal Signatures, Anomaly Matching, and Semantic Elements

## Status

Implemented the requested detector and semantic-element modules, their shared task-specific types, and real Node/Chrome tests. No SessionManager or MCP registration was added. No dependencies, browser downloads, commits, or unrelated edits were made.

## RED evidence

All test files were written before their implementation modules.

```bash
cd /Users/nemiok/Desktop/projects/vault/bughunter/.kimi-code/bughunter/server
node --test test/signals.bhtest.ts
```

Result: exit 1, expected `ERR_MODULE_NOT_FOUND` for `src/detectors/index.ts`; 0 tests ran.

After creating `test/elements.bhtest.ts` and before creating `src/browser/elements.ts`:

```bash
node --test test/signals.bhtest.ts test/elements.bhtest.ts
```

Result: exit 1, expected `ERR_MODULE_NOT_FOUND` for `src/browser/elements.ts`; the four then-existing signal tests passed.

A later self-review added an embedded-dynamic-number case before broadening number normalization:

```bash
node --test test/signals.bhtest.ts
```

Result: exit 1; 4 passed and 1 failed. `Missing orderABC123 in chunk456.js` was unchanged, proving the new assertion caught the missing normalization behavior.

During the first browser-signal run, the test itself used `page.route('**/failed')` with a query-bearing URL. The resulting request was not intercepted and no `requestfailed` event occurred. The test glob was corrected to `**/failed*`; detector code was not changed to mask that setup error.

## GREEN evidence

Initial detector implementation:

```bash
node --test test/signals.bhtest.ts
```

Result after correcting the test route glob: exit 0; 4/4 tests passed. This covered normalization, signatures, literal anomaly boundaries, real console/pageerror/network events, visible body anomalies, error-boundary appearance, ignores, IDs/signatures/routes, and drain-on-read behavior.

Initial element implementation:

```bash
node --test test/elements.bhtest.ts
```

Result: exit 0; 2/2 tests passed in installed Chrome. Real visibility, accessible names, test IDs, duplicate role/name indexes, input/select values, disabled state, 80-character snapshot names, and exact locator expressions were asserted.

Final required and regression verification:

```bash
node --test test/signals.bhtest.ts test/elements.bhtest.ts && npm test && npm run typecheck
```

Results:

- Task 4 tests: exit 0; 7/7 passed, 0 failed.
- Full server suite: exit 0; 20/20 passed, 0 failed.
- `tsc`: exit 0 with no diagnostics.

Tests launched `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` through `playwright-core`. No browser installation command was run. The signal test's ephemeral HTTP server and all browsers/pages were closed in test cleanup; no fixture or background server was left running.

## Files created

- `.kimi-code/bughunter/server/src/detectors/signals.ts`
- `.kimi-code/bughunter/server/src/detectors/index.ts`
- `.kimi-code/bughunter/server/src/browser/elements.ts`
- `.kimi-code/bughunter/server/test/signals.bhtest.ts`
- `.kimi-code/bughunter/server/test/elements.bhtest.ts`
- `/Users/nemiok/Desktop/projects/vault/.superpowers/sdd/task-4-report.md`

## File modified

- `.kimi-code/bughunter/server/src/types.ts`: added only `SemanticLocator` and `ElementSnapshot`; existing public contracts were preserved.

## Interface decisions

- `SignatureInput` is `{ kind, message, route, stack? }`. `signalSignature` returns a full lowercase SHA-256 hex digest over the signal kind, normalized message, normalized route, and normalized top stack frame.
- `normalizeMessage` replaces URL query values, UUIDs, all numeric sequences (including embedded dynamic IDs), and whitespace runs before hashing.
- `findAnomalyTexts` escapes configured strings and applies Unicode letter/number/underscore token boundaries. Matching remains case-sensitive and returns configured anomaly strings in configuration order.
- Signal kinds are `console`, `pageerror`, `requestfailed`, `response`, `anomaly`, and `errorBoundary`. IDs use `randomUUID()`, timestamps use ISO strings, and routes use the current URL pathname.
- Console/request ignores use configured substring matching. Only `console.error`, failed requests, and responses with status >=400 produce event signals.
- `scanSignals` installs page listeners once, observes error-boundary mutations, scans visible body text and visible boundary elements, and drains the buffered signals. Persistent anomalies/boundaries are not repeatedly emitted until their visible state changes.
- `SemanticLocator` uses `kind` as the discriminator. Testid/text/css variants carry `value`; role carries `role` and `name`; every variant supports optional zero-based `index`.
- `ElementSnapshot` contains `id`, `role`, capped `name`, `type`, optional `value`/`disabled`, and `locator`. The locator retains the full exact accessible name even when the displayed snapshot name is capped.
- `collectElements` maps button, link, textbox, checkbox, and combobox/select controls; uses real Playwright visibility and ARIA snapshots for exact names; gives testid locators priority; and indexes only duplicate semantic locators. No DOM nodes or HTML strings cross the page boundary.
- `toPlaywrightLocator` emits `page.getByTestId`, `page.getByRole(..., { exact: true })`, `page.getByText(..., { exact: true })`, or `page.locator`, with JSON string escaping and `.nth(index)` where present.

## Self-review

- Every requested export is present; `src/detectors/index.ts` reexports all detector functions and `SignatureInput`.
- Existing `Signal` and `Config` definitions were reused without modification.
- Tests exercise actual Chrome accessibility and visibility behavior rather than DOM-only approximations.
- Duplicate role/name elements receive indexes 0 and 1; unique locators omit `index`.
- Exact accessible names and quotes are preserved through JSON-based locator serialization.
- No source maps, SessionManager, MCP tools, package changes, generated artifacts, or commits were introduced.

## Concerns / follow-up for SessionManager

- `scanSignals` intentionally uses drain-on-read semantics; SessionManager should call it for each state/action/probe result rather than maintaining a second signal buffer.
- Listener callbacks retain the detector config from their first scan for that page. Configuration changes during a page lifetime will not retroactively change those listeners.
- Signal stack handling intentionally uses the top raw stack frame without source maps, as required by the MVP specification.


## Review fixes: locator completeness, native roles, boundary reconciliation, and testid indexes

No commits, dependencies, browser downloads, agents, or unrelated edits were added during review remediation. Drain-on-read and static per-page detector configuration remain unchanged.

### Chrome channel configuration

Replaced both hard-coded `executablePath` launch objects with:

```ts
chromium.launch({ channel: 'chrome', headless: true })
```

```bash
node --test test/signals.bhtest.ts test/elements.bhtest.ts
```

Result: exit 0; existing 7/7 tests passed using the installed Chrome channel.

### RED: locator priority and native input roles

Added real-page tests for testid, role, text, and CSS outputs; custom `tabindex` controls; radio; range; datalist; and unsupported date input exclusion.

```bash
node --test test/elements.bhtest.ts
```

Result: exit 1; 2 passed, 2 failed.

- Locator priority test returned only the native role element, omitting all three custom controls.
- Native-role test returned `textbox` for radio, range, and datalist inputs and incorrectly included the date input.

After implementation, the CSS fixture still failed because its empty div had zero area and was correctly rejected by Playwright visibility. The fixture received explicit 20x20 dimensions; visibility filtering was not weakened.

```bash
node --test test/elements.bhtest.ts
```

GREEN result: exit 0; 4/4 element tests passed.

### RED: boundary reappearance and hidden duplicate testid

Added regressions for a boundary hidden and reshown between scans, and a visible testid target preceded by a hidden duplicate.

```bash
node --test test/signals.bhtest.ts test/elements.bhtest.ts
```

Result: exit 1; 9 passed, 2 failed.

- Duplicate testid locator omitted `index: 1`.
- Boundary hide/show produced 0 new appearances instead of exactly 1.

### GREEN: focused and full verification

Boundary mutation handling now reconciles the complete visible-text set, clearing hidden entries and emitting only newly visible entries. Testid indexes and duplicate counts now come from all matching DOM elements, including hidden elements, matching `page.getByTestId(...).nth(...)`.

```bash
node --test test/signals.bhtest.ts test/elements.bhtest.ts
```

Result: exit 0; 11/11 Task 4 tests passed.

```bash
npm test && npm run typecheck
```

Results: full suite exit 0 with 24/24 passed and 0 failed; `tsc` exit 0 with no diagnostics.

### Review interface decisions

- Locator selection is strictly testid, then actual semantic role, then exact visible text, then a unique CSS selector. Custom controls without explicit/native widget roles remain `generic` in snapshots rather than receiving invented roles.
- Custom interactive discovery covers explicit supported widget roles, `tabindex`, `onclick`, and contenteditable elements. CSS fallback uses an escaped ID when available, otherwise a structural `nth-of-type` path.
- Native input mappings include checkbox, radio, slider, spinbutton, searchbox, combobox for text-like inputs with `list`, button, and textbox. Unsupported native types such as date are excluded instead of mislabeled.
- Boundary observer callbacks report all currently visible boundaries; shared reconciliation logic is used by both mutation handling and scans.
- Testid indexes include hidden and otherwise unsupported matching elements so exported `.nth(index)` expressions resolve against Playwright's actual full match set.


## Residual review fix: search input with datalist

Added `<input type="search" list="choices">` to the native-input role regression, with expected role `combobox` and accessible name `Search datalist choice`.

### RED

```bash
node --test test/elements.bhtest.ts
```

Result: exit 1; 4 passed, 1 failed. The native-input assertion reported actual role `searchbox` for `Search datalist choice`, expected `combobox`. All other element tests passed.

### Fix and GREEN

Moved the text-like `list` attribute check ahead of standalone `type === "search"` handling in `inferredRole`. No other production behavior was changed.

```bash
node --test test/elements.bhtest.ts && npm test && npm run typecheck
```

Results:

- Focused element tests: exit 0; 5/5 passed, 0 failed.
- Full `npm test`: exit 0; 24/24 passed, 0 failed.
- `npm run typecheck` / `tsc`: exit 0 with no diagnostics.

No commits or unrelated changes were made.
