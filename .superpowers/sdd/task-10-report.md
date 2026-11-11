# Task 10: Prove Every Exported E2E Is Red Then Green in a Fixed Copy

## Status

Complete. The focused integration and complete server verification pass. No commits, agents, network installs, new server dependencies, or original fixture source edits were made.

## Implementation

Created:

- `.kimi-code/bughunter/server/test/e2e-export.bhtest.ts`
- `.kimi-code/bughunter/server/fixtures/buggy-app/playwright.config.ts`

The harness performs real Chrome discovery with `SessionManager`, calls `reproduceCandidate` with three attempts, reads the persisted candidate and journal data, confirms triage, and calls the real `exportE2e`. Each bug receives a new temporary fixture copy and state directory. Fixture `node_modules` is symlinked into the copy; no `npm ci` or network install is run. Vite uses a reserved ephemeral loopback port with `strictPort`, and every cache, Playwright output, generated test, trace, screenshot, and video remains below the temporary suite root.

For bug 3, a test-only hook in the disposable Vite config resets the in-memory orders to the two seeded rows on every GET of `/orders/new`. Every initial reproduction, minimization evaluation, exported RED/GREEN run, and original-source verification enters through that navigation, so each starts with fresh order state. The original `vite.config.ts` is never edited; original-source verification uses a temporary hooked config with the original app root. The harness consumes the actual persisted minimizer output without modifying it.

For all five bugs, exact original and minimal step arrays are asserted, including action names and semantic locators. The exported source must also exactly equal `generatePlaywrightTest` output for the persisted candidate, minimal steps, config, and journal route.

Each exported test is executed using the required command shape:

```bash
npx playwright test <generated-file> --reporter=line --workers=1
```

The harness requires exit 1 plus the exact generated symptom source in the red output. It rejects command timeouts, signals, syntax errors, missing imports, and Playwright test timeouts as broken exports. Green requires exit 0 and `1 passed`.

Playwright uses the installed `chrome` channel headlessly. `BUGHUNTER_SLOW_MO=100` is set only for the asynchronous HTTP-500 export so its response event arrives before the final signal assertion. Bug 4 uses a 250 ms server-middleware delay for `/api/orders`, matching the discovery condition and making the initial empty-total render observable; this does not edit either original or copied fixture source.

## TDD initial RED

Before creating `playwright.config.ts`, the initial focused run was:

```bash
node --test test/e2e-export.bhtest.ts
```

Result: exit 1, 0/1 passing, with:

```text
ENOENT: no such file or directory, open '.../fixtures/buggy-app/playwright.config.ts'
```

This was the expected missing-configuration RED, not a generated-test symptom result.

For review hardening, the manual bug-3 substitution was removed and exact journal assertions were added before installing the reset hook. The focused run captured RED with actual persisted minimal steps `[Orders click]` versus expected `[Create dblclick, Orders click]`. This directly reproduced the shared-state minimizer defect; the reset hook was then added before the GREEN run.

## Per-bug evidence

The final focused run passed 7/7 tests (five bugs, the parent, and original-fixture verification). The subsequent full `npm test` independently repeated all red/green proof and passed 79/79.

### Bug 1: empty profile name

- Reproduction ratio: **3/3**.
- Original journal steps: 2; exported minimal steps: **1** (`profile-save` click).
- RED: exit 1; `expect(matched).toBe(false);` failed with `Received: true` for the page-error signature.
- Fixed-copy patch: replace the empty-name throw with an early return.
- GREEN: exit 0, `1 passed`.
- Original-fixture rerun: exit 1 on the same symptom assertion.

### Bug 2: zero quantity reaches the API

- Reproduction ratio: **3/3**.
- Original journal steps: 3; exported minimal steps: **2** (fill quantity `0`, click Create).
- RED: exit 1; `expect(matched).toBe(false);` failed for the normalized HTTP-500 response signature.
- Fixed-copy patch: reject zero in `createOrder`, set UI status 400, and return before `fetch`.
- GREEN: exit 0, `1 passed`.
- Original-fixture rerun: exit 1 on the same symptom assertion.

### Bug 3: double click creates a duplicate order

- Fresh-state reproduction ratio: **3/3**.
- Original journal steps: 3; actual persisted/exported minimal steps: **2** (`order-create` double click, Orders navigation), produced by the unmodified minimizer.
- RED: exit 1; `expect(page.getByText("Order 4: 10", { exact: true }).first()).not.toBeVisible();` failed because the duplicate row was visible.
- Fixed-copy patch: add pending state, guard re-entry, set pending before the API call, clear it after the response, and disable Create while pending.
- GREEN: exit 0, `1 passed` after restarting the same fixed copy; the disposable navigation hook also resets orders for the run.
- Original-fixture rerun: exit 1 on the same symptom assertion using original app source and the temporary reset-hook config.
- State handling: every initial attempt and step-removal evaluation starts through `/orders/new`, which restores exactly the two seeded orders. No assignment or overwrite of `candidate.minimalSteps` remains.

