# Task 7: Minimal Explorer and Manual Hypothesis Gate — Report

Date: 2026-11-10  
Workspace: `/Users/nemiok/Desktop/projects/vault/bughunter`  
Installed CLI: `kimi` 2.5.2  
Run: `20261110T183903.629Z-a7b6a6ff29a9`

## Status and gate verdict

**PASS.** Twelve fresh, sequential, model-driven `bh-explorer` sessions covered every configured demo route with all three MVP personas. Every CLI process exited 0 and every browser session returned successful `bh_close`.

The model created **33 real persisted candidates**, covering **4 distinct seeded bugs**: 1, 2, 3, and 5. This exceeds the three-bug threshold, so later tasks are not blocked by the Stage 1 stop rule. No reproduction, triage, export, or later agent was implemented. Candidates are not confirmed bugs; the total includes repeated observations and non-seeded hypotheses. No scripted Task 6 signal was counted as an explorer candidate.

Seeded bug 4 (`NaN` on empty orders) received no explorer candidate. Its absence does not change the PASS verdict.

## Implementation

- Created `.kimi-code/agents/bh-explorer.md` with Russian description, the seven explorer MCP tools under full `mcp__bughunter__...` names plus `Skill`, `subagents: []`, and no model/override. The body requires `bh_state` between individual actions, deterministic signal/check-backed candidates, stop on `LIMIT_REACHED`/exhausted ideas/five candidates, mandatory close, and a standalone final candidate-ID list.
- Created `.kimi-code/mcp.json` with only the requested `bughunter` stdio entry. There was no pre-existing file/server entry to preserve. `cwd` is omitted because Task 1 proved project-root default behavior.
- Changed `.kimi-code/bughunter/state/config.json` `baseUrl` and `allowedOrigins` from the placeholder origin to `http://127.0.0.1:4173`, as explicitly authorized by the controller dispatch to make the configuration match the running demo fixture. Routes remain exactly `/`, `/orders`, `/orders/new`, `/profile`.
- Updated `.kimi-code/bughunter/README.md` with the complete manual matrix, candidate count, gate verdict, raw evidence path, and headless-trust limitation.

## Isolated real-CLI setup

Because the nearest repository root was the parent vault, the real runs used the temporary project `/Users/nemiok/Desktop/projects/vault/bughunter/.task-7-gate`, with its own `.git`, a copy of the project agent, and an MCP argument pointing to the absolute reviewed server. No repository structure outside that temporary fixture was changed.

Demo command:

```bash
cd /Users/nemiok/Desktop/projects/vault/bughunter/.kimi-code/bughunter/server/fixtures/buggy-app
npm run dev -- --host 127.0.0.1 --port 4173 --strictPort
```

Fixture commands:

```bash
cd /Users/nemiok/Desktop/projects/vault/bughunter
mkdir -p .task-7-gate && git init .task-7-gate && cp .kimi-code/agents/bh-explorer.md .task-7-gate/bh-explorer.md
cd .task-7-gate
mkdir -p .kimi-code/agents && mv bh-explorer.md .kimi-code/agents/bh-explorer.md
```

Fixture `.kimi-code/mcp.json`:

```json
{
  "mcpServers": {
    "bughunter": {
      "command": "node",
      "args": ["/Users/nemiok/Desktop/projects/vault/bughunter/.kimi-code/bughunter/server/src/index.ts"],
      "startupTimeoutMs": 30000,
      "toolTimeoutMs": 600000
    }
  }
}
```

The first attempted run-creation command included `--yolo`; installed CLI 2.5.2 exited 1 immediately with `error: Cannot combine --prompt with --yolo.` No model session or MCP run was created by that attempt. The successful command, using the Task 1 headless trust mechanism, was:

```bash
cd /Users/nemiok/Desktop/projects/vault/bughunter/.task-7-gate
KIMI_CODE_TRUST_WORKSPACE=1 kimi -p 'Вызови инструмент mcp__bughunter__bh_start_run ровно один раз с аргументами {"scope":"full"}. Верни только runId из результата, без других действий и текста.' --output-format stream-json > start.stdout.jsonl 2> start.stderr.jsonl
```

It returned run `20261110T183903.629Z-a7b6a6ff29a9` and routes `["/","/orders","/orders/new","/profile"]`. Start CLI session: `session_763fb9b2-22ad-4206-be06-bfbe94d0dd50`.

First explorer command:

```bash
KIMI_CODE_TRUST_WORKSPACE=1 kimi -p 'runId: 20261110T183903.629Z-a7b6a6ff29a9
Маршрут: /
Персона: новичок
Исследуй этот маршрут согласно своим инструкциям.' --agent bh-explorer --output-format stream-json > 01-home-newbie.stdout.jsonl 2> 01-home-newbie.stderr.jsonl
```

