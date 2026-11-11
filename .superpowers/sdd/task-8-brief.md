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

