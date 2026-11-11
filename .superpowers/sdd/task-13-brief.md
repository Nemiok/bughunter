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