The remaining sessions ran sequentially in this exact loop (no parallel explorers):

```bash
set -u
run_id='20261110T183903.629Z-a7b6a6ff29a9'
sessions=(
  '02-home-impatient|/|нетерпеливый'
  '03-home-boundary|/|граничный ввод'
  '04-orders-newbie|/orders|новичок'
  '05-orders-impatient|/orders|нетерпеливый'
  '06-orders-boundary|/orders|граничный ввод'
  '07-orders-new-newbie|/orders/new|новичок'
  '08-orders-new-impatient|/orders/new|нетерпеливый'
  '09-orders-new-boundary|/orders/new|граничный ввод'
  '10-profile-newbie|/profile|новичок'
  '11-profile-impatient|/profile|нетерпеливый'
  '12-profile-boundary|/profile|граничный ввод'
)
: > remaining-exits.tsv
for entry in "${sessions[@]}"; do
  IFS='|' read -r slug route persona <<< "$entry"
  KIMI_CODE_TRUST_WORKSPACE=1 kimi -p "runId: ${run_id}
Маршрут: ${route}
Персона: ${persona}
Исследуй этот маршрут согласно своим инструкциям." --agent bh-explorer --output-format stream-json > "${slug}.stdout.jsonl" 2> "${slug}.stderr.jsonl"
  code=$?
  printf '%s\t%s\n' "$slug" "$code" | tee -a remaining-exits.tsv
  printf '%s\n' "$code" > "${slug}.exit.txt"
done
```

## Run/session matrix

Candidate IDs below come from successful `bh_report_candidate` tool results, not from Task 6 or inferred titles. “Last action” is the last successful browser `bh_act`, `bh_navigate`, or `bh_probe`; a subsequent successful close is common to every row. `stepsLeft` is the minimum observed value.

