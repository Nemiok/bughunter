# Bughunter MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete portable `.kimi-code/` Bughunter MVP and verify deterministic discovery, reproduction, regression-test export, and Jest/Vitest red-test classification.

**Architecture:** A stdio MCP server owns all deterministic browser, state, safety, reproduction, export, and test-runner behavior. Kimi agents only choose exploration actions, review candidates, and write unit tests. JSON run state and semantic journals connect the stages; Playwright Core drives installed Chrome.

**Tech Stack:** Node ≥22.18 (installed: 24.14.0), TypeScript strict ESM with native type stripping, MCP SDK, Playwright Core, Zod, node:test, Vite/React, Vitest, Jest, Kimi Code CLI 2.5.2.

## Global Constraints

- Put the deliverable under `.kimi-code/` in `/Users/nemiok/Desktop/projects/vault/bughunter`; preserve the original prompt and all unrelated user changes.
- Server source must run directly with `node src/index.ts`; no build, `enum`, `namespace`, parameter properties, or extensionless local imports.
- Use only `@modelcontextprotocol/sdk`, `playwright-core`, and `zod` as server runtime dependencies; only `typescript` and `@types/node` as server devDependencies.
- Use `channel: 'chrome'`; never download a browser.
- Server tests use `node:test` and `*.bhtest.ts`; fixture tests may use their own framework conventions.
- Prefix Bughunter-owned files with `bughunter` or `bh-` where the source specification requires it.
- Do not add agent `model`, `[secondary_model]`, `override`, AgentSwarm, background explorers, CI, source maps, Cypress, or application fixes.
- Never commit or publish unless the user separately asks; the commit steps normally used by the workflow are intentionally omitted.
- After every numbered stage, report what changed, exact verification results, and decisions or blockers.
- Manual CLI checks are mandatory gates. Do not claim them from documentation or automated tests alone.

## File Structure

- `.kimi-code/bughunter/server/src/{index,config,types,project,run-store}.ts` — process entry, validated configuration, shared types, project-root discovery, durable state.
- `.kimi-code/bughunter/server/src/browser/{elements,session}.ts` — element snapshots, semantic locators, Chrome sessions, journals, safety.
- `.kimi-code/bughunter/server/src/detectors/{index,signals}.ts` — deterministic signals, normalization, signatures, anomaly/error-boundary polling.
- `.kimi-code/bughunter/server/src/{reproduce,auth}.ts` — replay/minimization and manual storage-state capture.
- `.kimi-code/bughunter/server/src/export/playwright.ts` — journal-to-e2e generation.
- `.kimi-code/bughunter/server/src/tests/{detect,verify-red}.ts` — framework detection and one-file verdicts.
- `.kimi-code/bughunter/server/test/*.bhtest.ts` — deterministic unit/integration coverage.
- `.kimi-code/bughunter/server/fixtures/{buggy-app,jest-project,vitest-project}/` — seeded application and runner fixtures.
- `.kimi-code/{agents,skills}/` — entry skill, three agents, oracle and red-test skills.
- `.kimi-code/bughunter/state/` — committed config/memory templates; ignored auth/run data.
- `.kimi-code/bughunter/README.md` — installation, CLI compatibility findings, operation, isolation, limitations.

---

### Task 1: Verify Kimi Code CLI Compatibility

**Files:**
- Create: `.kimi-code/bughunter/README.md`
- Create: `.kimi-code/bughunter/server/fixtures/cli-probe/README.md`

**Interfaces:**
- Consumes: installed `kimi` 2.5.2 and official documentation.
- Produces: four recorded facts: stdio working directory, `/bughunter` alias behavior, project-agent discovery, and project-skill access from a subagent.

- [ ] **Step 1: Read product documentation before creating configuration**

Invoke the built-in `check-kimi-code-docs` skill with the four compatibility questions from the source specification. Fetch `https://www.kimi.com/code/docs/en/kimi-code-cli/` and the specific MCP, skills, and agents pages linked by the documentation. Record document URLs and whether each statement is explicit or only inferred.

- [ ] **Step 2: Inspect the installed command surface**

Run:
```bash
kimi --version
kimi --help
```
Expected: version `2.5.2`; help lists the actual noninteractive and session options used by the following manual probes. Do not invent unsupported CLI flags.

- [ ] **Step 3: Run isolated CLI probes**

Create the probe directory inside the workspace and initialize it only when execution reaches this task:
```bash
mkdir -p .kimi-code/bughunter/server/fixtures/cli-probe
cd .kimi-code/bughunter/server/fixtures/cli-probe
git init
```
Add the smallest MCP stdio probe, project skill, and agent permitted by the installed CLI documentation. The MCP probe returns `process.cwd()`; the skill returns a fixed token; the agent must invoke that skill and return the token. Launch `kimi` from the probe root, trust the folder interactively, and record actual results in the probe README.

- [ ] **Step 4: Record the compatibility verdict**

Write one `Сверка с Kimi Code CLI` section in `.kimi-code/bughunter/README.md` with four rows: `checked`, actual result, evidence, required adjustment. If `/bughunter` is unavailable, document `/skill:bughunter` rather than claiming the alias works. If MCP cwd is not the project root, specify the documented `cwd` field in the planned `mcp.json` fragment.

