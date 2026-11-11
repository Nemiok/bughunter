# Task 5: Browser Session Core and Safety — Report

## Status

Implemented `SessionManager` with the binding constructor `new SessionManager(config, stateDir)` and the requested `open`, `state`, `act`, `navigate`, `probe`, `reportCandidate`, `close`, and `closeAll` methods. No MCP entry point, auth command, reproduction, export, commit, or new package dependency was added.

## RED evidence

The integration suite was written before `session.ts` and run with:

```bash
cd .kimi-code/bughunter/server
node --test test/session.bhtest.ts
```

Result: exit 1, 0 pass / 1 fail, with the expected missing-module failure:

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find module
'/Users/nemiok/Desktop/projects/vault/bughunter/.kimi-code/bughunter/server/src/browser/session.ts'
imported from .../test/session.bhtest.ts
```

This confirms the tests failed because SessionManager did not yet exist, not because of a browser or demo failure.

## GREEN evidence

Final focused run:

```bash
node --test test/session.bhtest.ts
```

Result: exit 0; **6 tests, 6 pass, 0 fail**; duration 5886.74625 ms.

The passing cases are:

1. Real demo lifecycle, candidate journal prefix, and non-empty close artifacts.
2. All action/probe kinds and replayable journal steps with shared step accounting.
3. Direct, client-side, and popup navigation guards plus same-origin control.
4. Case-insensitive forbidden action text and read-only form submission rejection before journaling.
5. Step limit across actions and probes without excess execution/journaling.
6. Candidate signature deduplication against both known bugs and suppressions.

Full regression run:

```bash
npm test
```

Result: exit 0; **30 tests, 30 pass, 0 fail**, 0 cancelled/skipped/todo; duration 6627.621167 ms. This includes all existing config/run-store, element, and signal tests.

Type checking:

```bash
npm run typecheck
```

Result: exit 0; no TypeScript errors.

The new persisted config was also loaded through the real validator:

```bash
node --input-type=module --eval "import { loadConfig } from './src/config.ts'; const config = await loadConfig('../state'); console.log(config.baseUrl, config.limits.stepsPerSession);"
```

Output: `https://dev-stand.example.local 60`.

## Real browser and demo coverage

- Chrome is launched through `playwright-core` with `channel: 'chrome'`, headless, without downloading a browser.
- The lifecycle test opens the real installed Vite/React demo at `http://127.0.0.1:4173`, fills the profile name with generated `bh_` data, clicks Save, reports a candidate, navigates, closes, and inspects persisted state/artifacts.
- The demo did not expose select, checkbox, double-click, read-only form, or hostile-navigation controls. A temporary same-origin HTTP controls fixture supplements the real demo for those cases. It runs on an ephemeral loopback port and is destroyed by the suite.
- All action kinds are exercised successfully: `click`, `dblclick`, `fill`, `select`, `press`, `check`, and `hover`.
- All probes are exercised: `reload`, `back`, and `mobile_viewport`; navigation and probe steps retain their path/kind for Task 8 replay.
- Semantic locator expressions come from the existing `toPlaywrightLocator`; live resolution is exported as `resolveSemanticLocator` for later replay use.
- Detector draining uses existing `scanSignals`; action/probe/state results contain only signals not consumed by an earlier scan.

## Security cases

- `navigate` rejects `https://example.com/` with `NAVIGATION_NOT_ALLOWED`.
- Protocol-relative `//example.com/path` is rejected.
- Credentialed same-origin URL tricks (`http://user:pass@...`) are rejected even when the URL origin would otherwise match.
- `/other` on the same allowed origin succeeds as the control case.
- Every browser context installs a route guard before page creation/navigation. Disallowed requests are aborted in the route handler before network access; this covers direct navigation, anchors, script-driven location changes, and popup requests rather than only `bh_navigate`.
- Blocked main-frame navigation recovers to the previous allowed URL instead of leaving Chrome's internal error page. Popup pages associated with blocked external navigation are closed.
- Tests use `https://example.com` only as a blocked target; no real external request is made.
- Forbidden element names/text are matched case-insensitively before action execution and before journal append. The test uses `DeLeTe account` against configured `delete`.
- In `readOnly` mode, explicit and implicit submit controls are blocked, including relevant Enter/NumpadEnter submission paths. The integration test confirms a submit click neither navigates nor adds a journal step.
- `stepsPerSession` is shared by act, navigate, and probe journal steps. The focused test proves an act and probe consume the budget, the next act returns `LIMIT_REACHED`, the next probe rejects with `LIMIT_REACHED`, no excess action executes, and the journal remains at two steps.

## Candidate persistence and artifacts

- Candidates persist title, expected, actual, signal IDs, optional check, current route, journal prefix, `unprocessed` status, `reproduction: { status: 'unreproduced', attempts: 0 }`, signature, and artifact paths.
- Signal candidates reuse the referenced detector signature. Check-only candidates derive a stable signature from check kind/content and current route using the existing `signalSignature` normalization/hashing helper.
- Both shared arrays are checked in order: `known-bugs.json`, then `suppressions.json`. Tests verify returned `duplicateOf` values `known-1` and `suppressed-1` respectively.
- Candidate journal slicing is verified by reporting after fill/click and then navigating: the candidate retains exactly the two-step prefix while the session journal continues.
- On close, the suite calls `stat` on `trace.zip`, `screenshot.png`, and `video.webm` under `runs/<runId>/artifacts/<candidateId>/` and asserts every size is greater than zero.
- The persisted candidate is reread after close and verified to contain all three state-relative artifact paths.
- Tracing uses screenshots and snapshots. Video is recorded to a temporary session media directory and saved to the actual final `video.webm` path after context close.
- Context cleanup is in `finally`; session/media cleanup also occurs on open failures and close failures. `closeAll` attempts every session and closes the manager browser.

