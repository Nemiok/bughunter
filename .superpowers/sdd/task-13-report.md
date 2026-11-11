# Task 13: Finish Reports and Resumable Stage State

## Status

Implemented `finishRun` and internal `resumeRun`, deterministic `report.md`, atomic finish ordering, explicit run/route/candidate state persistence, and the `bh_finish_run` MCP tool. The existing MCP `bh_resume_run` result remains compact and has exactly `{ runId, stages, candidates }`; its candidate summaries now represent all pending work rather than only the `unprocessed` status.

No commits, dependencies, or agents were created or used.

## RED evidence

The report/resume tests were created before the production implementation. After correcting an initial test-only malformed regular expression, the intended RED was captured:

```text
$ node --test test/report-resume.bhtest.ts
SyntaxError: The requested module '../src/run-store.ts' does not provide an export named 'finishRun'
tests 1
pass 0
fail 1
```

The strict real-stdio test was then extended for additive finish behavior and also failed before implementation:

```text
$ node --test --test-name-pattern='real MCP stdio' test/core-integration.bhtest.ts
✖ real MCP stdio client validates strict schemas and compact core results
- expected tool list includes bh_finish_run
+ actual tool list does not
tests 1
pass 0
fail 1
```

Existing compact response-key, strict-schema, error-mapping, and candidate-summary assertions were retained. Stage expectations were updated to the new persisted values rather than weakened.

## GREEN evidence

- `node --test test/report-resume.bhtest.ts`: **4/4 passed**.
- `node --test test/export.bhtest.ts`: **21/21 passed**, including persisted e2e test paths and review reasons.
- `node --test --test-name-pattern='real MCP stdio' test/core-integration.bhtest.ts`: **1/1 passed**, including two real `bh_finish_run` calls and compact resume after finish.
- `npm test`: **133/133 passed**, 0 failed, 0 skipped.
- `npm run typecheck`: **passed**, TypeScript `tsc` exit 0; rerun after the full suite with the same result.

During the first green run, a confirmed candidate with no test metadata exposed an unsafe `candidate.tests.unit` access. The focused test failure traced directly to that branch; changing it to optional access fixed the root cause. Two stdio-test adjustments were test-side only: an explicit string type for the already-validated run ID and the correct `explore: running` aggregate when only one of five full-run routes had been explored.

## Report evidence

`test/report-resume.bhtest.ts` creates confirmed, rejected, duplicate, unprocessed, and unreproduced candidates and verifies:

- confirmed candidates include their minimal reproduction steps;
- artifacts are rendered relative to the run root, for example `artifacts/candidate-confirmed/trace.zip`, without the stored `runs/<runId>/` prefix;
- created e2e and unit test paths are included;
- rejected and duplicate review reasons are included;
- unreproduced and pending candidates have separate sections;
- candidate input cannot inject raw headings or Markdown links/formatting; whitespace is normalized and Markdown control characters are escaped;
- candidates are loaded in stable `createdAt`, then `id`, order;
- report generation contains no current-time value, so unchanged state produces byte-identical content.

Internal run artifacts are run-relative. Tests exported into an external Playwright project retain their absolute project path because they are not inside the run directory.

## Transition and persistence evidence

- `Run.status` now supports exactly `created`, `exploring`, `reproducing`, `reviewing`, `writing_tests`, and `finished`.
- New runs initialize every selected route to `pending` in `routeStages` while retaining the reviewed aggregate `stages` object.
- Successful `bh_open` immediately records the route as `exploring`; successful `bh_close` records it as `done`. Aggregate exploration remains running until every selected route is done.
- Reproduction continues to persist `candidate.reproduction` atomically. The MCP handler records `reproduce` as running/done/failed around the operation and moves the run to `reproducing`.
- Triage now persists `candidate.review = { status, reason }` atomically. The MCP handler records the `triage` transition and `reviewing` run status.
- E2E export persists `candidate.tests.e2e` immediately after creating or confirming the exported file. The MCP handler records the `export` transition and `writing_tests` status.
- `bh_verify_red` retains its existing one-argument behavior. Optional `runId` + `candidateId`, with optional `kind: e2e | unit`, associate a verified test with the candidate and persist its path; supplying only one ID is rejected.
- Transition writes use the existing atomic JSON writer. No timestamps or report text are used to decide pending work.

## Resume evidence

The internal API returns `{ run, pendingCandidates }` with the complete persisted route and stage state. Pending work includes:

- candidates not yet reproduced;
- reproduced candidates awaiting review;
- confirmed reproduced candidates still missing their required e2e export.

Rejected, duplicate, already attempted but unreproduced, and confirmed candidates with an e2e export are skipped. Unit tests remain optional, matching the workflow's requirement to write one only when the cause is clear.

The test resumes an interrupted `reviewing` run and verifies exact route/stage state and stable pending IDs. It then finishes and resumes the same run, verifies the same pending list and run ID, and confirms that the `runs` directory still contains only the original run. No new run is created.

## Atomicity, confinement, and idempotency evidence

