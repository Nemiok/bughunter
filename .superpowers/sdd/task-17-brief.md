### Task 17: Deterministic Exploration Work Queue (Task 15 orchestration fix)

**Authorized correction scope (user-chosen 2026-11-11):** server-side exploration work queue + explorer fake-clean fix + entry-skill rewrite, then re-run the failed Task 15 gates.

**Root cause (evidence: `state/runs/task15-wave2-full/`, `task15-wave3-full/`, kimi session `7a42f280`):** the session model batches multiple `Agent` calls into one assistant message regardless of prompt prohibition (attempts 1 and 3), or skips delegation when not forbidden (attempt 2). In attempt 3, three parallel explorers lost the `EXPLORER_BUSY` race, retried 5+ times, then reported «Кандидатов нет» without ever opening a session — fake-clean results indistinguishable from real ones. Prompt-only fixes failed three times; the fix must make correct sequencing structurally unavoidable.

**Files:**
- Modify: `.kimi-code/bughunter/server/src/types.ts` — queue item + run fields.
- Modify: `.kimi-code/bughunter/server/src/run-store.ts` — queue creation on `createRun`, atomic lease/release/complete/reclaim.
- Modify: `.kimi-code/bughunter/server/src/index.ts` — new `bh_explore_next` tool; `bh_open` requires a valid matching lease for queue runs; lease lifecycle wired to open/close.
- Modify: `.kimi-code/agents/bh-explorer.md` — explicit failure-vs-clean reporting; lease usage.
- Modify: `.kimi-code/skills/bughunter/SKILL.md` — queue-driven exploration loop.
- Modify: `.kimi-code/bughunter/server/test/prompts.bhtest.ts` — new prompt contracts.
- Create: `.kimi-code/bughunter/server/test/explore-queue.bhtest.ts` — TDD queue coverage.
- Modify: MCP-level callers of `bh_open` (portable/core-integration paths that go through real stdio) to fetch a lease first.
- Modify: `.kimi-code/bughunter/README.md` — workflow description update.

**Interfaces:**
- `bh_explore_next({ runId })` → `{ done: true }` | `{ done: false, busy: true, activeRoute }` | `{ done: false, busy: false, task: { leaseId, route, persona } }`. Atomically leases the first pending item only when no lease is outstanding.
- Queue = `routes × ['новичок','нетерпеливый','граничный ввод']` built at `createRun`; persisted in `run.json`.
- `bh_open` for queue runs requires `leaseId` matching an outstanding lease for that route+persona; mismatched/unknown/consumed lease → compact error. Parallel opens with the same lease → one wins, losers keep existing `EXPLORER_BUSY`.
- `bh_close` (success or failure) completes the lease's queue item and releases it; open failure releases the lease back to pending.
- `bh_resume_run` reclaims stale `leased` items back to `pending` (covers killed explorers); legacy runs without a queue keep legacy `bh_open` (lease optional) so old state stays resumable.
- Explorer prompt: «Кандидатов нет» only after a real opened session; otherwise `FAILED: <code>` / `RETRY_LATER: EXPLORER_BUSY`.
- Entry skill loop: repeat `bh_explore_next` → one foreground `Agent(bh-explorer)` with the lease → on `done:true` proceed to reproduction; keep the one-call-per-message contract.

**TDD order:** failing queue unit + MCP + prompt tests → implementation → `npm test` (currently 152) + typecheck green → fresh full gate (expect observable `bh_explore_next → Agent` alternation, ≥4/5 confirmed, 0 false positives, red e2e per confirmed) → new two-candidate resume gate (1 fully processed + 1 unprocessed) → report/diff/review. No commits. Do not touch pre-existing user CLI/MCP processes.