- [ ] **Step 5: Stage report**

Report installed version, documentation URLs, manual probe results, and every discrepancy. Do not proceed with an undocumented assumption about cwd or agent discovery.

### Task 2: Server Scaffold, Configuration, Project Root, and Run Store

**Files:**
- Create: `.kimi-code/bughunter/.gitignore`
- Create: `.kimi-code/bughunter/server/package.json`
- Create: `.kimi-code/bughunter/server/tsconfig.json`
- Create: `.kimi-code/bughunter/server/src/types.ts`
- Create: `.kimi-code/bughunter/server/src/project.ts`
- Create: `.kimi-code/bughunter/server/src/config.ts`
- Create: `.kimi-code/bughunter/server/src/run-store.ts`
- Create: `.kimi-code/bughunter/state/{known-bugs,suppressions}.json`
- Create: `.kimi-code/bughunter/server/test/config-store.bhtest.ts`

**Interfaces:**
- Produces:
  - `loadConfig(stateDir?: string): Promise<Config>`
  - `ensureConfig(stateDir?: string): Promise<{ config?: Config; createdPath?: string }>`
  - `findProjectRoot(start = process.cwd()): Promise<string>`
  - `createRun(scope: Scope, route: string | undefined, deps: { config: Config; projectRoot: string; stateDir: string }): Promise<Run>`
  - `readRun(runId: string, stateDir?: string): Promise<Run>`
  - `updateRun(runId: string, patch: Partial<Run>, stateDir?: string): Promise<Run>`
  - `writeJsonAtomic(file: string, value: unknown): Promise<void>`
- `Config`, `Run`, `Candidate`, `Journal`, `Step`, `Signal`, and `Check` are shared erasable TypeScript types exported from `types.ts`.

- [ ] **Step 1: Write failing configuration and store tests**

Use `node:test` and `assert/strict`. Cover: missing config returns `createdPath` and a valid template; malformed JSON and invalid Zod fields include the concrete path; `diff` uses `git diff --name-only <baseBranch>...HEAD` and `routeMap`; no route-map matches falls back to all routes; `route` requires an allowed configured route; atomic writes leave valid JSON after interruption; unknown run IDs fail clearly.

The central test shape is:
```ts
test('missing config creates template without starting a run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bh-config-'));
  const result = await ensureConfig(root);
  assert.equal(result.config, undefined);
  assert.equal(result.createdPath, join(root, 'config.json'));
  const written = JSON.parse(await readFile(result.createdPath!, 'utf8'));
  assert.equal(written.limits.stepsPerSession, 60);
});
```

- [ ] **Step 2: Verify the tests fail before implementation**

Run:
```bash
cd .kimi-code/bughunter/server
npm install
node --test test/config-store.bhtest.ts
```
Expected: FAIL because the source modules do not exist. Generate the committed lockfile with this install; subsequent installs must use `npm ci`.

- [ ] **Step 3: Add the exact package and TypeScript configuration**

`package.json` must contain `"type": "module"`, `engines.node: ">=22.18"`, scripts `test: "node --test test/*.bhtest.ts"`, `typecheck: "tsc"`, and `auth: "node src/auth.ts"`. `tsconfig.json` enables `strict`, `noEmit`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `allowImportingTsExtensions`, `module: "NodeNext"`, `moduleResolution: "NodeNext"`, and types `node`.

`.gitignore` contains exactly the deliverable-local ignores:
```gitignore
server/node_modules/
server/fixtures/*/node_modules/
state/runs/
state/auth/
```

- [ ] **Step 4: Implement validation and durable state**

Use the full config shape and defaults from the source specification. Reject unknown or invalid values with `CONFIG_INVALID: <path>: <zod issue>`. Resolve default state as `resolve(import.meta.dirname, '../../state')` from `src`. Generate run IDs from UTC timestamp plus random suffix; never accept path separators in IDs. Write JSON using a same-directory temporary file, `fsync`, and `rename`.

For diff route selection execute Git with `execFile`, not shell interpolation. Match route-map globs with a small explicit matcher supporting `*`, `**`, and literal path segments; do not add a glob dependency.

- [ ] **Step 5: Verify Task 2**

Run:
```bash
cd .kimi-code/bughunter/server
npm test -- --test-name-pattern='config|run'
npm run typecheck
```
Expected: selected config/store tests PASS; typecheck PASS. `known-bugs.json` and `suppressions.json` both contain `[]`.

### Task 3: Seeded Vite/React Demo Application

**Files:**
- Create: `.kimi-code/bughunter/server/fixtures/buggy-app/package.json`
- Create: `.kimi-code/bughunter/server/fixtures/buggy-app/{index.html,vite.config.ts,tsconfig.json}`
- Create: `.kimi-code/bughunter/server/fixtures/buggy-app/src/{main.tsx,App.tsx,styles.css}`
- Create: `.kimi-code/bughunter/server/fixtures/buggy-app/src/{orders,profile}.test.ts`
- Create: `.kimi-code/bughunter/server/fixtures/buggy-app/e2e/.gitkeep`

