# Task 6: Core MCP Tools, Auth, and Scripted Discovery Integration

## Status

Implemented without commits, new dependencies, or further agents. The nine core MCP tools, manual authentication capture, scripted real-Chrome discovery, real MCP SDK stdio handshake, and startup dependency diagnostics are covered by `test/core-integration.bhtest.ts`.

## RED / GREEN evidence

### RED

Command:

```bash
cd .kimi-code/bughunter/server
node --test test/core-integration.bhtest.ts
```

Initial result: **4 tests, 0 passed, 4 failed**.

- Real stdio client failed with `MODULE_NOT_FOUND` for `src/index.ts` / `Connection closed`.
- Auth verification failed with `ERR_MODULE_NOT_FOUND` for `src/auth.ts`.
- Missing-dependency startup verification failed because `src/index.ts` did not exist.
- Scripted discovery initially missed the transient `NaN` state. Investigation showed that `calculateTotal([])` renders `NaN`, but the local `/api/orders` response can arrive before the post-navigation scan. The test now delays only that fixture response through the explicitly permitted direct Page fixture setup, then observes the initial state through public `manager.probe()`; production detectors and session behavior were not changed.

A subsequent RED run after the first implementation had **2 passed, 2 failed** (discovery timing and an incorrect test expectation for the auth path). After correcting the module-derived path expectation to `bughunter/state/auth/storage-state.json` and making fixture timing deterministic, one discovery assertion remained RED until the delayed response setup was added.

### GREEN

Focused command:

```bash
node --test test/core-integration.bhtest.ts
```

Result: **4 passed, 0 failed**.

Full verification commands:

```bash
npm test
npm run typecheck
```

Results:

- `npm test`: **38 passed, 0 failed, 0 cancelled, 0 skipped**.
- `npm run typecheck`: **exit 0**, no TypeScript errors.

## MCP implementation and stdio evidence

`src/index.ts` registers exactly:

1. `bh_start_run`
2. `bh_resume_run`
3. `bh_open`
4. `bh_state`
5. `bh_act`
6. `bh_navigate`
7. `bh_probe`
8. `bh_report_candidate`
9. `bh_close`

Each tool has a short Russian description and a strict Zod input object. Outputs use one text content item containing compact `JSON.stringify(value)` data. `bh_state`, `bh_navigate`, and `bh_probe` remove internal semantic locators from element output; `bh_start_run` returns only `runId` and `routes`; `bh_open` returns only `sessionId`; `bh_close` returns `{ "ok": true }`.

The adapter consumes the existing `ensureConfig`, `loadConfig`, `findProjectRoot`, `createRun`, `readRun`, and `SessionManager` exports. It does not duplicate route selection, navigation guards, forbidden-action checks, step accounting, signal collection, candidate persistence, or artifact handling. `bh_resume_run` combines `readRun` with existing candidate JSON files and returns compact `{ runId, stages, candidates }`, where candidates contains only unprocessed `{ candidateId, title, status }` entries.

Known failures are returned as compact JSON `{ code, message }` with `isError: true`. Mappings include `CONFIG_CREATED`, `CONFIG_INVALID`, `LIMIT_REACHED`, `FORBIDDEN_ORIGIN` (including the existing `NAVIGATION_NOT_ALLOWED` error), `FORBIDDEN_ACTION` (including `FORM_SUBMISSION_BLOCKED`), and `NOT_FOUND`. Existing unsuccessful `bh_act` results with known safety/limit codes are converted to MCP errors without executing extra work.

The stdio test uses the actual `@modelcontextprotocol/sdk` `Client` and `StdioClientTransport`, spawning `node src/index.ts`. It performs the protocol handshake, calls `tools/list`, asserts the exact nine-name set, Russian descriptions, `additionalProperties: false`, and required input keys for every tool. Against a temporary real HTTP fixture and real Chrome it successfully calls start/open/state/act/report_candidate/resume/close and asserts their exact compact keys. It also verifies a real read-only form submission returns `isError: true` with `FORBIDDEN_ACTION`, and a missing resume returns compact single-line `NOT_FOUND`. Client, transport/child, HTTP fixture, and temporary state cleanup all run through `Promise.allSettled`.