| # | Route / persona | CLI session | Candidate IDs | Signal types | Last action; stepsLeft | Errors / stuck point |
| --- | --- | --- | --- | --- | --- | --- |
| 01 | `/` / новичок | `session_5afa972f-0a83-4c85-b2a5-bdcd3d8380b1` | `da35e99c-d86e-4b72-bec3-3766812c8842`; `f0d0406d-ad42-442c-9be6-7081894841c1`; `fceed4c6-620e-4098-9589-dcd7b48c3d52`; `7d134806-f7aa-4130-a8fd-9c6537c321d5` | console, response | `bh_navigate /orders?page=2`; 40 | None; exit 0, closed |
| 02 | `/` / нетерпеливый | `session_fa9af9ed-3d30-4b89-a824-0f57aae4e249` | `66c1fe04-52a6-436e-852f-ae5cad6743cc`; `4da53734-632b-45f2-8c0f-847dce852ed0`; `2c49758f-4064-46d7-a9c7-0e49f6094e85`; `51e5d69b-8d1b-4134-8509-1139fdb935cf` | console, pageerror, response | `bh_probe reload`; 31 | None; exit 0, closed |
| 03 | `/` / граничный ввод | `session_7871f3ad-bf5e-4cd5-99eb-adda72bf94a3` | `0e649bc1-6679-416c-b549-4114b03e50a5`; `287f9ac8-3e87-41af-b13d-e12efb525e03`; `ec13dc66-1423-46b0-b994-7cacce8f1e06`; `37e2dc0b-0341-46c0-b730-bd493092b52d` | response, console, pageerror | `bh_act click`; 26 | 2 `APIConnectionError` + 1 `APITimeoutError` retries; recovered, exit 0, closed |
| 04 | `/orders` / новичок | `session_a7050fbe-b6c8-49cc-a0b9-228fa44fb8a1` | `3e8eba90-fa35-4dbe-bcf6-7017e1de8ee9`; `17ffea05-786f-4f6a-a8f7-c9d5051de76b` | console, response | `bh_navigate /orders?page=abc`; 45 | None; exit 0, closed |
| 05 | `/orders` / нетерпеливый | `session_6cf50cb5-277e-439c-8b9b-a30271835efe` | `fd6266b2-1984-4e3d-9c8f-c4e744732429`; `64d1688d-1cd9-4394-b625-e8f6e89d6c41` | console, response | `bh_act click`; 37 | 1 `APIConnectionError` + 3 `APITimeoutError` retries; recovered, exit 0, closed |
| 06 | `/orders` / граничный ввод | `session_d6a09fd7-19f8-473f-8f44-9b4a0b72f602` | `25f384a7-1cb4-48b8-bfe1-531211409f31`; `5c972d13-4a69-4054-b72f-43fe86d25357` | response, console | `bh_probe mobile_viewport`; 37 | 1 `APIConnectionError` + 1 `APITimeoutError` retries; recovered, exit 0, closed |
| 07 | `/orders/new` / новичок | `session_4892d34f-2175-4325-b8e2-c2fa4712f7e4` | `0a70f75a-197f-4e25-be73-e62d7486d4d8` | console, response | `bh_probe reload`; 47 | None; exit 0, closed |
| 08 | `/orders/new` / нетерпеливый | `session_cac62447-a33d-42e2-b555-1b8a7ea60b22` | `c4e964ee-5e23-4097-a972-bd49d297c0e0`; `f6262e30-93f1-456d-b26c-2619242d4ee2`; `69462aa6-b281-48d3-8951-53ce022b1ad7`; `163ce78e-fba6-4411-919a-bec3d91523f7` | console, response | `bh_act click`; 33 | One recovered `bh_report_candidate` invalid-args error: `check.expected: true`, expected string/number; retry omitted `expected` and succeeded; exit 0, closed |
| 09 | `/orders/new` / граничный ввод | `session_bbc259d3-3bad-4e75-adea-763c4e5cfa5a` | `02c93fb3-9de2-4f81-86ba-ad3359b86e9c`; `b3dab839-7ff4-4c31-b8a3-632b25c6db8a` | response, console | `bh_act click`; 42 | 5 `APIConnectionError` + 6 `APITimeoutError` retries; recovered, exit 0, closed |
| 10 | `/profile` / новичок | `session_42180211-70d0-4dc2-b9fd-83aef9423df3` | `9e09581e-d562-48df-b2fa-0c31a043421a`; `d66fc3ed-0e19-40aa-aaca-fb75831320fa`; `3313c7a0-f1b3-4a02-9236-dcfd4be1cb4f` | pageerror | `bh_act click`; 47 | None; exit 0, closed |
| 11 | `/profile` / нетерпеливый | `session_ffd6a344-01bd-4beb-9fa2-b60e3a02d307` | `de6dc8f5-d7dc-4105-aaf7-6d492bd6740e`; `88f31949-273a-4b0e-a2c7-eeb21fbe7c53` | pageerror | `bh_act click`; 49 | None; exit 0, closed |
| 12 | `/profile` / граничный ввод | `session_39ef9cfe-ccd7-44b4-968a-15dbd5239ff0` | `1e48f556-f3bb-4ca9-89dc-360956129ff1`; `16a43f94-58c9-43f4-8b01-68f0f615e1a6`; `f69b86d5-26e7-40b5-ae94-f33cc7fa7206` | pageerror | `bh_probe mobile_viewport`; 35 | None; exit 0, closed |

Session 08 contained one recovered MCP argument-validation error from `bh_report_candidate`: `check.expected` was boolean `true` instead of string/number. The model retried without `expected`, and candidate `69462aa6-b281-48d3-8951-53ce022b1ad7` was persisted. There were no unresolved MCP errors, no `LIMIT_REACHED`, no unclosed browser session, and no unfinished route/persona cell. Provider retries increased duration but did not require restarting any session.

The original runtime also occasionally issued `bh_act`, `bh_navigate`, or `bh_probe` without an intervening `bh_state`. This is an observed prompt-adherence limitation of the recorded run. The explorer prompt has now been strengthened to require `bh_state` after every action/probe/navigation before any subsequent browser action, while still evaluating signals returned by the action itself. The recorded model sessions were not rerun.

## Candidate-to-seeded-bug coverage

| Seeded bug | Covered? | Example real explorer candidate | Evidence |
| --- | --- | --- | --- |
| 1. Empty profile name throws | Yes | `4da53734-632b-45f2-8c0f-847dce852ed0` (also candidates in sessions 03, 10, 11, 12) | `pageerror: Profile name is required` |
| 2. Quantity 0 returns HTTP 500 | Yes | `f0d0406d-ad42-442c-9be6-7081894841c1` (also candidates in sessions 02–09) | `response` HTTP 500, often accompanied by console resource error |
| 3. Double click creates two orders | Yes | `163ce78e-fba6-4411-919a-bec3d91523f7` | Check-backed `elementCount` observation after `dblclick` |
| 4. Empty orders total shows `NaN` | No | None | No explorer candidate; scripted Task 6 anomaly deliberately not counted |
| 5. Page 2 resets filter / console error | Yes | `fceed4c6-620e-4098-9589-dcd7b48c3d52` (also candidates in sessions 02, 04–06, 08) | `console: Orders page filter reset` |

