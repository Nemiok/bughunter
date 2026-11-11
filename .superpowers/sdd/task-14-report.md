# Task 14: Entry Skill, Full Agents, and Oracle Skills — Report

Date: 2026-11-11
Workspace: `/Users/nemiok/Desktop/projects/vault/bughunter`
Installed CLI: `kimi 2.5.2`

## Summary

Implemented the manual `/bughunter` entry skill, completed all three custom agents, and added the reusable oracle and red-test skills. Added a dependency-free prompt contract test that parses the small frontmatter YAML subset directly. All focused and full server tests and TypeScript checking pass. Installed-CLI discovery confirmed the real project agent names and loaded both helper skills. A separate invalid-argument entry probe returned usage without starting exploration.

No commits, dependencies, delegated implementation agents, application edits, or unrelated edits were made. Task 15's full exploration was not run.

## TDD evidence

### RED

Created `.kimi-code/bughunter/server/test/prompts.bhtest.ts` before the final prompt files.

Command:

```bash
cd .kimi-code/bughunter/server
node --test test/prompts.bhtest.ts
```

Initial result: exit 1; **7 tests, 1 passed, 6 failed**. The existing `bh-explorer` frontmatter contract passed. The six failures were expected missing-feature failures: `bh-reviewer.md`, `bh-test-writer.md`, entry `bughunter/SKILL.md`, `bughunter-oracles/SKILL.md`, and `bughunter-red-test/SKILL.md` did not exist, and the combined reusable-skill/boundary check consequently failed.

### GREEN

Created the five missing prompt files and added the required `bughunter-oracles` invocation to the existing explorer.

The first post-implementation run had 6/7 passing. Its remaining failure isolated a bug in the new test matcher, not a missing prompt requirement: the prompt said `не более чем за 3 итерации`, while the regex omitted `за`. Only that matcher was corrected.

Final focused command:

```bash
node --test test/prompts.bhtest.ts
```

Final focused result: exit 0; **7 tests, 7 passed, 0 failed**.

The test asserts:

- required `name` and non-empty `description` on every new prompt/agent;
- entry `disableModelInvocation: true` and `$ARGUMENTS` usage;
- exact agent tool arrays and `subagents: []`;
- absence of `model`, `override`, and `${base_prompt}`;
- the standalone final-result instruction in every agent;
- entry orchestration names and sequential foreground delegation;
- no main-agent browser use, exclusion of unreproduced candidates, and no commits;
- exact `whenToUse` strings;
- explorer/oracles and writer/red-test linkage;
- reviewer run-state-only path and writer's three-iteration/application-code boundaries.

## Exact tool allowlists

### `bh-explorer`

```text
mcp__bughunter__bh_open
mcp__bughunter__bh_state
mcp__bughunter__bh_act
mcp__bughunter__bh_navigate
mcp__bughunter__bh_probe
mcp__bughunter__bh_report_candidate
mcp__bughunter__bh_close
Skill
```

The existing action/state cycle, deterministic candidate criteria, stop conditions, mandatory close, and standalone candidate list were retained. The agent now invokes `bughunter-oracles` before exploration.

### `bh-reviewer`

```text
Read
Grep
Glob
mcp__bughunter__bh_triage
Skill
```

The reviewer reads only below `.kimi-code/bughunter/state/runs/`. It requires persisted reproduction, checks expected/actual and application ownership, rejects stand/extension/third-party/expected-network false positives, checks duplicates using available run data, and sends doubtful candidates to `rejected` with a concrete reason.

### `bh-test-writer`

```text
Read
Grep
Glob
Edit
Write
mcp__bughunter__bh_detect_tests
mcp__bughunter__bh_export_e2e
mcp__bughunter__bh_verify_red
Skill
```

There is no `Bash`. The writer exports e2e first and verifies project-placed e2e red through `bh_verify_red`. It invokes `bughunter-red-test`, writes a unit test only when the cause is clear, allows no more than three unit iterations, and forbids application-code edits.

All agents have `subagents: []`; none defines `model` or `override` or references `${base_prompt}`.

## Entry and reusable skills

- Entry accepts empty/`diff` (default), `full`, `route <path>`, and `resume <runId>` through `$ARGUMENTS`.
- New runs use `bh_start_run`; resumed runs use `bh_resume_run` and continue only unfinished work.
- Route/persona exploration is delegated one foreground `Agent` call at a time to `bh-explorer`.
- Every pending candidate is reproduced; unreproduced candidates go nowhere further.
- Only reproduced candidates go to `bh-reviewer`; only confirmed bugs go to `bh-test-writer`.
- The entry finishes with `bh_finish_run` and reports found/confirmed counts, test files, and report path. It forbids commits and browser use by the main agent.
- `bughunter-oracles` defines expected/actual, deterministic signal hierarchy, explicit invariant checks, expected 401/404, third-party scripts, extensions, and dev-stand network false positives.
- `bughunter-red-test` defines one symptom per test, concrete assertions, no fixed sleeps, time/data-order independence, cleanup, and Jest/Vitest mocking and timer idioms.
- `whenToUse` values are exactly:
  - `при исследовании страницы и разборе кандидатов в баги`
  - `при написании теста на найденный баг`

## Full verification

Commands:

```bash
cd .kimi-code/bughunter/server
npm test
npm run typecheck
```

Results:

- `npm test`: exit 0; **141 tests, 141 passed, 0 failed, 0 skipped**; duration 94.84 s. This includes the focused prompt suite and all existing real-Chrome/integration tests.
- `npm run typecheck`: exit 0; `tsc` emitted no diagnostics.
- Existing Babel size notes and Vite port fallback appeared during integration tests, but there were no test errors or failures.