## Files changed

- Created `.kimi-code/bughunter/server/src/browser/session.ts` — browser/context lifecycle, navigation/request guards, action safety, step limits, journaling, candidates, and artifacts.
- Created `.kimi-code/bughunter/server/test/session.bhtest.ts` — six real-Chrome integration tests using temporary state directories and test-owned server cleanup.
- Created `.kimi-code/bughunter/state/config.json` — validated source-specification configuration template.
- Modified `.kimi-code/bughunter/server/src/types.ts` — added `unprocessed` candidate status and optional reproduction state to the existing shared `Candidate` type; no duplicate candidate model was introduced.

## Debugging and environment notes

- Initial GREEN attempt found the host lacked Playwright FFmpeg, so video context creation failed before page creation. `npx playwright install ffmpeg` installed FFmpeg build 1013 into the existing Playwright cache. No project manifest or lockfile changed.
- Playwright's popup request can precede frame creation; `request.frame()` throws in that case. The guard now treats it as an unowned popup request, aborts it, and closes unowned pages.
- Aborted main-frame external navigation can produce `chrome-error://chromewebdata/`; the action path now detects the blocked request and returns to the prior allowed URL.
- Test demo startup uses the installed Vite binary directly so teardown does not leave an npm child process.

## Self-review

- All paths are based on the explicit `stateDir`; no process-global or module-default state directory is used by SessionManager.
- Run IDs are validated before constructing persistence paths; session/candidate IDs are UUIDs.
- Storage state is passed only if `state/auth/storage-state.json` exists.
- One browser is lazily created per manager; every session gets a fresh context and page.
- Safety validation precedes journaling and action execution. Failed/limit-rejected actions do not consume steps.
- Journal writes are atomic through the existing `writeJsonAtomic` and include timestamp, semantic locator expression, action/value, navigation path or probe kind, and emitted signal IDs.
- No fixed exploratory sleep was introduced; settling uses DOM content loaded, body actionability, and one event-loop turn.
- No MCP/index/auth/reproduce/export files were created or modified.
- No commits were made. No test-owned server or Playwright Chrome process remained after verification.

## Concerns / follow-up

- No unresolved Task 5 correctness concerns. The supplementary controls fixture is intentional because the seeded demo lacks several required controls; the real demo itself is still exercised end-to-end for lifecycle, persistence, and artifacts.
- When a session has multiple candidates, close artifacts are stored under the first candidate's artifact directory and all candidates reference that same session evidence. Task 8 can create per-attempt candidate artifacts during reproduction as planned.


## Review remediation — focused TDD evidence

### RED

After adding the review regressions and before changing the relevant implementation, ran:

```bash
node --test test/session.bhtest.ts
```

Result: exit 1; **10 tests, 2 pass, 8 fail**. The existing storage-state loading/new-signal-drain coverage passed immediately, confirming those behaviors already worked. The eight expected failures were:

- `routeTemplate` was absent (`undefined`) on action/navigate/probe steps.
- Probe/navigate results were one step behind (`53 !== 52`, `1 !== 0`).
- Blocked popup actions returned no `FORBIDDEN_ORIGIN` error.
- Native form-associated Enter/image submission was not rejected.
- A storage-probe `ENOTDIR` failure left a temporary `.*-media` directory.
- Reordered check properties produced different signatures.

### Incremental GREEN checks

- Read-only native form regression: **1/1 pass**. The guard now requires the control's native `form` association and covers `submit` plus `image` for clicks/double-clicks and Enter/NumpadEnter for associated controls outside the DOM form.
- Hostile navigation regression: **1/1 pass**. Main-frame client navigation returns `NAVIGATION_NOT_ALLOWED`; popup blocking returns `FORBIDDEN_ORIGIN`; both leave the journal unchanged. The test directly verifies only the main page remains in the context. Popup creation can lag its blocked request, so the guard waits for the page event when necessary and closes it before returning.
- Route-template and accounting selection (`real demo|all action|step limit|final allowed`): **4/4 pass**. Every shared `Step` now has `routeTemplate`; navigate/probe results are updated after journaling and return zero on the final allowed step.
- Storage-failure and canonical-signature selection: **2/2 pass**. All storage probing is inside the post-mkdir `try`/`catch` cleanup region. Check-only signatures hash a fixed-order `[kind,target,expected,route]` payload directly with SHA-256, without signal number normalization; property-order equivalents match and expected counts 1 versus 2 remain distinct against known/suppression memory.

### Final focused and regression verification

```bash
node --test test/session.bhtest.ts
```

Result: exit 0; **10 tests, 10 pass, 0 fail**; duration 8926.558584 ms. This includes direct storage-state loading, one-shot signal draining, and post-mkdir failure cleanup.

```bash
npm test
```

Result: exit 0; **34 tests, 34 pass, 0 fail**, 0 cancelled/skipped/todo; duration 9848.761917 ms.

```bash
npm run typecheck
```

Result: exit 0; no TypeScript errors.

Review remediation changed only `src/browser/session.ts`, `src/types.ts`, `test/session.bhtest.ts`, and this report. No dependencies, commits, agents, MCP/auth/reproduce/export work, or unrelated edits were introduced.