**Interfaces:**
- Produces routes `/`, `/profile`, `/orders`, `/orders/new`, `/orders?page=2`, and `/clean`.
- Produces stable `data-testid` values `profile-name`, `profile-save`, `order-quantity`, `order-create`, `order-row`, `orders-total`, and `orders-page-two`.
- Mock API: `POST /api/orders` returns 500 for quantity `0`; otherwise appends one order per request.

- [ ] **Step 1: Add ordinary sample unit tests and show them red before the fixture exists**

The sample tests cover normal total calculation and positive order validation, not the seeded bugs:
```ts
it('sums known order amounts', () => {
  expect(calculateTotal([{ amount: 10 }, { amount: 15 }])).toBe(25);
});
```
Run `npm install && npm test` in the fixture. Expected initial FAIL because implementation is absent; retain the lockfile after installation.

- [ ] **Step 2: Implement the minimal fixture and all five seeded bugs**

Use React without a router dependency: read `window.location.pathname` and `URLSearchParams`, use normal links for navigation, and keep orders in the Vite middleware process. Implement exactly:
1. Empty profile name triggers an uncaught `Error('Profile name is required')` from the Save click handler.
2. Quantity zero sends the mock request and renders the 500 response without client-side prevention.
3. Create remains enabled while awaiting the request; a double click sends two requests and appends two rows.
4. `calculateTotal` incorrectly uses `Number(orders[0]?.amount)` as the initial value and reduces the remaining orders; an empty list therefore renders visible `NaN` without throwing before rendering, while non-empty totals remain correct.
5. `/orders?page=2` initializes page `1` after reload and calls `console.error('Orders page filter reset')`.
`/clean` renders and edits static local state without console, page, or network errors.

- [ ] **Step 3: Run fixture unit tests and production compile check**

Run:
```bash
cd .kimi-code/bughunter/server/fixtures/buggy-app
npm test -- --run
npx tsc --noEmit
```
Expected: ordinary unit tests PASS and TypeScript PASS. Do not write tests that codify seeded bugs as desired behavior.

- [ ] **Step 4: Start and smoke-test the real fixture**

Run `npm run dev -- --host 127.0.0.1 --port 4173` as a background task. Request all routes using `curl` and confirm the Vite HTML response. Leave the server available for browser integration; stop it when the stage is complete.

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

### Task 5: Browser Session Core and Safety

**Files:**
- Create: `.kimi-code/bughunter/server/src/browser/session.ts`
- Create: `.kimi-code/bughunter/server/test/session.bhtest.ts`
- Create: `.kimi-code/bughunter/state/config.json`

**Interfaces:**
- Consumes: Tasks 2–4 interfaces and running demo at `http://127.0.0.1:4173`.
- Produces a `SessionManager` with:
  - `open(runId: string, route: string, persona: string): Promise<{ sessionId: string }>`
  - `state(sessionId: string): Promise<StateResult>`
  - `act(sessionId: string, input: ActInput): Promise<ActResult>`
  - `navigate(sessionId: string, path: string): Promise<StateResult>`
  - `probe(sessionId: string, kind: ProbeKind): Promise<StateResult>`
  - `reportCandidate(sessionId: string, input: CandidateInput): Promise<{ candidateId: string; duplicateOf?: string }>`
  - `close(sessionId: string): Promise<void>`
  - `closeAll(): Promise<void>`

- [ ] **Step 1: Write failing end-to-end safety tests**

Use the real demo and real Chrome. Cover opening with tracing/video, state steps left, click/fill/select/press/check/hover/dblclick journaling, reload/back/mobile viewport probes, candidate journal slicing, and artifact creation on close.

Safety cases must assert rejection of `https://example.com`, protocol-relative and credentialed URL tricks, forbidden action text case-insensitively, form submission in read-only mode, and the action after the step limit. Include a same-origin allowed navigation control case.

- [ ] **Step 2: Verify tests fail before implementing the manager**

Run `node --test test/session.bhtest.ts`. Expected: FAIL due to missing `session.ts`.

- [ ] **Step 3: Implement context lifecycle and action journaling**

Launch one browser per manager and a fresh context per session. Load `state/auth/storage-state.json` only when it exists. Start tracing with screenshots/snapshots and video recording. Store pages by session and close popup pages that navigate outside allowed origins.

Resolve each element ID against the latest snapshot. Before acting, check forbidden names/text and read-only form submission in code. Write the step only after validation; include semantic locator, action, value, route template, and timestamp. Auto-fill with `testDataPrefix + randomUUID().slice(0, 8)`. Limit every action to `stepsPerSession`, returning `LIMIT_REACHED` without executing the excess action.

After each action or probe, wait for Playwright actionability and a short event turn, not a fixed exploratory sleep. Return only new signals since the previous state call.

- [ ] **Step 4: Implement candidate persistence and close artifacts**

A candidate stores title, expected, actual, referenced signal IDs, optional check, current route, journal prefix, `unprocessed` status, and reproduction state. Compare its signatures against both shared JSON arrays. On close, stop tracing into `artifacts/<candidate-or-session>/trace.zip`, save a final screenshot, close the context, and record actual video paths. Always clean up in `finally`.

- [ ] **Step 5: Verify Task 5**