## Installed-CLI discovery evidence

A temporary isolated project root was created inside the workspace with its own `.git` and copies only of the final `.kimi-code/agents/` and `.kimi-code/skills/`. No MCP server or browser configuration was included. The temporary root and captured logs were removed after the probes.

The first attempt accidentally launched from the parent workspace rather than the temporary root. It correctly produced empty project names and `Skill ... not found`; after changing the CLI cwd to the isolated root, the following probes succeeded. This was a probe-cwd mistake, not a CLI discovery defect.

### Real-name discovery

Command, run from the temporary root:

```bash
KIMI_CODE_TRUST_WORKSPACE=1 kimi -p \
  'Это только проверка discovery, не исследование. Не вызывай никакие инструменты, агенты, скиллы, MCP или браузер. Перечисли из уже доступного контекста только имена project agents и project skills. Формат: AGENTS: имена через запятую; новая строка SKILLS: имена через запятую. Не добавляй built-in или extra skills.' \
  --output-format stream-json
```

Assistant output:

```text
AGENTS: bh-explorer, bh-reviewer, bh-test-writer
SKILLS: bughunter-oracles, bughunter-red-test
```

Exit 0; stderr empty. The manual-only entry is intentionally absent from the model-invocation listing because `disableModelInvocation: true`.

### Real helper-skill loading

```bash
KIMI_CODE_TRUST_WORKSPACE=1 kimi -p \
  'Это только проверка discovery, не исследование. Вызови через Skill по одному разу project skills bughunter-oracles и bughunter-red-test. Не вызывай bughunter, Agent, MCP или браузер. После загрузки обоих верни только BH-SKILLS-DISCOVERY-OK.' \
  --output-format stream-json
```

Captured calls and results:

```text
Skill {"skill":"bughunter-oracles"}
Skill {"skill":"bughunter-red-test"}
Skill "bughunter-oracles" loaded inline. Follow its instructions.
Skill "bughunter-red-test" loaded inline. Follow its instructions.
BH-SKILLS-DISCOVERY-OK
```

Exit 0; stderr empty. No `Agent`, MCP, browser, or entry-skill call occurred.

### Safe manual-entry probe

```bash
KIMI_CODE_TRUST_WORKSPACE=1 kimi -p '/bughunter invalid' --output-format stream-json
```

The CLI read the real entry skill and returned the supported `/bughunter`, `diff`, `full`, `route <path>`, and `resume <runId>` formats. It made no `Agent`, MCP, browser, start-run, or reproduce call and did not start exploration. Exit 0; stderr empty. The model also loaded `superpowers:using-superpowers` and `bughunter-oracles` according to its normal skill-selection behavior; these were harmless read-only loads.

A post-run process check found no processes associated with the temporary discovery root or Bughunter test fixtures. No background tasks were left running.

## Files changed

- Created `.kimi-code/skills/bughunter/SKILL.md` — manual entry and complete sequential orchestration.
- Created `.kimi-code/skills/bughunter-oracles/SKILL.md` — reusable deterministic bug oracles.
- Created `.kimi-code/skills/bughunter-red-test/SKILL.md` — reusable red-test rules.
- Modified `.kimi-code/agents/bh-explorer.md` — added mandatory oracle-skill invocation; retained prior behavior and tools.
- Created `.kimi-code/agents/bh-reviewer.md` — run-state-only review and triage.
- Created `.kimi-code/agents/bh-test-writer.md` — e2e-first and bounded unit-test writing without Bash.
- Created `.kimi-code/bughunter/server/test/prompts.bhtest.ts` — dependency-free prompt/frontmatter contract tests.
- Created `/Users/nemiok/Desktop/projects/vault/.superpowers/sdd/task-14-report.md` — this report.

## Self-review

- [x] All six brief-specified prompt files exist; explorer was modified as requested.
- [x] Prompts are concise Russian imperatives with explicit stop conditions.
- [x] Entry frontmatter and `$ARGUMENTS` contract match the brief exactly.
- [x] `diff` is the default; full/route/resume are present.
- [x] Delegation is sequential, foreground, and uses the real custom agent names.
- [x] Main-agent browser use and commits are explicitly forbidden.
- [x] Unreproduced candidates are excluded; only confirmed bugs reach the writer.
- [x] Finish/report summary includes found, confirmed, files, and report path.
- [x] Agent allowlists, empty subagents, forbidden fields, and final-result instructions are tested exactly.
- [x] Reviewer read boundary and doubtful-candidate rejection are explicit.
- [x] Writer has no Bash, exports e2e first, limits unit work to three iterations, invokes red-test skill, and never edits application code.
- [x] Both `whenToUse` strings match exactly.
- [x] Focused RED and GREEN, full tests, typecheck, and installed-CLI discovery were actually run and inspected.
- [x] No dependency, commit, further implementation agent, unrelated edit, temporary discovery file, or leftover process remains.

## Concerns and follow-up

- Task 15's full real-model `/bughunter full` run was intentionally not performed; end-to-end confirmation quality and generated red tests remain Task 15's verification boundary.
- Interactive workspace trust was not rechecked; headless discovery used `KIMI_CODE_TRUST_WORKSPACE=1`, consistent with Task 1.
- No unresolved implementation or test concerns remain within Task 14.

## Review package correction

The controller regenerated the review diff with basename exclusions `runs` and `auth`. The previous `state/runs` diff exclude did not exclude nested run artifacts. No run state was deleted or edited as part of this correction; the implementation scope remains the Task 14 files listed above.
