### Task 15: Portable-Copy Full Run and Resume Gate

**Files:**
- Create: `.kimi-code/bughunter/server/test/portable.bhtest.ts`
- Modify: `.kimi-code/bughunter/README.md`

**Interfaces:**
- Consumes: the complete `.kimi-code/` tree and real demo application.
- Produces: automated copy integrity evidence and manual `/bughunter full` plus resume evidence.

- [ ] **Step 1: Write an automated portability test**

Copy the demo and `.kimi-code/` to a temporary directory inside the server fixture work area, excluding every `node_modules`, `state/runs`, and `state/auth`. Run `git init`, `npm ci` in the copied server and fixture, start the copied demo, and call the copied MCP server through a stdio client. Assert config/state paths resolve inside the copy, not the source workspace, and the nine core tools plus later tools respond.

- [ ] **Step 2: Verify project-tool isolation**

Inspect the copied project's `tsconfig`, ESLint, Jest, and Vitest patterns. Run their normal test/typecheck commands and assert `.kimi-code/` files are neither discovered nor compiled. Add documented excludes only to the disposable copy when a pattern violates isolation; record the exact exclude in README.

- [ ] **Step 3: Run the manual full gate**

From the copied Git root, start a fresh `kimi`, trust the directory, and run `/bughunter full` (or only the documented `/skill:bughunter` fallback if Task 1 disproved the alias). Require at least four of five confirmed seeded bugs, zero confirmed false positives, and a red e2e for every confirmed bug. Record actual counts and generated paths.

- [ ] **Step 4: Run the resume gate**

Interrupt a run after at least one candidate remains unprocessed. Start a fresh CLI session and invoke `/bughunter resume <runId>`. Assert previously confirmed candidates are not retested, pending candidates are processed, and report status becomes finished. Record the actual run ID and resumed candidate IDs without committing run state.

- [ ] **Step 5: Apply the final manual stop rule**

If the full-run criteria fail, do not mark MVP ready. Report model actions, false positives, missing e2e, and the smallest reproducible state; only resume implementation after the user chooses the correction scope.

