# Task 15: Portable-Copy Full Run and Resume Gate

Date: 2026-11-11. Final status: **BLOCKED** (attempt-3 orchestration gate failed; MVP is not ready). No commits created.

## Baseline and automated portability

Commands run from `.kimi-code/bughunter/server`:

```sh
npm test
node --test test/portable.bhtest.ts
npm run typecheck
```

Baseline: 141 tests passed, 0 failed. The new portability test initially exposed two copy/isolation defects in the test setup: demo `node_modules` needed the same exclusion as the Bughunter tree, and stock Vitest discovered fixture tests under `.kimi-code/`. The final test excludes every `node_modules`, `state/runs`, and `state/auth`, copies demo plus `.kimi-code`, runs `git init --initial-branch=main`, runs `npm ci --no-audit --no-fund` in copied server and demo, starts copied Vite in a separate process, and uses a real MCP stdio `Client`.

Final portability result: PASS (1 test, 0 failures; 15.95 s). Typecheck: PASS. All 15 tools were listed and called successfully: start/resume/open/state/act/navigate/probe/report/reproduce/triage/export/detect/verify/finish/close. The candidate reproduced 3/3, was confirmed, exported into the copied project, resumed with no pending candidates, and finished. Run/report/export paths were asserted inside the copy. The copy and its processes were cleaned up.

Project isolation: copied `tsconfig.json` includes only `src` and `vite.config.ts`; TypeScript `--listFiles` contained no project file under copied `.kimi-code/`. Jest and ESLint are absent from the demo. Stock Vitest did discover `.kimi-code` fixture tests, so the disposable copy received `vitest.config.ts` with `test.exclude: [...configDefaults.exclude, '**/.kimi-code/**']`. The normal `npm test -- --run --reporter=verbose` then passed exactly the two demo tests and no Bughunter test. The exact exclude and config are documented in `.kimi-code/bughunter/README.md`; the original app was not edited.

## Real full gate

Fixture root (ignored by `state/runs/`): `.kimi-code/bughunter/state/runs/task15-full/project`.
The separate copy was initialized with Git and clean `npm ci` installs; copied demo URL: `http://127.0.0.1:54445`. It received only the documented disposable-copy Vitest exclude.

An initial `kimi --auto -p '/bughunter full'` invocation was rejected before any work: `error: Cannot combine --prompt with --auto` (exit 1, `kimi-full.stderr.log`). The actual command, from the copied Git root, was therefore:

```sh
KIMI_CODE_TRUST_WORKSPACE=1 kimi -p '/bughunter full' --output-format stream-json \
  > ../kimi-full-run.stdout.jsonl 2> ../kimi-full-run.stderr.log
```

Kimi version: 2.5.2; Node: v24.14.0. This is real installed-CLI/model/MCP/Chrome evidence, but headless trust is not interactive-trust evidence. Built-in orchestration and project custom agents are left to the tested Kimi session, sequentially and in the foreground as specified by the skill.

Run ID: `20261110T235119.445Z-72360d19fa6b`; CLI exit 0; report status `finished`. Result: **BLOCKED / full gate FAIL**. Nine candidates were reported; zero were confirmed; zero confirmed false positives; zero e2e files were generated. The required >=4/5 confirmed and red-e2e-per-confirmed gates therefore fail. The full run itself never reached Playwright verification; the separate resume run later exposed and authorized the verifier fix described below.

Exact model actions causing the failure:

- It emitted four `bh-explorer` Agent calls together, one per route, rather than 12 sequential route/persona calls. Run state showed `/`, `/orders`, and `/orders/new` exploring concurrently. Candidates covered seeded symptoms 1, 2, and 5 only; 3 and 4 were absent.
- It made no `bh_reproduce` call. Instead it delegated all nine candidates together to one `bh-reviewer`, asking that agent to reproduce despite that agent having no reproduce tool and the entry skill requiring reproduction first.
- The reviewer rejected every candidate because `reproduction.status=unreproduced` and `attempts=0`. These were not false-positive confirmations. Final stages remained `reproduce=pending` and `export=pending`, despite overall `finished`.

Smallest reproducible state: the full copied run directory above has nine candidate JSON files, all rejected with zero reproduction attempts; `kimi-full-run.stdout.jsonl` lines 13–17 show the invalid batch reviewer delegation and pending reproduction stage. Evidence files: `demo.log`, initial invocation-error logs, `kimi-full-run.stdout.jsonl`, `kimi-full-run.stderr.log`, and the complete copied run state. No original demo file was edited.

## Resume gate

