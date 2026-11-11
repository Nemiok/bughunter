# Task 8: Deterministic Reproduction and Minimization — Report

## Status

Implemented and verified. No commits, dependencies, agents, triage/export changes, or demo application edits were made.

## RED evidence

Command, from `.kimi-code/bughunter/server`:

```bash
node --test test/reproduce.bhtest.ts
```

Initial result: exit 1, 0 pass / 1 fail, with the expected error:

```text
ERR_MODULE_NOT_FOUND: Cannot find module .../server/src/reproduce.ts
```

Two intermediate real-Chrome failures drove a covering correction:

1. Bug 4 candidate setup initially returned `Missing anomaly signal`: the fast `/api/orders` response replaced transient `NaN` before scanning. The test now uses the same 250 ms response delay as the existing core integration test.
2. The candidate then returned `0/1` during replay because that test-only network delay is not part of the journal. Replay now observes post-open DOM mutations and passes visible text through the existing `findAnomalyTexts` and `signalSignature` functions, so a transient anomaly with the candidate's exact signature is not lost.

The corrected bug-4 scenario and all other real replay scenarios then passed.

## Implementation

- `reproduceCandidate` loads the validated run config, persisted candidate, and original journal. The original journal route is used for replay, while the candidate's journal prefix remains immutable.
- Every evaluation calls `SessionManager.open`, creating a fresh browser context with the existing storage-state and navigation guards.
- Serialized journal locators are matched back to current semantic snapshots through `toPlaywrightLocator`; actions execute through `SessionManager.act`, preserving semantic resolution, forbidden-action checks, read-only form protection, and step accounting.
- Navigation and probes execute through `SessionManager.navigate`/`probe`. Signals are matched by the existing normalized signature.
- Check oracles cover `visibleText`, `notVisibleText`, and `elementCount`; reproduction means the check is violated on the final page.
- Minimization uses remove-and-replay, retains a removal only when the symptom persists, and restores the step otherwise.
- Initial attempts default to 3 and are restricted to integers 1–3 both in the public function and strict MCP schema.
- The shared budget is at most 20 evaluations including initial attempts. The 300000 ms deadline includes initial attempts and minimization. Expiration invokes browser cleanup and prevents further evaluations.
- Every completed replay uses existing `SessionManager.close` trace/screenshot/video capture, then moves the artifact set into `runs/<runId>/artifacts/<candidateId>/replay-<uuid>/`.
- `minimalSteps` is persisted as the minimal step journal on the candidate only when at least one initial reproduction succeeded. Zero-match candidates remain `reproduction.status = 'unreproduced'` and have no `minimalSteps`.
- MCP result is compact: `{ reproduced: 'k/n', steps, signature, artifacts, minimalSteps }`, where step fields are counts.

## Per-bug real Chrome/demo evidence

Each candidate was created through the real `SessionManager`, included an irrelevant mobile-viewport probe, and was replayed with `attempts: 1`. Every case returned `1/1`, persisted `reproduction.status = 'reproduced'`, and produced a minimal journal no longer than the original.

| Seeded bug | Oracle and evidence | Minimization evidence |
| --- | --- | --- |
| 1. Empty profile save throws | Same `pageerror` signature for `Profile name is required` | Irrelevant probe removed; final actions exactly `['click']` |
| 2. Quantity zero returns HTTP 500 | Same `response` signature for the 500 response | Final actions exactly `['fill', 'click']` |
| 3. Double click creates extra orders | `elementCount` on `[data-testid="order-row"]` violates the candidate's pre-action expected count `2` | Check-based replay and minimization passed |
| 4. Empty orders transiently render `NaN` | Same `anomaly` signature captured during reload, including transient DOM state | Remove/replay/restore behavior passed |
| 5. Page-two reload logs filter reset | Same `console` signature for `Orders page filter reset` | Remove/replay minimization passed |

Additional real-browser evidence:

- A different normalized `pageerror` signature returned `0/1`; the saved candidate stayed `unreproduced`, and `minimalSteps` remained absent.
- A clean-context behavioral test used `notVisibleText` for `Saved Alice`; both `fill` and `click` remained necessary, proving replay did not reuse the dirty original context.
- The real MCP stdio test called `bh_reproduce` without `attempts`; the default produced `3/3`, `steps: 2`, `minimalSteps: 0`, and at least 12 artifact paths.
- For every real candidate fixture, every returned artifact was under the candidate artifact directory and `stat` confirmed a non-empty file.

## Replay and deadline counts

Fake-replay algorithm tests provide exact counts:

- Required-step scenario: 1 initial evaluation + 3 minimization evaluations = 4 total; observed call sequence was `[0,1,2]`, `[1,2]`, `[2]`, `[1]`; final minimal journal `[1,2]`.
- Cap scenario: 25 steps, 3 initial attempts, always matching; exactly 20 calls, 3 successful initial reproductions, 17 successful removals, 8 remaining steps. The 21st potential replay was never invoked.
- Deadline scenario: a pending fake replay was aborted after 1 evaluation; no further calls occurred, successes remained 0, and the original 3-step journal was returned by the algorithm without being persisted as a reproduction.
- Deadline fake time reached the boundary through injected `now()` values; the test completed in about 1 ms rather than waiting five real minutes.

## GREEN / final verification

From `.kimi-code/bughunter/server`:

```bash
node --test test/reproduce.bhtest.ts
```

Result after the initial implementation and transient-anomaly correction: exit 0; 10/10 passed before the final clean-context test was added.

```bash
node --test test/reproduce.bhtest.ts test/core-integration.bhtest.ts
```

Final result: exit 0; **15/15 passed**, 0 failed.

```bash
npm test
```

Final result: exit 0; **49/49 passed**, 0 failed, 0 skipped/cancelled.

```bash
npm run typecheck
```

Final result: exit 0; TypeScript `tsc` reported no errors.

The full test output included `Port 5173 is in use, trying another one...`; Vite selected another port and all tests passed. A final process audit found no remaining `node --test`, Vite, or headless/remote-debugging Chrome processes. Temporary state directories were removed by test cleanup.

## Files

- Created `.kimi-code/bughunter/server/src/reproduce.ts` — bounded replay, exact symptom matching, minimization, artifact relocation, and candidate persistence.
- Created `.kimi-code/bughunter/server/test/reproduce.bhtest.ts` — all five real seeded symptoms, check/signature negative coverage, clean-context behavior, non-empty artifacts, exact fake-replay algorithm, cap, and deadline tests.
- Modified `.kimi-code/bughunter/server/src/index.ts` — registered strict `bh_reproduce` with default/max 3 attempts.
- Modified `.kimi-code/bughunter/server/test/core-integration.bhtest.ts` — tool listing/schema expectations and real stdio compact-result assertion.
- Created this report at `.superpowers/sdd/task-8-report.md` (outside the server tree).

## Self-review and concerns

- No unresolved test or typecheck failures remain.
- Replay deliberately reuses the public session action/navigation/probe/close APIs. A narrow typed internal lookup obtains the current `Page` only for read-only check evaluation and anomaly observation. This avoids duplicating safety logic, but a future public read-only session interface could remove that coupling.
- The specified final-page `elementCount` oracle can allow removal of a navigation step when the same count violation also holds on another page. This is consistent with the exact-check contract, but a minimal journal should be interpreted together with its check and signature.
- Triage/export eligibility was not implemented here; the persisted `unreproduced` state is ready for those later tasks to enforce.
- No application code or shared detector/session implementation was changed.

## Review follow-up: candidate-type oracle selection and visibleText coverage

### RED

The mixed-oracle regression creates a real signal-backed candidate with a `pageerror` signal ID and a violated `visibleText` check, then changes the expected signal to a different normalized signature. The required result is `0/1`, `reproduction.status = 'unreproduced'`, and no `minimalSteps`.

```bash
node --test test/reproduce.bhtest.ts
```

Before the fix, the corrected regression run finished with **12/13 passed**. The only failure was the mixed candidate returning `1/1` instead of `0/1`, proving that the previous `signal || check` expression allowed the check to override the missing signal match.

The first version of the zero-match visibleText case also failed because its target `Clean state` is an input value, not a visible text node. The target was corrected to the actual `<h1>Clean page</h1>` text; the subsequent RED run confirmed this coverage passed and isolated the oracle defect.

### Fix and GREEN

`executeReplay` now selects exactly one oracle by candidate type:

- `signalIds.length > 0`: only the observed/scanned normalized same-signature signal can reproduce the candidate; any attached check is ignored.
- No signal IDs and a present check: only the final-page check violation can reproduce the candidate.

No budget, deadline, artifact, locator, or private `Page` lookup code was changed.

Added real final-page visibleText evidence:

- Missing `Confirmation complete` on `/clean` reproduces `1/1` and minimizes to an empty journal because the final-page violation needs no actions.
- Visible `Clean page` on `/clean` satisfies the check, returns `0/1`, persists `unreproduced`, and leaves `minimalSteps` absent.
- The mixed signal/check candidate returns `0/1`, persists `unreproduced`, and leaves `minimalSteps` absent despite its check remaining violated.

Final commands from `.kimi-code/bughunter/server`:

```bash
node --test test/reproduce.bhtest.ts
```

Result: exit 0; **13/13 passed**, including the existing 20-evaluation cap, deadline abort, and non-empty artifact checks.

```bash
npm test && npm run typecheck
```

Result: exit 0; **51/51 tests passed**, 0 failed/skipped/cancelled; TypeScript `tsc` reported no errors. The recorded Minor maintainability concern about the narrow private `Page` lookup remains unchanged and was not refactored in this fix wave.
