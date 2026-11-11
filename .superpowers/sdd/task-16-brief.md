### Task 16: README, Cleanup, and Complete Verification

**Files:**
- Modify: `.kimi-code/bughunter/README.md`
- Modify: `.kimi-code/mcp.json`
- Modify: `.kimi-code/bughunter/server/package.json`

**Interfaces:**
- Produces: installable handoff and final evidence for every automatic criterion; explicit status for every manual criterion.

- [ ] **Step 1: Complete installation and operations documentation**

README starts with first-run folder trust. Include copying files, merging rather than overwriting `mcp.json`, `npm ci`, the exact permission rule:
```toml
[[permission.rules]]
decision = "allow"
pattern = "mcp__bughunter__*"
```
Then document `npm run auth`, every config field, diff/full/route/resume use, artifacts, update by replacing only `server/`, copying without losing `state/`, Chrome installation, fixture-development installs, project-tool excludes, MVP limitations, and the Task 1 discrepancy list.

- [ ] **Step 2: Verify clean installation and server startup**

Remove only generated dependency directories that belong to the disposable portability copy, not the working deliverable. In a fresh copy run `npm ci`, `npm test`, `npm run typecheck`, and the MCP stdio handshake with `node src/index.ts`. Expected: all automatic tests PASS and no build step.

- [ ] **Step 3: Run final safety and output checks**

Run the complete test suite one final time after all changes. Confirm no test/fixture execution created tracked logs, reports, videos, or dependency files outside intended ignore paths. Check `git status --short -- .` and remove only temporary artifacts created by this implementation. Leave pre-existing user files untouched.

- [ ] **Step 4: Final report**

Report exact commands and counts for tests/typecheck, five-bug scripted discovery, five red/green export cycles, both framework verdict matrices, portability, and safety. Separately list manual CLI gates as PASS with evidence or NOT VERIFIED with the exact user action. Do not claim full readiness if any required gate failed or was not run.