Fixture root (also ignored): `.kimi-code/bughunter/state/runs/task15-resume/project`; copied demo URL `http://127.0.0.1:54682`. Initial actual command:

```sh
KIMI_CODE_TRUST_WORKSPACE=1 kimi -p '/bughunter full' --output-format stream-json \
  > ../kimi-interrupted.stdout.jsonl 2> ../kimi-interrupted.stderr.log
```

Run ID: `20261110T235818.477Z-65aae5376019`. The monitor waited for persisted unprocessed candidates. SIGINT to the wrapper PID did not reach its child; SIGINT was then sent only to the identified test-owned Kimi child PID. The CLI exited 130, proving genuine interruption. At interruption, candidates `1636bab9-d9b5-4873-ba2a-d81790bb7912`, `856f8809-5236-428f-a42a-fc474a64e726`, and `99254ea9-be0f-489f-98c0-802cdf67b08f` were confirmed and reproduced 3/3 but had no e2e test, so all remained pending for export. Their exact state is preserved in `before-resume.json`.

Fresh resume command now running:

```sh
KIMI_CODE_TRUST_WORKSPACE=1 kimi -p '/bughunter resume 20261110T235818.477Z-65aae5376019' --output-format stream-json \
  > ../kimi-resume.stdout.jsonl 2> ../kimi-resume.stderr.log
```

First resume result: interrupted deliberately after it exposed the authorized Playwright verifier defect. It did not call `bh_reproduce` or `bh_triage`; it exported the three pending candidates, but all three `bh_verify_red(kind=e2e)` calls returned `broken` because the verifier routed them to Vitest. Direct project-local Playwright ran the same spec and failed on the intended assertion. That CLI was interrupted with SIGINT (exit 130); evidence is `kimi-resume.stdout.jsonl` and `.stderr.log`.

Focused regression test added first and observed failing for red/green/broken. Minimal fix files:

- `.kimi-code/bughunter/server/src/tests/verify-red.ts`: explicit e2e branch requires project-local `@playwright/test`, invokes `npm exec -- playwright test <file> --reporter=json --workers=1`, writes JSON through `PLAYWRIGHT_JSON_OUTPUT_FILE`, and classifies ordinary assertion failures as red, all-passed as green, and runner/setup errors as broken. Unit detection/classification is unchanged.
- `.kimi-code/bughunter/server/src/index.ts`: passes the existing optional `kind` into `verifyRed`.
- `.kimi-code/bughunter/server/test/verify-red.bhtest.ts`: real local Playwright red/green/broken coverage.
- `.kimi-code/bughunter/server/test/portable.bhtest.ts`: exported project e2e is additionally verified red through real stdio `bh_verify_red`.

Verification before retrying resume:

```sh
node --test --test-name-pattern='playwright e2e' test/verify-red.bhtest.ts  # 4 passed
node --test test/verify-red.bhtest.ts                                      # 26 passed
npm run typecheck                                                           # passed
node --test --test-concurrency=1 test/*.bhtest.ts                          # 146 passed
```

Two default parallel `npm test` attempts each reported 143/146 passing (three failing nodes): the unrelated NaN assertions in `core-integration.bhtest.ts` and `reproduce.bhtest.ts`. Both affected tests passed in isolated reruns, and the complete serial suite passed 146/146. No unrelated timing code was changed. This default-concurrency flake remains a concern.

The exact `before-resume.json` state was restored in the disposable fixture, failed-attempt generated e2e/output was removed, and only the fixed server/test files were synchronized into that copy. The fresh fixed command was:

```sh
KIMI_CODE_TRUST_WORKSPACE=1 kimi -p '/bughunter resume 20261110T235818.477Z-65aae5376019' --output-format stream-json \
  > ../kimi-resume-fixed.stdout.jsonl 2> ../kimi-resume-fixed.stderr.log
```

Resume result: **PASS for interruption/recovery requirements**. CLI exit 0; run `20261110T235818.477Z-65aae5376019` is `finished`; report has `Pending: None`. All three pending candidate IDs were processed. Mechanical before/after comparison in `resume-verification.json` proves every `reproduction` and `review` object is unchanged. The fixed fresh JSONL contains zero `bh_reproduce` and zero `bh_triage` calls, three exports, four verifications (one initial green plus a corrected rerun), and exactly three final red verdicts.

Generated project files:

- `e2e/bughunter/99254ea9-be0f-489f-98c0-802cdf67b08f.spec.ts` — red, page/filter signal.
- `e2e/bughunter/1636bab9-d9b5-4873-ba2a-d81790bb7912.spec.ts` — red, profile pageerror signal.
- `e2e/bughunter/856f8809-5236-428f-a42a-fc474a64e726.spec.ts` — initially green because the scan raced async fetch; the resumed model added `waitForLoadState('networkidle')`, then `bh_verify_red` returned red.
- Report: `.kimi-code/bughunter/state/runs/20261110T235818.477Z-65aae5376019/report.md` inside the resume copy.

The resumed model also added the disposable-copy Vitest exclude `**/e2e/**` after normal Vitest tried to load the generated Playwright specs; its copied `npm test -- --run` then passed two unit files/two tests. This exclude is now documented in README. No application source was changed.

## Final concerns and stop rule

1. **MVP remains not ready / BLOCKED.** The actual full gate produced 0/5 confirmed, no e2e, parallel rather than sequential explorers, and skipped reproduction entirely. No correction to prompts/orchestration was made because that is outside the authorized Playwright fix and requires the user's chosen correction scope.
2. The resumed run's overall status is `finished`, but `explore` remains `running` and its four original route stages remain `exploring`; export/reproduce/triage are done and the report has no pending candidates. This stale stage state is preserved rather than hidden.
3. Default parallel `npm test` is not currently green (two attempts: 143/146), although isolated failures and the complete serial 146/146 run pass. This needs separate timing/concurrency work; no unrelated fix was attempted.
4. Headless `KIMI_CODE_TRUST_WORKSPACE=1` runs are not interactive trust evidence. No interactive trust claim is made.
5. Both ignored fixture copies and their JSONL/state/generated tests are preserved. All test-owned CLI/demo processes are stopped; no pre-existing user CLI/MCP PID was signalled. Temporary original-fixture Playwright output/e2e directories from focused tests were removed. No commits were created.


## Scoped correction wave

Status before fresh real gates: implementation verified in focused tests; final gate evidence pending. No commits.

### 1. Transient anomaly history

RED: `node --test --test-name-pattern='transient anomalies' test/signals.bhtest.ts` failed with 0 captured NaN signals for text that appeared and disappeared between scans. The new real-Chrome test also covers NaN disappearing during initial page load before the post-load scan.

Fix: `server/src/detectors/signals.ts` now installs a per-document MutationObserver with an exposed `__bughunterReportAnomalies` callback and `addInitScript`. Observer callbacks and ordinary body scans share `reconcileAnomalies`, preserving edge-triggered dedup, signatures, and anomaly token matching. Current-document installation covers an already loaded page; init-script installation covers subsequent documents.

GREEN: the focused test passed; `node --test test/signals.bhtest.ts` passed 7/7. The test-only API delay helpers and calls were removed from `core-integration.bhtest.ts` and `reproduce.bhtest.ts`. Without that crutch, scripted discovery passed and the real five-seed reproduction suite passed 6/6 nodes, including transient NaN.

### 2. Reliable default test command

`server/package.json` now runs `node --test --test-concurrency=1 test/*.bhtest.ts`, because the real-browser suites share machine resources. Verification of the actual `npm test` is pending below, not inferred from the equivalent manual command.

### 3. Deterministic orchestration/state guards

Triage RED: the new unreproduced-triage test was accepted before the fix. Fix in `run-store.ts` rejects every candidate whose reproduction status is not `reproduced` with `CANDIDATE_UNREPRODUCED` before status or shared-memory writes. GREEN confirmed unchanged candidate and absent known-bugs file.

Finish RED: pending candidate finish initially succeeded. Fix calls `resumeRun` and rejects nonempty `pendingCandidates` with `RUN_INCOMPLETE`, before report/status writes. Completed unreproduced-with-attempts entries remain valid. Existing incompatible report/resume fixtures were updated to expect pending-work rejection rather than finished pending reports. Focused finish/report tests passed.

Explorer MCP RED: two simultaneous `bh_open` calls both succeeded. Fix in `server/src/index.ts` uses an MCP-only active-run Set, reserved synchronously before awaiting browser open. The loser returns `EXPLORER_BUSY` without another exploring route/browser session; failed opens release immediately and close releases in `finally`. Direct SessionManager integration behavior is unchanged. The real stdio race test passed.

Error mapping RED: unreproduced triage returned `TOOL_FAILED`. Explicit MCP mappings now return `CANDIDATE_UNREPRODUCED` and `RUN_INCOMPLETE`; the real stdio guard cases passed. EXPLORER_BUSY uses the existing ToolError mapping.

