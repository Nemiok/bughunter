### Task 14: Entry Skill, Full Agents, and Oracle Skills

**Files:**
- Create: `.kimi-code/skills/bughunter/SKILL.md`
- Create: `.kimi-code/skills/bughunter-oracles/SKILL.md`
- Create: `.kimi-code/skills/bughunter-red-test/SKILL.md`
- Modify: `.kimi-code/agents/bh-explorer.md`
- Create: `.kimi-code/agents/bh-reviewer.md`
- Create: `.kimi-code/agents/bh-test-writer.md`

**Interfaces:**
- Consumes: all 15 MCP tools and the CLI findings from Task 1.
- Produces `/bughunter [diff|full|route <path>|resume <runId>]`, with `diff` as default.

- [ ] **Step 1: Add frontmatter validation as a server test**

Create `.kimi-code/bughunter/server/test/prompts.bhtest.ts`. Parse the small YAML subset used by these files without a new dependency. Assert required names/descriptions, `disableModelInvocation: true`, empty subagents, exact tool allowlists, no `model`, no `override`, no `${base_prompt}`, `$ARGUMENTS` in the entry skill, and final standalone-result instruction in every agent. Run it before creating final files and confirm FAIL.

- [ ] **Step 2: Write the entry orchestration skill**

The body uses `$ARGUMENTS`, selects start/resume, delegates routes sequentially in the foreground, reproduces every candidate, excludes unreproduced candidates, sends reproduced candidates to reviewer and confirmed bugs to test-writer, finishes the run, and reports found/confirmed/files. It explicitly forbids commits and browser use by the main agent.

- [ ] **Step 3: Complete all three agents**

Explorer retains Task 7 behavior and invokes `bughunter-oracles`. Reviewer tools are exactly `Read`, `Grep`, `Glob`, `mcp__bughunter__bh_triage`, `Skill`; its body permits reading only `.kimi-code/bughunter/state/runs/`, verifies application ownership and reproducibility, and rejects doubtful candidates with reasons.

Test-writer tools are exactly `Read`, `Grep`, `Glob`, `Edit`, `Write`, the three test MCP tools, and `Skill`. It exports e2e first, verifies project-placed e2e red, uses up to three unit-test iterations only when cause is clear, invokes `bughunter-red-test`, never receives Bash, and never edits application code.

- [ ] **Step 4: Write concise reusable skills**

`bughunter-oracles` defines expected/actual format, deterministic signal hierarchy, invariant checks, expected 401/404, third-party scripts, extensions, and dev-stand network false positives; `whenToUse` is exactly `при исследовании страницы и разборе кандидатов в баги`.

`bughunter-red-test` defines one symptom per test, concrete assertions, no fixed sleep, independence from time/data order, cleanup, and Jest/Vitest mocking/timer idioms; `whenToUse` is exactly `при написании теста на найденный баг`.

- [ ] **Step 5: Verify prompt contracts**

Run:
```bash
cd .kimi-code/bughunter/server
node --test test/prompts.bhtest.ts
npm run typecheck
```
Expected: PASS. Then perform the installed-CLI agent/skill discovery probe from Task 1 with the real names.