- JSON and Markdown share a temporary-file + fsync + rename implementation with temporary-file cleanup in `finally`.
- `finishRun` writes `report.md` first and only then marks the run `finished`.
- A test forces the report write to fail by making `report.md` a directory; the run remains `created` and no temporary files remain.
- Two consecutive finish calls return the same path and byte-identical report, without duplicate entries. An already-finished run does not need a second status update.
- Existing run/candidate ID validation confines state writes. Artifact paths resolving outside the run are rejected rather than emitted as run-relative paths.
- The real stdio test verifies `bh_finish_run` returns exactly `{ report }`, writes readable Markdown, is idempotent, and preserves the exact compact resume shape.

## Files changed

- `.kimi-code/bughunter/server/src/run-store.ts` — atomic text writing, route/run transitions, candidate test/review state, candidate loading, pending derivation, report generation, `finishRun`, and `resumeRun`.
- `.kimi-code/bughunter/server/src/types.ts` — explicit run-stage unions, route state, review state, created test paths, and typed minimal steps.
- `.kimi-code/bughunter/server/src/index.ts` — shared internal resume, `bh_finish_run`, operation transitions, route close tracking, and optional candidate association for test verification.
- `.kimi-code/bughunter/server/src/export/playwright.ts` — persists the created e2e path on the selected candidate.
- `.kimi-code/bughunter/server/test/report-resume.bhtest.ts` — new report, transition, resume, idempotency, and failure-ordering coverage.
- `.kimi-code/bughunter/server/test/core-integration.bhtest.ts` — additive strict finish-tool and real finish/resume coverage.
- `.kimi-code/bughunter/server/test/export.bhtest.ts` — asserts persisted review reasons and e2e test paths.
- `.superpowers/sdd/task-13-report.md` — this report.

## Self-review

- Both requested internal signatures match the brief exactly.
- The public resume shape remains exactly `{ runId, stages, candidates }`; pending summaries retain `candidateId`, `title`, and `status`.
- Finish writes before the terminal status transition and is idempotent for unchanged state.
- Report ordering and formatting are deterministic and user/model text is escaped.
- Reproduction, review, export, associated unit verification, and route open/close state are persisted immediately.
- Resume derives work from structured candidate records and does not create runs.
- Atomic writes and run/candidate path validation remain in force.
- No dependencies, commits, agents, unrelated source edits, or generated repository artifacts were introduced.

## Concerns

No known functional failures remain. The full suite still prints pre-existing informational Vite/Babel messages, including `Port 5173 is in use`; all 133 tests passed.

The final process audit found PID 26853 (`node .kimi-code/bughunter/server/src/index.ts`), started Nov 10 at 21:37, before this task's test runs. It was left untouched as a pre-existing user process. No test-created Bughunter, fixture, verifier, or MCP process remained.

## Review follow-up: associated paths, query routes, and validation order

### Fixes

- `bh_verify_red` now resolves `testFile` exactly once with `resolve(testFile)` in the server process, matching `verifyRed`'s cwd semantics. The resulting absolute path is passed both to `verifyRed` and `recordCandidateTest`, so relative project paths outside the run are no longer re-resolved against the run directory.
- Route-stage keys now prefer an exact configured route, then an exact pathname+query match, then the existing path-only configured route. Unmatched routes retain their query string. Distinct routes such as `/search?q=x` and `/search?q=y` therefore persist independently and can aggregate to `explore: done`.
- Incomplete `runId`/`candidateId` associations are rejected before config loading or verification. The valid one-argument and fully associated forms are unchanged.

### Focused RED / GREEN evidence

1. Incomplete association:
   - RED: the real MCP regression returned `TEST_ASSOCIATION_INCOMPLETE` but failed `assert.rejects(readFile(runnerMarker), { code: 'ENOENT' })`; the marker proved the configured runner had executed before validation.
   - GREEN after moving validation ahead of verification: `node --test --test-name-pattern='real MCP stdio' test/core-integration.bhtest.ts` passed 1/1 and the marker remained absent.
2. Relative associated test path:
   - The first attempt exposed a test-environment `/tmp` versus `/private/tmp` symlink mismatch; using `realpath(projectRoot)` corrected the test base without changing production code.
   - RED: real verification returned `green`, but `report.md` contained the nonexistent `/var/folders/Users/.../green.test.js` instead of the actual absolute fixture path.
   - GREEN after single resolution: the same focused stdio command passed 1/1 and the report contains `Unit: <absolute project fixture path>`.
3. Query-string route stages:
   - RED: `node --test test/report-resume.bhtest.ts` passed 4/5; actual state contained `'/search': 'exploring'` while `'/search?q=x'` remained pending.
   - GREEN after query-aware route matching: the same command passed 5/5, preserving both query keys and reaching `explore: done` only after both were done.

### Final verification

- `node --test test/report-resume.bhtest.ts test/core-integration.bhtest.ts test/export.bhtest.ts`: **30/30 passed**.
- `npm test`: **134/134 passed**, 0 failed, 0 skipped.
- `npm run typecheck`: **passed**, exit 0.
- The process audit again found only pre-existing PID 26853; it was left untouched. No new test-created process remained.
- Review changes were limited to `src/index.ts`, `src/run-store.ts`, `test/core-integration.bhtest.ts`, `test/report-resume.bhtest.ts`, and this appended report. No commits, dependencies, agents, or unrelated edits were introduced.

No new concerns beyond the pre-existing informational Vite/Babel output noted above.
