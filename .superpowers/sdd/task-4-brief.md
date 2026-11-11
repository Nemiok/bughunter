### Task 4: Signal Signatures, Anomaly Matching, and Semantic Elements

**Files:**
- Create: `.kimi-code/bughunter/server/src/detectors/signals.ts`
- Create: `.kimi-code/bughunter/server/src/detectors/index.ts`
- Create: `.kimi-code/bughunter/server/src/browser/elements.ts`
- Create: `.kimi-code/bughunter/server/test/{signals,elements}.bhtest.ts`

**Interfaces:**
- Produces:
  - `normalizeMessage(message: string): string`
  - `signalSignature(input: SignatureInput): string`
  - `findAnomalyTexts(text: string, anomalies: string[]): string[]`
  - `scanSignals(page: Page, config: Config): Promise<Signal[]>`
  - `collectElements(page: Page): Promise<ElementSnapshot[]>`
  - `toPlaywrightLocator(locator: SemanticLocator): string`
- `SemanticLocator` is a discriminated union of `testid`, `role`, `text`, and `css`, with optional zero-based `index`.

- [ ] **Step 1: Write failing unit tests for normalization and token boundaries**

Cover numbers, UUIDs, URL query values, stack top frame, identical signatures after dynamic IDs change, and different signal types. Include explicit token cases:
```ts
assert.deepEqual(findAnomalyTexts('Total NaN today', ['NaN']), ['NaN']);
assert.deepEqual(findAnomalyTexts('NaNagus undefinedValue', ['NaN', 'undefined']), []);
assert.deepEqual(findAnomalyTexts('literal [object Object]', ['[object Object]']), ['[object Object]']);
```
Escape regex tokens and normalize whitespace before hashing SHA-256.

- [ ] **Step 2: Write failing element tests in Chrome**

Create a small HTML page with hidden buttons, duplicate role/name pairs, a testid, input values, disabled state, and a long accessible name. Assert that only visible interactive elements are returned, names are capped at 80 characters, testid wins over role, duplicates retain distinct indexes, and exported locator expressions preserve exact names.

- [ ] **Step 3: Verify tests fail, then implement the modules**

Run the two test files before source creation and record the expected module-not-found failures. Implement `collectElements` in page context using accessible role/name mapping for button, link, textbox, checkbox, combobox, and select; use Playwright locators to recover exact accessible names where page-context inference is insufficient. Never return DOM or outerHTML.

Implement signal listeners for console, pageerror, requestfailed, response status ≥400, and error boundary appearance. Apply console/request ignore lists before signature creation. `scanSignals` additionally scans visible body text and the configured error-boundary selector; each signal receives a random ID and a stable signature.

- [ ] **Step 4: Verify Task 4**

Run:
```bash
cd .kimi-code/bughunter/server
node --test test/signals.bhtest.ts test/elements.bhtest.ts
npm run typecheck
```
Expected: all PASS with installed Chrome; no browser download occurs.