With demo running, execute:
```bash
cd .kimi-code/bughunter/server
node --test test/session.bhtest.ts
npm run typecheck
```
Expected: all safety and lifecycle tests PASS. Inspect run artifacts to confirm non-empty trace, screenshot, and video files.

### Task 6: Core MCP Tools and Scripted Discovery Integration

**Files:**
- Create: `.kimi-code/bughunter/server/src/index.ts`
- Create: `.kimi-code/bughunter/server/src/auth.ts`
- Create: `.kimi-code/bughunter/server/test/core-integration.bhtest.ts`
- Modify: `.kimi-code/bughunter/server/package.json`

**Interfaces:**
- Consumes: `SessionManager`, run-store, and config functions from earlier tasks.
- Produces MCP tools `bh_start_run`, `bh_resume_run`, `bh_open`, `bh_state`, `bh_act`, `bh_navigate`, `bh_probe`, `bh_report_candidate`, and `bh_close` with the exact fields in the source specification.
- Produces `runAuth(): Promise<void>`, which saves `state/auth/storage-state.json` after an explicit terminal confirmation.

- [ ] **Step 1: Write the scripted no-LLM discovery test**

Start Vite programmatically on an ephemeral port, create a temporary state config pointing at it, and use the exported core functions rather than an LLM. Script these actions:
```ts
await manager.open(run.runId, '/profile', 'scripted');
await fillByTestId('profile-name', '');
await clickByTestId('profile-save');
assert.ok(signalsOfType('pageerror').length > 0);

await manager.open(run.runId, '/orders/new', 'scripted');
await fillByTestId('order-quantity', '0');
await clickByTestId('order-create');
assert.ok(signalsOfType('response').some((s) => s.message.includes('500')));

await manager.open(run.runId, '/orders', 'scripted');
assert.ok(signalsOfType('anomalyText').some((s) => s.message.includes('NaN')));

await manager.open(run.runId, '/orders?page=2', 'scripted');
await manager.probe(sessionId, 'reload');
assert.ok(signalsOfType('console').some((s) => s.message.includes('filter reset')));

await manager.open(run.runId, '/clean', 'scripted');
assert.deepEqual(newSignals, []);
```
Keep helpers in the test file and use the public manager methods for actions; direct page access is allowed only to set deterministic fixture state where the public API intentionally hides it.

- [ ] **Step 2: Run the integration test and verify failure**

Run `node --test test/core-integration.bhtest.ts`. Expected: FAIL before MCP registration and any missing integration behavior are implemented.

- [ ] **Step 3: Register MCP tools with strict input schemas**

Use `McpServer` and `StdioServerTransport`; each `registerTool` has a short Russian description and Zod shape. Return `{ content: [{ type: 'text', text: JSON.stringify(value) }] }`. Map known errors to compact JSON with `isError: true` and codes `CONFIG_CREATED`, `CONFIG_INVALID`, `LIMIT_REACHED`, `FORBIDDEN_ORIGIN`, `FORBIDDEN_ACTION`, and `NOT_FOUND`.

At startup validate Node ≥22.18 before loading the transport. On missing dependencies print `Зависимости Bughunter не установлены. Выполните: cd .kimi-code/bughunter/server && npm ci` to stderr and exit nonzero. Do not log protocol messages to stdout.

- [ ] **Step 4: Implement manual authentication capture**

`auth.ts` loads the same validated config, launches headed Chrome with `channel: 'chrome'`, opens `baseUrl`, and uses `readline/promises` to wait for Enter only after the user has logged in:
```ts
const answer = createInterface({ input: process.stdin, output: process.stderr });
try {
  await answer.question('Войдите в открытом Chrome, затем нажмите Enter здесь…');
  await mkdir(dirname(storageStatePath), { recursive: true });
  await context.storageState({ path: storageStatePath });
} finally {
  answer.close();
  await browser.close();
}
```
Use the state path derived from `import.meta.dirname`, never cwd. The automated suite checks that this path and headed launch options are correct; actual login remains a documented manual operation and must not be simulated.

- [ ] **Step 5: Add a real stdio handshake test**

Spawn `node src/index.ts`, connect the MCP SDK stdio client, call `tools/list`, and assert the nine tool names and shortened output shapes. Close client and child process in `finally`; a two-second no-output timer is not a valid startup check.

- [ ] **Step 6: Run Stage 1 automated verification and report**

Run:
```bash
cd .kimi-code/bughunter/server
npm test
npm run typecheck
```
Expected: all current tests and stdio handshake PASS. Report discovered seeded signals, clean-page result, safety tests, auth implementation, and any Chrome limitations.

### Task 7: Minimal Explorer and Manual Hypothesis Gate

**Files:**
- Create: `.kimi-code/agents/bh-explorer.md`
- Create: `.kimi-code/mcp.json`
- Modify: `.kimi-code/bughunter/README.md`

**Interfaces:**
- Consumes: the nine core MCP tools.
- Produces: manual candidate IDs and an explicit pass/stop decision for Stage 1.

- [ ] **Step 1: Add the minimal self-contained explorer agent**

Frontmatter must contain `name: bh-explorer`, a Russian description, full MCP tool names plus `Skill`, and `subagents: []`. The body instructs one action per state, deterministic candidate requirements, the five-candidate stop, `LIMIT_REACHED`, mandatory close, and a final standalone list of candidate IDs. Do not add reproduce/triage/export tools yet.