## Scripted discovery evidence

The test starts Vite programmatically on an ephemeral loopback port, writes runs to a temporary state directory, launches real Chrome through the existing `SessionManager`, and closes all sessions/browser, Vite, and temporary state in `finally`.

Exact asserted signal evidence:

- Bug 1, `/profile`: after filling `profile-name` with `""` and clicking `profile-save`, at least one `pageerror` signal is present. The fixture exception is `Profile name is required`.
- Bug 2, `/orders/new`: after filling `order-quantity` with `"0"` and clicking `order-create`, a `response` signal message contains `500` (the fixture emits `POST <ephemeral-origin>/api/orders: HTTP 500`).
- Bug 4, `/orders`: a delayed deterministic fixture response exposes the initial empty-orders render; the public reload probe returns an `anomaly` signal whose message contains `NaN`.
- Bug 5, `/orders?page=2`: after draining initial signals and calling the public reload probe, a `console` signal message contains `filter reset` (the fixture message is `Orders page filter reset`).
- Clean page, `/clean`: `manager.state(sessionId).signals` is exactly `[]`.

The detector implementation calls the text signal kind `anomaly` (not the brief pseudocode's `anomalyText`); the test uses the actual reviewed export behavior as requested.

## Safety verification

No safety implementation was edited or weakened. The full suite passed the existing safety coverage, including:

- `navigation guards reject external URL tricks before network and allow same-origin control`
- `forbidden action text and read-only form submission are rejected before journaling`
- `step limit covers actions and probes without executing or journaling excess work`
- `navigate returns zero steps left after the final allowed step`
- storage-state loading and signal drain coverage

MCP handlers delegate to those same reviewed methods rather than bypassing them.

## Manual authentication

`src/auth.ts` exports `runAuth(): Promise<void>`. It loads the same validated default config, launches Chrome with exactly `{ channel: "chrome", headless: false }`, opens `baseUrl`, and displays `Войдите в открытом Chrome, затем нажмите Enter здесь…` through `readline/promises` on stderr. Only after Enter does it create the parent directory and save browser storage state.

The verified destination is derived from `import.meta.dirname`, never cwd:

```text
.kimi-code/bughunter/state/auth/storage-state.json
```

The readline interface and browser are closed in `finally`. Automated tests verify the headed launch options, exact path, and exported operation; they deliberately do not simulate a login or run the interactive flow.

Manual operation:

```bash
cd .kimi-code/bughunter/server
npm run auth
```

The user must complete the real login in the opened Chrome window, return to the terminal, and press Enter. This interactive login was not performed during the automated run.

## Startup behavior

`src/index.ts` validates Node.js >=22.18 before dynamically loading the MCP SDK, Zod, transport, or browser-related modules. Missing modules produce this stderr instruction and a nonzero exit:

```text
Зависимости Bughunter не установлены. Выполните: cd .kimi-code/bughunter/server && npm ci
```

The startup test executes a copy outside the dependency tree and verifies nonzero exit, the friendly stderr message, and completely empty stdout. Protocol stdout is reserved for MCP. A `start` script now runs `node src/index.ts`; the existing `auth` script remains intact.

## Files changed

- Created `.kimi-code/bughunter/server/src/index.ts`: runtime/dependency checks, nine tool registrations, compact responses/error mapping, lazy shared `SessionManager`, stdio transport, and shutdown cleanup.
- Created `.kimi-code/bughunter/server/src/auth.ts`: real manual headed-Chrome login confirmation and storage-state capture.
- Created `.kimi-code/bughunter/server/test/core-integration.bhtest.ts`: scripted discovery, real SDK stdio, auth options/path, and missing-dependency startup tests.
- Modified `.kimi-code/bughunter/server/package.json`: added the `start` script.
- Created this report at `.superpowers/sdd/task-6-report.md`.

No detector, session, config, run-store, fixture application, lockfile, or unrelated source files were changed.

## Self-review and concerns

- All requested Task 6 files and behaviors are present; full tests and typecheck are green on the deliverable.
- The MCP layer is deliberately thin and retains existing origin/action/limit protections.
- `bh_resume_run` now includes stage state and compact unprocessed candidates; later tasks may enrich reporting without changing this core contract.
- Real headless Chrome was available and all browser integration checks passed. No Chrome discovery limitations were observed.
- Headed manual authentication still requires a real user and real credentials; only its non-interactive path/options were automated, as required.
- The `NaN` signal is transient when the fixture API responds immediately. The scripted test uses a deterministic response delay to make that real initial render observable; this is documented test setup, not a production workaround.
- No commits were created and no background tasks remain.


## Review fixes: additional TDD evidence

### RED 1 — isolated successful stdio lifecycle

After extending the real SDK test with a temporary project, real HTTP form fixture, strict-schema assertions, and successful browser-backed calls, the focused command was run before the corresponding server changes:

```bash
node --test test/core-integration.bhtest.ts
```

Result: **3 passed, 1 failed**. The stdio lifecycle stopped at `bh_start_run`: actual routes were `["/", "/orders", "/orders/new", "/profile"]` instead of the temporary config routes. This proved the child ignored the test's `BUGHUNTER_STATE_DIR` and used default state. The single default-state run created by this RED, `20261110T164108.451Z-5cc44ea8483f`, was removed immediately; no other run data was touched.

Minimal isolation fix: `src/index.ts` now resolves optional `BUGHUNTER_STATE_DIR`, retaining the original module-derived default. No MCP tool name, input, or output contract was changed.

### RED 2 — read-only form mapping

With isolated state enabled, the same focused command again returned **3 passed, 1 failed**. Real `bh_act` on the fixture's submit button reached the existing read-only guard, but the MCP response had `isError: undefined` instead of `true` because `FORM_SUBMISSION_BLOCKED` was not a recognized MCP error. The only behavioral fix was to map it to compact `FORBIDDEN_ACTION`; session safety logic was unchanged.

### RED 3 — resume candidates and compact shape

After the form mapping fix, the focused command returned **3 passed, 1 failed** at the successful `bh_resume_run` assertion. Actual top-level keys were:

```text
createdAt, id, routes, scope, stages, status, updatedAt
```

Required keys were:

```text
candidates, runId, stages
```

The implementation now reads the existing run record and candidate directory, filters `status === "unprocessed"`, sorts by `createdAt`, and returns only:

```json
{
  "runId": "<run id>",
  "stages": { "explore": "pending", "reproduce": "pending", "triage": "pending", "export": "pending" },
  "candidates": [{ "candidateId": "<candidate id>", "title": "Profile invariant", "status": "unprocessed" }]
}
```

### GREEN after review fixes

Focused result:

```text
tests 4
pass 4
fail 0
```

The successful stdio test now proves these exact result keys through real calls, not mocks:

- `bh_start_run`: `runId, routes`
- `bh_open`: `sessionId`
- `bh_state`: `url, title, elements, signals, stepsLeft`; every element excludes internal `locator`
- `bh_act`: `ok, navigated, signals` for successful fill and click
- `bh_report_candidate`: `candidateId`
- `bh_resume_run`: `runId, stages, candidates`, including the newly reported unprocessed candidate
- `bh_close`: `ok`
- blocked read-only submit: MCP `isError: true`, code `FORBIDDEN_ACTION`
- missing run: MCP `isError: true`, compact single-line `NOT_FOUND`

Cleanup was hardened independently of behavior: scripted discovery uses nested `finally` so browser, Vite, and temporary state cleanup all run; the stdio test uses `Promise.allSettled` for client, transport/child, HTTP fixture, and temporary project removal.

Final full verification after all review fixes:

```bash
npm test
npm run typecheck
```

- `npm test`: **38 passed, 0 failed, 0 cancelled, 0 skipped**.
- `npm run typecheck`: **exit 0**, no errors.
- No commits, dependencies, agents, safety changes, or unrelated edits were introduced.