Prompt RED: entry contract lacked the new exact phrases. `.kimi-code/skills/bughunter/SKILL.md` now requires exactly one Agent call per model message, no simultaneous tools beside it, no explorer/reviewer batches, no delegated reproduction, and sequential `bh_resume_run`/pending work after EXPLORER_BUSY or RUN_INCOMPLETE instead of finishing. `node --test test/prompts.bhtest.ts` passed 7/7.

### 4. Interrupted-stage reconciliation

RED regression mirrored the interrupted run: confirmed/reproduced candidate missing e2e, all original routes still `exploring`, and explore `running`. Finish first rejects the missing-e2e candidate and leaves stages unchanged. After e2e is recorded, finish reconciles nonfailed route stages and explore to done, preserves failed routes, and marks finished. Report writing occurs before the state transition, so report-write failures do not reconcile state. `node --test test/report-resume.bhtest.ts` passed 8/8.

### 5. Full verification and fresh real gates

Pending.

Actual verification after all scoped fixes:

```sh
npm run typecheck  # PASS
npm test           # PASS, 150/150; script used --test-concurrency=1
```

The default run included transient initial-load NaN, no-delay discovery/reproduction, real MCP explorer/triage/finish guards, interrupted-stage reconciliation, prompt contracts, portability, and all prior Jest/Vitest/Playwright classifications. Fresh real gates follow in new ignored copies: `task15-wave2-full` and `task15-wave2-resume`.

### Fresh wave-2 full gate evidence

Fixture: `.kimi-code/bughunter/state/runs/task15-wave2-full/project`, demo `http://127.0.0.1:62526`, command `KIMI_CODE_TRUST_WORKSPACE=1 kimi -p '/bughunter full' --output-format stream-json`. CLI exit 0.

Run `20261111T022451.407Z-433051d8fb70`: **numeric full gate PASS** — four candidates, all four confirmed and reproduced 3/3, zero confirmed false positives, red e2e for every confirmed bug, finished with `Pending: None` and every stage/route done. Seeded coverage: 1 (profile pageerror), 2 (zero quantity HTTP 500), 4 (transient NaN), 5 (page/filter reset); bug 3 double click was not found. `full-verification.json` records the mechanical counts/state.

Generated red e2e files:

- `e2e/bughunter/8359728c-5ed5-407a-8189-6a5e214100d5.spec.ts` — profile validation.
- `e2e/bughunter/0e4cab0a-f0e4-4b58-bc70-b66d39d2072a.spec.ts` — zero quantity expects controlled 400 rather than 500.
- `e2e/bughunter/921035d0-8aaa-4330-81bf-d7a4b7e98d21.spec.ts` — controlled loading response, expects numeric total and receives NaN; `src/orders.test.ts` also has a red empty-total unit assertion.
- `e2e/bughunter/18d73cd4-1425-4277-abba-c10eabfd28fd.spec.ts` — expects Page 2 and receives Page 1.

The guard worked in the real run: the model's initial four simultaneous direct opens produced one session and three EXPLORER_BUSY responses, then sequential retries. Observer history captured NaN at initial load. However, the model made **zero custom Agent calls**, directly triaged all four in one batch, and directly batched exports/verifications despite the strengthened prompt. The numeric thresholds pass, but the requested custom-agent orchestration remains a concern and is not claimed as corrected behavior.

### Fresh wave-2 interruption/resume

Fixture: `.kimi-code/bughunter/state/runs/task15-wave2-resume/project`, demo `http://127.0.0.1:62596`. Initial run `20261111T023427.387Z-b279ce8a799b` was interrupted with SIGINT to the exec'd test-owned Kimi PID and exited 130. Candidate `f5c98e98-947e-4a97-b6d2-95ce66bb45b7` (NaN) remained unprocessed with zero attempts; exact run/candidate state is in `before-resume.json`. Fresh `/bughunter resume 20261111T023427.387Z-b279ce8a799b` evidence follows.

Fresh resume result: **PASS**. Run `20261111T023427.387Z-b279ce8a799b` finished with all four stages and all four route stages `done`, report `Pending: None`, and one confirmed candidate. The same interrupted candidate `f5c98e98-947e-4a97-b6d2-95ce66bb45b7` was reproduced 3/3, triaged, exported to `e2e/bughunter/f5c98e98-947e-4a97-b6d2-95ce66bb45b7.spec.ts`, and finally verified red. Verification sequence was green (transient symptom missed), broken (relative URL without baseURL), then red after the model retained controlled API timing and restored the explicit copied-demo URL. `resume-verification.json` proves the final state/counts. Finish was called only after terminal candidate work and reconciled the stale stages as required.

## Scoped wave final verdict