### Bug 4: empty total renders NaN

- Reproduction ratio: **3/3**.
- Original journal steps: 1; exported minimal steps: **0** (the initial delayed empty render is sufficient).
- RED: exit 1; `expect(matched).toBe(false);` failed for the `NaN` anomaly signature.
- Fixed-copy patch: `Number(orders[0]?.amount ?? 0)`.
- GREEN: exit 0, `1 passed`.
- Original-fixture rerun: exit 1 on the same symptom assertion.

### Bug 5: page 2 resets the filter

- Reproduction ratio: **3/3**.
- Original journal steps: 2; exported minimal steps: **0** (initial navigation to `/orders?page=2` emits the console error).
- RED: exit 1; `expect(matched).toBe(false);` failed for the console-error signature.
- Fixed-copy patch: initialize `page` from `requestedPage` and remove the filter-reset console error effect.
- GREEN: exit 0, `1 passed`.
- Original-fixture rerun: exit 1 on the same symptom assertion.

No export was broken at completion: all ten per-copy RED/GREEN executions and all five original-fixture RED executions reached their intended assertions without syntax, import, or timeout failures.

## Original fixture integrity

The integration hashes these files before and after all runs and asserts deep equality:

| File | SHA-256 |
|---|---|
| `index.html` | `c2dedcd622064b5fcba1d49c011a273b76ad4f22ebc0ef56c8df989ad4d57918` |
| `package.json` | `f1cb1f337f7bdda56ed497faa4fde2c08652eab07bbb1781c10e4306e5d8ecf4` |
| `package-lock.json` | `99919808c9939798c2ffaeb801a437b8d0fba2663bbbca979eea9bf59ae0170d` |
| `playwright.config.ts` | `5a6cf2ceb17285968128e936aa4e129c96a26663669bd33b2122580cf605f548` |
| `src/App.tsx` | `ca9e14aa53ac9370b94afeae032f384a1b184d222028c3211f68c1f63339c44d` |
| `src/main.tsx` | `35f6687f0047963874af0e81a5f450fd4c7508e519c9e1d8558c9b88ca5568a0` |
| `src/styles.css` | `56f21edad52ad4b1c07c6dff36ed47be13d3eb463d2b28a282e40eec3a06bd12` |
| `vite.config.ts` | `a03ea4fe93deb3f9f18795b6627210d665617d45357ebdd9c01c28818114eee3` |

`git diff -- .kimi-code/bughunter/server/fixtures/buggy-app` was empty after the runs. The enclosing repository already reports the entire `bughunter` directory as untracked, so the hash assertion is the authoritative original-source integrity check. Unrelated pre-existing repository status entries were left untouched.

## Verification commands

Run from `.kimi-code/bughunter/server`:

```bash
node --test test/e2e-export.bhtest.ts
```

Final result: exit 0; **7 tests, 7 passed, 0 failed**. Five bug subtests logged `redExit: 1` and `greenExit: 0`; original verification logged `originalFixtureRed: 5`.

```bash
npm test
```

Result: exit 0; **79 tests, 79 passed, 0 failed**, including the complete integration and all previous tests.

```bash
npm run typecheck
```

Result: exit 0; TypeScript reported no errors.

## Cleanup

All Vite servers, Chrome sessions, and Playwright commands exited. A process check found no matching harness/debug processes. Temporary suite roots were removed by test cleanup. Three standalone debugging directories whose Vite caches were recreated asynchronously during early diagnosis were explicitly removed; a final temp-directory scan found no remaining matching artifacts.

## Concerns / follow-up

- Bounded exported-test robustness debt remains: bug 2 relies on a fixed **100 ms Playwright slowMo**, and bug 4 relies on a fixed **250 ms orders-API delay**. Both controls are confined to this harness and passed focused and full-suite runs, but the generated signal tests themselves still do not explicitly await a matching response or retain transient anomaly history. They may remain timing-sensitive outside these controls; a future exporter should encode event-based waiting or transient observation instead of elapsed-time margins.
- The reset hook proves fresh-state minimization for the seeded orders app only. General application-state isolation across replay evaluations remains app-specific and is not solved in production reproduction code.