Other candidates concern, for example, profile persistence, whitespace-only names, negative quantities, and pagination controls. They remain unprocessed and untriaged; this report does not claim they are valid or false bugs.

## Raw evidence

Copied raw evidence directory:

```text
/Users/nemiok/Desktop/projects/vault/bughunter/.kimi-code/bughunter/state/runs/20261110T183903.629Z-a7b6a6ff29a9/manual-gate/
```

It contains `start.stdout.jsonl`, `start.stderr.jsonl`, twelve `NN-*.stdout.jsonl` files, corresponding stderr and exit files, `remaining-exits.tsv`, and `fixture-mcp.json`. Candidate JSON, journals, screenshots, traces, and videos remain under the same run directory. The temporary Git fixture was removed after evidence was copied.

## Verification

Static configuration validation confirmed the local demo origin, exact four routes, and the single expected MCP server entry.

After all real sessions and demo shutdown:

```bash
cd /Users/nemiok/Desktop/projects/vault/bughunter/.kimi-code/bughunter/server
npm test
npm run typecheck
```

Results:

- `npm test`: **38 passed, 0 failed, 0 cancelled, 0 skipped**.
- `npm run typecheck`: exit 0, no diagnostics.
- Real CLI matrix: **12/12 exit 0**, **12/12 successful `bh_close`**, **33 candidates**, **4/5 seeded bugs covered**.

## Concerns and limits

- These were headless `kimi -p` runs with `KIMI_CODE_TRUST_WORKSPACE=1`, not interactive sessions. Interactive folder trust and interactive permission prompts remain unverified; no `--model` or agent model override was used.
- Provider connection/timeout retries occurred in sessions 03, 05, 06, and 09. All recovered within the existing CLI loop; no completed session was rerun.
- The explorer sometimes followed navigation beyond its initially assigned route. This produced duplicate candidates across sessions, but every requested route/persona still received its own real session.
- Bug 4 was not converted into a candidate by the explorer. This is recorded as a coverage gap, not hidden by scripted detector evidence.
- No reproduction, triage, export, commit, push, or further agent implementation was performed.


## Review fixes: validation error, action sequencing, and config rationale

Gate verdict remains **PASS**; these are documentation and prompt-only corrections. No model session, test suite, or typecheck was rerun for this review fix, as instructed.

1. **Recovered session 08 validation error is now recorded in both matrices and summaries.** Exact evidence: `/Users/nemiok/Desktop/projects/vault/bughunter/.kimi-code/bughunter/state/runs/20261110T183903.629Z-a7b6a6ff29a9/manual-gate/08-orders-new-impatient.stdout.jsonl`, lines 102–104. Line 102 sends `check.expected: true`; line 103 returns `Invalid args for tool "mcp__bughunter__bh_report_candidate": /check/expected must be string,number`; line 104 retries without `expected`. The resulting persisted candidate is `/Users/nemiok/Desktop/projects/vault/bughunter/.kimi-code/bughunter/state/runs/20261110T183903.629Z-a7b6a6ff29a9/candidates/69462aa6-b281-48d3-8951-53ce022b1ad7.json`.
2. **Occasional missing intermediate `bh_state` is now an explicit runtime limitation.** Examples from the preserved original run: `manual-gate/01-home-newbie.stdout.jsonl` lines 34 and 38; `02-home-impatient.stdout.jsonl` lines 46/48, 74/76, and 92/94; `04-orders-newbie.stdout.jsonl` lines 14/16; `12-profile-boundary.stdout.jsonl` lines 20/22 and 30/32. These are pairs of browser actions without an intervening `bh_state`. The prompt at `/Users/nemiok/Desktop/projects/vault/bughunter/.kimi-code/agents/bh-explorer.md` now explicitly requires `bh_state` after every `bh_act`, `bh_navigate`, or `bh_probe` before any subsequent browser action, while retaining evaluation of action-returned signals. The historical evidence was not rewritten and no model sessions were rerun.
3. **The local origin change was intentional and authorized.** `/Users/nemiok/Desktop/projects/vault/bughunter/.kimi-code/bughunter/state/config.json` uses `http://127.0.0.1:4173` for `baseUrl` and `allowedOrigins` because the controller explicitly required the configuration to match the running real demo fixture. This rationale is now recorded in both this report and `/Users/nemiok/Desktop/projects/vault/bughunter/.kimi-code/bughunter/README.md`; the origin change was not reverted.

Files changed in this review fix: `.kimi-code/agents/bh-explorer.md`, `.kimi-code/bughunter/README.md`, and this report. No commits or other edits were made.