- Default `npm test`: **150/150 PASS** using the actual script; typecheck: **PASS**.
- Real full numeric gate: **PASS**, 4/5 confirmed, zero confirmed false positives, four red e2e, finished.
- Real interrupted/resume gate: **PASS**, one pending candidate resumed and finished with final red e2e and reconciled stages.
- Deterministic transient/guard/finish regressions and prompt contracts: **PASS**.
- Remaining concern: real full JSONL records zero custom Agent calls and direct batched triage/export/verification. The guard contained the initial concurrent opens, but custom-agent orchestration compliance is not proven. No interactive-trust claim is made.
- Original demo hashes remain unchanged; no original app edits, no commits. Both wave-2 ignored fixture copies and evidence are preserved, and all test-owned processes were stopped.


## Final scoped correction wave (full attempt 3)

TDD evidence:

- Prompt binding RED: entry test reported missing main-agent allowlist/forbidden lines. `bughunter/SKILL.md` now limits main to start/resume/reproduce/finish, resume-only run.json Read, and Agent; explicitly forbids every browser/triage/export/detect/verify tool; requires exactly one tool/Agent call per message without batching. Prompt suite GREEN 7/7.
- Route completeness RED: zero-candidate exploring-route finish and interrupted terminal-candidate finish both incorrectly succeeded. `finishRun` now rejects every configured route whose stage is not done with RUN_INCOMPLETE before report/status writes. Auto-marking was removed. The interrupted regression succeeds only after actual `recordRouteExploration(..., 'done')` calls. Report/resume suite GREEN 9/9.
- Close release RED: a forced real SESSION_CLOSE_FAILED left the next MCP open EXPLORER_BUSY. `bh_close` now uses an outer finally around browser close and route recording, always releasing activeExplorerRuns/exploration mapping while preserving the original error. The real MCP test then reopened and completed all configured routes; GREEN.
- Portable process RED: stopProcess returned with child signalCode still null. It now awaits child exit; startDemo catches readiness failure and stops its own child; normal cleanup awaits demo exit before removing the copied project. Portable tests GREEN 2/2.

Fresh verification: `npm run typecheck` PASS; actual default `npm test` PASS **152/152** (serial browser suite). Full attempt 3 will run once with these fixes; another prompt patch after an orchestration failure is explicitly out of scope.

### Attempt-3 final result and evidence reconciliation

**Final MVP status: BLOCKED. Architectural concern: three real attempts still did not produce compliant sequential custom-agent orchestration. Per the stop rule, no fourth prompt patch or additional run is authorized.**

Attempt-3 fixture: `.kimi-code/bughunter/state/runs/task15-wave3-full/project`; run `20261111T031257.926Z-cba8999d3aac`. In `kimi-full.stdout.jsonl` line 10, one assistant message contains four simultaneous `Agent` calls with `subagent_type=bh-explorer` for `/`, `/orders`, `/orders/new`, and `/profile`. This violates the new exactly-one-tool/Agent-per-message contract even though the correct custom agent type was used. The test-owned Kimi process was interrupted with SIGINT and exited 130; its copied demo was then stopped. TaskList confirms no active test-owned background processes.

Partial attempt-3 state is preserved rather than presented as a completed gate: status `exploring`; reproduce/triage/export pending; only `/orders/new` is `exploring`, other configured routes pending; one candidate `935dde94-b27e-4a4d-be81-0ef32b0c35aa` is unprocessed with zero reproduction attempts; zero candidates are confirmed and no report/finish exists. The latest allowlist, route-completeness, close-finally, and portable-cleanup fixes therefore have focused/default test evidence but **have not passed a real full gate**.

Previously verified evidence, kept separate from the final-wave result:

- Portable-copy test including process cleanup: 2/2 PASS; actual default `npm test`: **152/152 PASS**; typecheck: PASS.
- Attempt-2 numeric full gate passed with 4/5 confirmed, zero confirmed false positives, and red e2e for all four, but it used zero custom Agent calls and therefore did not satisfy the final orchestration requirement.
- Wave-2 resume `20261111T023427.387Z-b279ce8a799b` passed for its one-pending-candidate scenario. It predates the final-wave route guard and did not contain the newly required combination of one fully completed confirmed candidate plus one unprocessed candidate.
- The final-wave two-candidate resume gate was **not launched and remains unverified**. No report or resume evidence is fabricated for it.

The attempt-2 numeric pass does not override the attempt-3 orchestration failure. No prompts/code were changed during evidence finalization, no additional full/resume run was launched, no user CLI/MCP process was touched, and no commits were created.
