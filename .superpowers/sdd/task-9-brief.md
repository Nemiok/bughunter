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

