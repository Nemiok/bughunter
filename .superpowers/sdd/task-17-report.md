# Task 17: Deterministic Exploration Work Queue — Report

Date: 2026-11-11  
Workspace: `/Users/nemiok/Desktop/projects/vault/bughunter`  
Task status: **DONE_WITH_CONCERNS** (implementation + automated gates complete; required Kimi full/resume re-gates **not executed** — provider weekly quota exhausted)  
MVP readiness: **BLOCKED / NOT READY** until post-Task-17 full gate (≥4/5 confirmed, 0 confirmed false positives, red e2e per confirmed, observable `bh_explore_next` ↔ `Agent` alternation) and two-candidate resume gate pass on installed CLI 2.5.2.  
Commits: **none**.

## 1. Problem and authorized scope

Task 15 failed the **custom-agent orchestration** gate despite partial numeric success. Root cause (documented in Task 15 wave-2/3 wire logs and session `7a42f280`): the session model batches multiple `Agent(bh-explorer)` calls per message; parallel explorers lost `EXPLORER_BUSY`, retried, then returned «Кандидатов нет» without opening a session — indistinguishable from a genuinely clean route. Three prompt-only remediation attempts failed. User authorized **Task 17**: server-side exploration queue + lease enforcement, explorer fake-clean fix, entry-skill rewrite, then re-run Task 15 gates.

## 2. Implementation delivered

### Server

- **`types.ts`:** `ExploreQueueItem` and optional `Run.exploreQueue` (legacy runs without queue remain resumable).
- **`run-store.ts`:** `EXPLORER_PERSONAS = ['новичок','нетерпеливый','граничный ввод']`; queue built at `createRun` as `routes × personas` (route-major order); `leaseNextExploration`, `validateExplorationLease`, `completeExplorationLease`, `releaseExplorationLease`, `reclaimExplorationLeases`; lazy queue build on resume for legacy runs.
- **`index.ts`:** new tool `bh_explore_next({ runId, route? })` returning `{ status: 'done'|'busy'|'task', ... }`; `bh_open` requires matching `leaseId` when the run has a queue (`LEASE_REQUIRED` / `LEASE_UNKNOWN` / `LEASE_MISMATCH`); lease released on failed open, completed on successful `bh_close`, released on failed close; `bh_resume_run` reclaims stale leases; per-run async mutex + in-process `liveLeaseIds` so resume does not reclaim an active session lease.

### Prompts

- **`skills/bughunter/SKILL.md`:** queue loop — `bh_explore_next` → exactly one foreground `Agent(bh-explorer)` with lease → repeat until `done`; `bh_explore_next` on main-agent allowlist; `FAILED` / `RETRY_LATER` do not mark a route explored.
- **`agents/bh-explorer.md`:** passes `leaseId` to `bh_open`; «Кандидатов нет» only after a real opened session; otherwise `RETRY_LATER: EXPLORER_BUSY` or `FAILED: <code>`.

### Tests

- **Created** `server/test/explore-queue.bhtest.ts` (11 tests): queue creation order, lease lifecycle, stale reclaim, parallel `bh_explore_next` via real stdio (one `task`, others `busy`), lease errors, live-lease protection.
- **Updated** `prompts.bhtest.ts`, `core-integration.bhtest.ts`, `portable.bhtest.ts`: 16-tool list, lease helpers, same-lease open race, prompt contracts.
- **Updated** `README.md` §6 workflow and this §2 verification status.

Tool count: **16** (was 15).

## 3. Automated verification

Commands from `.kimi-code/bughunter/server` (Playwright browsers from user cache; `env -u PLAYWRIGHT_BROWSERS_PATH` when sandbox sets a broken `PLAYWRIGHT_BROWSERS_PATH`):

```sh
env -u PLAYWRIGHT_BROWSERS_PATH npm test
npm run typecheck
```

Final result: **164 passed, 0 failed** (~119 s); **typecheck PASS**.

Focused new suite:

```sh
node --test test/explore-queue.bhtest.ts
```

All 11 explore-queue tests pass, including MCP stdio parallel lease behavior.

Portable copy test still passes with `bh_explore_next` in the handshake matrix.

## 4. Kimi re-gates (required by brief — blocked)

Disposable gate root prepared: `.kimi-code/bughunter/state/runs/task17-full/project` (buggy-app + `.kimi-code`, `vitest.config.ts` excludes, `git init`, `npm ci`, demo on `http://127.0.0.1:59521`).

Intended command from copied project root:

```sh
KIMI_CODE_TRUST_WORKSPACE=1 kimi -p '/bughunter full' --output-format stream-json \
  > ../kimi-full.stdout.jsonl 2> ../kimi-full.stderr.log
```

**Outcome:** CLI exited before any model work. `kimi-full.stderr.log`:

```text
error: failed to run prompt: provider.api_error: You've reached your weekly (7-day) usage limit.
```

`kimi-full.stdout.jsonl` contains a single line (startup metadata only). **No** `bh_explore_next` / `Agent` alternation evidence; **no** numeric 4/5 gate; **no** two-candidate resume gate.

Evidence paths (ignored by git via `state/runs/`):

- `.kimi-code/bughunter/state/runs/task17-full/kimi-full.stderr.log`
- `.kimi-code/bughunter/state/runs/task17-full/kimi-full.stdout.jsonl`
- `.kimi-code/bughunter/state/runs/task17-full/demo-url`, `demo.log`

## 5. Cleanup

Final `npm test` regenerated `server/fixtures/buggy-app/.playwright-output/`; residue was deleted before regenerating `task-17-diff.patch`. Diff excludes `.playwright-output` and matches only Task 17 source/prompt changes (10 file pairs). No pre-existing user MCP processes were killed.

## 6. Artifacts

| Artifact | Path |
| --- | --- |
| Brief | `/Users/nemiok/Desktop/projects/vault/.superpowers/sdd/task-17-brief.md` |
| Before snapshot | `/Users/nemiok/Desktop/projects/vault/.superpowers/sdd/task-17-before/` |
| Diff | `/Users/nemiok/Desktop/projects/vault/.superpowers/sdd/task-17-diff.patch` |
| Report | `/Users/nemiok/Desktop/projects/vault/.superpowers/sdd/task-17-report.md` |

## 7. Spec compliance (self-assessment)

| Requirement | Status |
| --- | --- |
| TDD queue + MCP + prompt tests before/alongside implementation | **PASS** |
| `bh_explore_next` + lease-gated `bh_open` / queue lifecycle | **PASS** |
| Entry skill queue loop + explorer fake-clean contract | **PASS** |
| `npm test` + typecheck green | **PASS** (164/164) |
| Fresh full gate (alternation, ≥4/5, red e2e) | **NOT RUN** (quota) |
| Two-candidate resume gate | **NOT RUN** (quota) |
| No commits | **PASS** |

## 8. Residual risks and next steps

1. Re-run **full** and **two-candidate resume** gates when Kimi provider quota is available (or alternate API key configured in CLI).
2. Confirm JSONL shows strict `bh_explore_next` → single `Agent(bh-explorer)` sequencing; batching may still occur for reproduce/reviewer phases — only exploration is structurally serialized.
3. Interactive workspace trust remains manual and unverified.
4. Task 15 historical numeric pass (attempt 2) does not substitute for a post-Task-17 orchestration pass.

**Independent review:** not run in this session; recommended before marking MVP ready.