- [ ] **Step 2: Merge MCP configuration without overwriting other servers**

The resulting fragment is:
```json
{
  "mcpServers": {
    "bughunter": {
      "command": "node",
      "args": [".kimi-code/bughunter/server/src/index.ts"],
      "startupTimeoutMs": 30000,
      "toolTimeoutMs": 600000
    }
  }
}
```
Add the documented `cwd` only if Task 1 proved it necessary. Preserve every pre-existing server entry.

- [ ] **Step 3: Perform the manual Kimi run**

Start a fresh `kimi` session from the project root, trust the folder, and invoke `bh-explorer` sequentially for each demo route with all three MVP personas. Record route, persona, candidate IDs, signal types, last successful action, and error at any stuck point. Do not substitute a scripted manager test for this model-driven gate.

- [ ] **Step 4: Apply the stop rule**

Count distinct seeded bugs with candidates. If fewer than three: stop the entire implementation, write the manual matrix and stuck points to README, and report that later tasks remain blocked. If at least three: record PASS and continue.

### Task 8: Deterministic Reproduction and Minimization

**Files:**
- Create: `.kimi-code/bughunter/server/src/reproduce.ts`
- Create: `.kimi-code/bughunter/server/test/reproduce.bhtest.ts`
- Modify: `.kimi-code/bughunter/server/src/index.ts`

**Interfaces:**
- Consumes: journal, candidate, detector, and session types.
- Produces `reproduceCandidate(input: { runId: string; candidateId: string; attempts?: number; stateDir?: string; now?: () => number }): Promise<ReproductionResult>`.
- Result contains `reproduced: `${number}/${number}``, `steps`, `signature`, `artifacts`, and `minimalSteps`; candidate state stores the minimal journal.

- [ ] **Step 1: Write failing replay tests**

For each seeded bug, create a candidate with extra irrelevant actions followed by the symptom action. Assert same-signature matching, check-based matching, clean-context replay, and no match for a different normalized signature. A double-click candidate uses `check: { kind: 'elementCount', target: '[data-testid="order-row"]', expected: 2 }` against the actual pre-action count semantics stored in the candidate.

Minimization tests use a fake replay function to prove the algorithm exactly: remove a step, replay; keep removal if symptom persists, otherwise restore it. Include a deadline test where the 21st potential replay is never called.

- [ ] **Step 2: Verify failure before implementation**

Run `node --test test/reproduce.bhtest.ts`. Expected: FAIL due to missing module.

- [ ] **Step 3: Implement bounded replay and minimization**

Use a fresh browser context for every attempt and the same semantic locator resolver as live sessions. Capture all artifacts under the candidate artifact directory. Evaluate signal candidates by signature; for check candidates evaluate `visibleText`, `notVisibleText`, and `elementCount` against the final page. Stop minimization at 20 total replays or when `now()` reaches start plus 300000 ms. Never extend the deadline for a slow browser; abort pending work and close the context.

Only save `minimalSteps` after at least one successful reproduction. Candidates with zero reproductions remain marked `unreproduced` and are not eligible for triage/export.

- [ ] **Step 4: Register and verify `bh_reproduce`**

Add the Zod input with default `attempts = 3`, maximum three, and the compact result. Run:
```bash
node --test test/reproduce.bhtest.ts test/core-integration.bhtest.ts
npm run typecheck
```
Expected: PASS, including deadline and resource cleanup.

### Task 9: Triage Memory and Playwright Export

**Files:**
- Create: `.kimi-code/bughunter/server/src/export/playwright.ts`
- Create: `.kimi-code/bughunter/server/test/export.bhtest.ts`
- Modify: `.kimi-code/bughunter/server/src/run-store.ts`
- Modify: `.kimi-code/bughunter/server/src/index.ts`

**Interfaces:**
- Produces `triageCandidate(input: TriageInput): Promise<Candidate>` and `exportE2e(input: { runId: string; bugId: string; stateDir?: string }): Promise<{ file: string; placedInProject: boolean }>`.
- Produces `generatePlaywrightTest(candidate: Candidate, config: Config): string` for direct unit testing.

- [ ] **Step 1: Write failing triage and generation tests**

Assert confirmed/rejected/duplicate transitions and suppression updates; duplicate reports retain `duplicateOf`; suppressed signatures do not become new confirmed bugs. Reject export for unreproduced candidates.

Golden-test generated source for each symptom: pageerror signature, failed request, response status, anomaly text, error boundary, and the three check kinds. Include semantic locator index and all probe kinds. Verify output has one `test(...)`, concrete `expect(...)`, no fixed `waitForTimeout`, and no broad `toBeTruthy` assertion.

- [ ] **Step 2: Implement shared-memory triage**

Store stable signature, title, route, reason, timestamps, and source candidate in `known-bugs.json` or `suppressions.json` using atomic writes. `confirmed` creates/updates known bugs; `duplicate` links an existing bug; `rejected` changes run state and optionally adds suppression only when `suppress: true`.

- [ ] **Step 3: Implement safe standalone Playwright source generation**

