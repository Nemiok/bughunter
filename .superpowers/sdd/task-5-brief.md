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