Serialize dynamic values with `JSON.stringify`, never string interpolation into code. Generate `import { test, expect } from '@playwright/test'`, attach listeners before actions for pageerror/network symptoms, replay minimal steps, then assert the exact absence/presence condition. For check-based bugs assert the saved expected text/count. Use `baseUrl` from config and only allowed routes.

Placement checks the nearest project `package.json` for `@playwright/test` in dependencies or devDependencies. Write to `tests.e2e.dir` only when present; otherwise use `state/runs/<runId>/e2e/`. Create directories and never silently overwrite an unrelated existing file; use the stable bug ID filename.

- [ ] **Step 4: Register tools and verify Task 9**

Run:
```bash
node --test test/export.bhtest.ts test/reproduce.bhtest.ts
npm run typecheck
```
Expected: triage/export tests and typecheck PASS.

### Task 10: Prove Every Exported E2E Is Red Then Green in a Fixed Copy

**Files:**
- Create: `.kimi-code/bughunter/server/test/e2e-export.bhtest.ts`
- Create: `.kimi-code/bughunter/server/fixtures/buggy-app/playwright.config.ts`

**Interfaces:**
- Consumes: real candidates, minimal journals, and exporter from Tasks 3, 8, and 9.
- Produces: one verified red exported test per seeded bug and one green run per independently fixed copy.

- [ ] **Step 1: Write the integration harness**

For each bug, create a fresh temporary copy of the fixture, copy `node_modules` only with filesystem links or run `npm ci` in the copy, start its Vite server on an ephemeral port, export the test into that copy, and run:
```bash
npx playwright test <generated-file> --reporter=line --workers=1
```
Expected on the original bug: nonzero exit with the generated symptom assertion failing, not a syntax/import error.

- [ ] **Step 2: Apply each minimal fix only in the disposable copy**

Patch the copied source deterministically: guard empty profile name, reject zero quantity in the UI before API, disable Create while pending, supply a numeric empty-total fallback, and initialize/retain page 2 without console error. Re-run the corresponding single exported test. Expected: exit zero.

- [ ] **Step 3: Verify the original fixture remains buggy**

Run all five exported tests against the original fixture. Expected: five failing symptom assertions. Check `git diff` and assert original fixture source hashes equal their pre-test values; only run state may change.

- [ ] **Step 4: Stage 2 report**

Run the complete server `npm test` and typecheck. Report reproduction ratios, minimized step counts, and red/green evidence per bug. Any export that is `broken` blocks completion of this stage.

### Task 11: Jest/Vitest Detection and Neighbor Examples

**Files:**
- Create: `.kimi-code/bughunter/server/src/tests/detect.ts`
- Create: `.kimi-code/bughunter/server/test/detect.bhtest.ts`
- Create: `.kimi-code/bughunter/server/fixtures/jest-project/{package.json,jest.config.js,sum.js,sum.test.js}`
- Create: `.kimi-code/bughunter/server/fixtures/vitest-project/{package.json,vite.config.ts,sum.ts,sum.test.ts}`

**Interfaces:**
- Produces `detectTests(inputPath: string, options?: { unitCommand?: string | null }): Promise<{ framework: 'jest' | 'vitest' | null; command: string | null; examples: string[] }>`.

- [ ] **Step 1: Write failing detection fixtures and tests**

Cover nearest-package precedence, Jest config variants, Vitest config variants, explicit config command priority, unknown framework returning nulls, and at most three neighboring existing test files sorted by proximity then name. Do not return the target file itself as an example.

- [ ] **Step 2: Implement detection without adding a framework dependency**

Read the nearest `package.json` upward from the input file. Detect dependency versions and local config files. Use project-local binaries via `npm exec -- <framework> ...`, never a global framework. For explicit `tests.unit.command`, preserve the configured command and append the test path in `verify-red`, not during detection. Return relative example paths from the project root.

- [ ] **Step 3: Register and verify `bh_detect_tests`**

Run fixture installs, then:
```bash
cd .kimi-code/bughunter/server
node --test test/detect.bhtest.ts
npm run typecheck
```
Expected: Jest and Vitest cases PASS with correct commands and examples.

### Task 12: One-File Red/Green/Broken Verdicts

**Files:**
- Create: `.kimi-code/bughunter/server/src/tests/verify-red.ts`
- Create: `.kimi-code/bughunter/server/test/verify-red.bhtest.ts`
- Create: `.kimi-code/bughunter/server/fixtures/jest-project/{red,green,broken,syntax,import,timeout}.test.js`
- Create: `.kimi-code/bughunter/server/fixtures/vitest-project/{red,green,broken,syntax,import,timeout}.test.ts`
- Modify: `.kimi-code/bughunter/server/src/index.ts`

**Interfaces:**
- Consumes: `detectTests`.
- Produces `verifyRed(testFile: string, options?: { timeoutMs?: number; unitCommand?: string | null }): Promise<{ status: 'red' | 'green' | 'broken'; message: string }>`.
- The MCP input remains only `testFile`; the optional timeout supports fast deterministic tests, while production defaults to 120000 ms.

- [ ] **Step 1: Create failing fixture tests and classifier tests**

Each framework gets equivalent cases:
```js
test('red assertion', () => { expect(1).toBe(2); });
test('green assertion', () => { expect(1).toBe(1); });
test('broken outside assertion', () => { throw new Error('setup exploded'); });
```
Also create a syntax error, a missing import, and a test that never completes. Assert statuses `red`, `green`, `broken`, `broken`, `broken`, `broken` respectively. Assert every message is at most 1500 characters and contains the useful framework diagnostic.

- [ ] **Step 2: Verify the classifier tests fail**

Run `node --test test/verify-red.bhtest.ts`. Expected: FAIL because `verify-red.ts` is absent.

- [ ] **Step 3: Implement reporter-based classification**

For Jest run the project-local binary with the single file, `--runInBand --json --outputFile=<temp>`. For Vitest run `vitest run <file> --reporter=json --outputFile=<temp>`. Capture stdout/stderr and always read the report in `finally`. Classify `green` only when the selected file ran and all assertions passed; `red` only when at least one assertion failed normally; suite parse errors, missing imports, zero discovered tests, reporter failure, and setup/teardown exceptions are `broken`.

Use a 120000 ms default timeout and terminate the complete child process tree on expiry. Timeout is always `broken`. Never infer `red` merely from a nonzero process exit. Resolve the explicit unit command before framework defaults and still require a single target file.

- [ ] **Step 4: Register and run Stage 3 verification**

Run:
```bash
cd .kimi-code/bughunter/server
node --test test/detect.bhtest.ts test/verify-red.bhtest.ts
npm run typecheck
```
Expected: both Jest and Vitest matrices PASS. Report exact statuses and timeout behavior.

### Task 13: Finish Reports and Resumable Stage State

**Files:**
- Modify: `.kimi-code/bughunter/server/src/run-store.ts`
- Modify: `.kimi-code/bughunter/server/src/index.ts`
- Create: `.kimi-code/bughunter/server/test/report-resume.bhtest.ts`

**Interfaces:**
- Produces `finishRun(runId: string, stateDir?: string): Promise<{ report: string }>`.
- Produces `resumeRun(runId: string, stateDir?: string): Promise<{ run: Run; pendingCandidates: Candidate[] }>`.

- [ ] **Step 1: Write failing report and resume tests**

Create a run with confirmed, rejected, duplicate, unprocessed, and unreproduced candidates. Assert report sections contain confirmed steps, relative artifact paths, created e2e/unit test paths, and rejected reasons; unprocessed candidates remain pending. Finish twice and assert identical content except no duplicate entries. Resume returns only candidates requiring work and the persisted route/stage state.

- [ ] **Step 2: Implement explicit stage transitions**

Run stages are `created`, `exploring`, `reproducing`, `reviewing`, `writing_tests`, `finished`. Record per-route exploration and per-candidate reproduction/review/test state immediately after each operation. Resume derives pending work from these persisted records rather than timestamps or report text.

- [ ] **Step 3: Generate deterministic Markdown**

Escape user/model text that could break headings or links. Use relative paths inside the run and stable candidate ordering. `bh_finish_run` returns the report path, writes `report.md` atomically, and only then marks the run finished. `bh_resume_run` on a finished run returns its pending list (normally empty) without creating a new run.

- [ ] **Step 4: Verify Task 13**

Run `node --test test/report-resume.bhtest.ts` and `npm run typecheck`. Expected: PASS, including idempotent finish and interrupted-state resume.

### Task 14: Entry Skill, Full Agents, and Oracle Skills

**Files:**
- Create: `.kimi-code/skills/bughunter/SKILL.md`
- Create: `.kimi-code/skills/bughunter-oracles/SKILL.md`
- Create: `.kimi-code/skills/bughunter-red-test/SKILL.md`
- Modify: `.kimi-code/agents/bh-explorer.md`
- Create: `.kimi-code/agents/bh-reviewer.md`
- Create: `.kimi-code/agents/bh-test-writer.md`

**Interfaces:**
- Consumes: all 15 MCP tools and the CLI findings from Task 1.
- Produces `/bughunter [diff|full|route <path>|resume <runId>]`, with `diff` as default.

- [ ] **Step 1: Add frontmatter validation as a server test**

Create `.kimi-code/bughunter/server/test/prompts.bhtest.ts`. Parse the small YAML subset used by these files without a new dependency. Assert required names/descriptions, `disableModelInvocation: true`, empty subagents, exact tool allowlists, no `model`, no `override`, no `${base_prompt}`, `$ARGUMENTS` in the entry skill, and final standalone-result instruction in every agent. Run it before creating final files and confirm FAIL.

- [ ] **Step 2: Write the entry orchestration skill**

The body uses `$ARGUMENTS`, selects start/resume, delegates routes sequentially in the foreground, reproduces every candidate, excludes unreproduced candidates, sends reproduced candidates to reviewer and confirmed bugs to test-writer, finishes the run, and reports found/confirmed/files. It explicitly forbids commits and browser use by the main agent.

- [ ] **Step 3: Complete all three agents**

Explorer retains Task 7 behavior and invokes `bughunter-oracles`. Reviewer tools are exactly `Read`, `Grep`, `Glob`, `mcp__bughunter__bh_triage`, `Skill`; its body permits reading only `.kimi-code/bughunter/state/runs/`, verifies application ownership and reproducibility, and rejects doubtful candidates with reasons.

Test-writer tools are exactly `Read`, `Grep`, `Glob`, `Edit`, `Write`, the three test MCP tools, and `Skill`. It exports e2e first, verifies project-placed e2e red, uses up to three unit-test iterations only when cause is clear, invokes `bughunter-red-test`, never receives Bash, and never edits application code.

- [ ] **Step 4: Write concise reusable skills**

`bughunter-oracles` defines expected/actual format, deterministic signal hierarchy, invariant checks, expected 401/404, third-party scripts, extensions, and dev-stand network false positives; `whenToUse` is exactly `при исследовании страницы и разборе кандидатов в баги`.

`bughunter-red-test` defines one symptom per test, concrete assertions, no fixed sleep, independence from time/data order, cleanup, and Jest/Vitest mocking/timer idioms; `whenToUse` is exactly `при написании теста на найденный баг`.

- [ ] **Step 5: Verify prompt contracts**

Run:
```bash
cd .kimi-code/bughunter/server
node --test test/prompts.bhtest.ts
npm run typecheck
```
Expected: PASS. Then perform the installed-CLI agent/skill discovery probe from Task 1 with the real names.

### Task 15: Portable-Copy Full Run and Resume Gate

**Files:**
- Create: `.kimi-code/bughunter/server/test/portable.bhtest.ts`
- Modify: `.kimi-code/bughunter/README.md`

**Interfaces:**
- Consumes: the complete `.kimi-code/` tree and real demo application.
- Produces: automated copy integrity evidence and manual `/bughunter full` plus resume evidence.

- [ ] **Step 1: Write an automated portability test**

Copy the demo and `.kimi-code/` to a temporary directory inside the server fixture work area, excluding every `node_modules`, `state/runs`, and `state/auth`. Run `git init`, `npm ci` in the copied server and fixture, start the copied demo, and call the copied MCP server through a stdio client. Assert config/state paths resolve inside the copy, not the source workspace, and the nine core tools plus later tools respond.

- [ ] **Step 2: Verify project-tool isolation**

Inspect the copied project's `tsconfig`, ESLint, Jest, and Vitest patterns. Run their normal test/typecheck commands and assert `.kimi-code/` files are neither discovered nor compiled. Add documented excludes only to the disposable copy when a pattern violates isolation; record the exact exclude in README.

- [ ] **Step 3: Run the manual full gate**

From the copied Git root, start a fresh `kimi`, trust the directory, and run `/bughunter full` (or only the documented `/skill:bughunter` fallback if Task 1 disproved the alias). Require at least four of five confirmed seeded bugs, zero confirmed false positives, and a red e2e for every confirmed bug. Record actual counts and generated paths.

- [ ] **Step 4: Run the resume gate**

Interrupt a run after at least one candidate remains unprocessed. Start a fresh CLI session and invoke `/bughunter resume <runId>`. Assert previously confirmed candidates are not retested, pending candidates are processed, and report status becomes finished. Record the actual run ID and resumed candidate IDs without committing run state.

- [ ] **Step 5: Apply the final manual stop rule**

If the full-run criteria fail, do not mark MVP ready. Report model actions, false positives, missing e2e, and the smallest reproducible state; only resume implementation after the user chooses the correction scope.

### Task 16: README, Cleanup, and Complete Verification

**Files:**
- Modify: `.kimi-code/bughunter/README.md`
- Modify: `.kimi-code/mcp.json`
- Modify: `.kimi-code/bughunter/server/package.json`

**Interfaces:**
- Produces: installable handoff and final evidence for every automatic criterion; explicit status for every manual criterion.

- [ ] **Step 1: Complete installation and operations documentation**

README starts with first-run folder trust. Include copying files, merging rather than overwriting `mcp.json`, `npm ci`, the exact permission rule:
```toml
[[permission.rules]]
decision = "allow"
pattern = "mcp__bughunter__*"
```
Then document `npm run auth`, every config field, diff/full/route/resume use, artifacts, update by replacing only `server/`, copying without losing `state/`, Chrome installation, fixture-development installs, project-tool excludes, MVP limitations, and the Task 1 discrepancy list.

- [ ] **Step 2: Verify clean installation and server startup**

Remove only generated dependency directories that belong to the disposable portability copy, not the working deliverable. In a fresh copy run `npm ci`, `npm test`, `npm run typecheck`, and the MCP stdio handshake with `node src/index.ts`. Expected: all automatic tests PASS and no build step.

- [ ] **Step 3: Run final safety and output checks**

Run the complete test suite one final time after all changes. Confirm no test/fixture execution created tracked logs, reports, videos, or dependency files outside intended ignore paths. Check `git status --short -- .` and remove only temporary artifacts created by this implementation. Leave pre-existing user files untouched.

- [ ] **Step 4: Final report**

Report exact commands and counts for tests/typecheck, five-bug scripted discovery, five red/green export cycles, both framework verdict matrices, portability, and safety. Separately list manual CLI gates as PASS with evidence or NOT VERIFIED with the exact user action. Do not claim full readiness if any required gate failed or was not run.
