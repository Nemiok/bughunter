# Task 1: Verify Kimi Code CLI Compatibility — Report

Date: 2026-11-10
Workspace: `/Users/nemiok/Desktop/projects/vault/bughunter`
Installed `kimi`: 2.5.2

## Summary

Four CLI compatibility behaviours were verified with real `kimi -p` runs: stdio MCP `cwd` defaults to the project root; `/bughunter` resolves to `/skill:bughunter`; custom project agents are auto-discovered; and project skills are accessible to a subagent dispatched via the `Agent` tool. Interactive workspace trust was **not** exercised and remains a manual prerequisite. No code outside the workspace or the designated report path was modified. No commits were made.

## Installed command surface

```text
$ kimi --version
2.5.2
```

`kimi --help` confirms the flags used for the probes: `--version`, `--prompt`/`-p`, `--agent`, `--agent-file`, `--skills-dir`, `--output-format stream-json`, plus `--yolo`/`--auto` and trust env vars documented elsewhere.

## Documentation consulted

The built-in `check-kimi-code-docs` skill was invoked for each of the four questions, then the referenced pages were fetched directly.

| Question | Page fetched | URL | Explicit / Inferred |
| --- | --- | --- | --- |
| stdio MCP `cwd` default | MCP customization | `https://www.kimi.com/code/docs/en/kimi-code-cli/customization/mcp.html` | Inferred — docs list an optional `cwd` field but do not state the default; runtime probe confirms default is project root. |
| `/bughunter` alias | Slash Commands reference | `https://www.kimi.com/code/docs/en/kimi-code-cli/reference/slash-commands.html` | Explicit — "external Skill commands also support a shorthand form that omits the `skill:` prefix — `/<name>` … `/code-style` falls back to matching `/skill:code-style`." |
| Project agent discovery | Agents and Sub-Agents | `https://www.kimi.com/code/docs/en/kimi-code-cli/customization/agents.html` | Explicit — project-level agents are discovered in `.kimi-code/agents/` and `.agents/agents/` relative to the nearest `.git` directory. |
| Project skill access from agent | Agent Skills | `https://www.kimi.com/code/docs/en/kimi-code-cli/customization/skills.html` | Explicit — project skills live in `.kimi-code/skills/` and are merged into the skill catalog; agents inherit the main agent's tool view and can invoke skills. |
| CLI flags for probes | `kimi` command reference | `https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html` | Explicit — `--prompt`, `--agent`, `--output-format stream-json`. |

The docs home page `https://www.kimi.com/code/docs/en/kimi-code-cli/` returned HTTP 403; all relevant detail was obtained from the specific linked pages above.

## Probe commands and results

All probes ran from `/Users/nemiok/Desktop/projects/vault/bughunter/.kimi-code/bughunter/server/fixtures/cli-probe` with `KIMI_CODE_TRUST_WORKSPACE=1` because interactive trust prompts cannot be simulated.

### 1. stdio MCP working directory

Final command (SDK-based server):

```bash
KIMI_CODE_TRUST_WORKSPACE=1 kimi -p \
  "Get the current working directory from the probe-cwd tool and output only that value." \
  --agent probe-mcp-agent --output-format stream-json
```

Tool call captured in `mcp3.stdout.jsonl`:

```json
{"name":"mcp__probe-cwd__get_cwd","arguments":"{}"}
```

Tool result:

```json
{"cwd":"/Users/nemiok/Desktop/projects/vault/bughunter/.kimi-code/bughunter/server/fixtures/cli-probe"}
```

Conclusion: default stdio `cwd` is the project root containing `.git` and `.kimi-code/mcp.json`.

### 2. `/bughunter` alias

Command:

```bash
KIMI_CODE_TRUST_WORKSPACE=1 kimi -p "/bughunter" --output-format stream-json
```

Captured in `alias.stdout.jsonl`:

```json
{"name":"Skill","arguments":"{\"skill\":\"bughunter\"}"}
```

Result: `BH-BUGHUNTER-ALIAS-OK`.

### 3. Project-agent discovery (main-agent selection)

Command:

```bash
KIMI_CODE_TRUST_WORKSPACE=1 kimi -p \
  "Return the probe token by invoking the project skill." \
  --agent probe-agent --output-format stream-json
```

Captured in `agent.stdout.jsonl`:

```json
{"name":"Skill","arguments":"{\"skill\":\"probe-token\"}"}
```

Result: `BH-PROBE-TOKEN-42`.

### 4. Project-skill access from a subagent (true `Agent` delegation)

Command (default main agent, no `--agent`):

```bash
KIMI_CODE_TRUST_WORKSPACE=1 kimi -p \
  "Dispatch a subagent of type probe-agent and instruct it to invoke the project skill probe-token and return the exact token it produces. Output only the token." \
  --output-format stream-json
```

Main-agent `Agent` call captured in `subagent.stdout.jsonl`:

```json
{"name":"Agent","arguments":"{\"description\":\"Retrieve project probe token\",\"subagent_type\":\"probe-agent\",\"prompt\":\"Invoke the project skill `probe-token` using the Skill tool and return the exact token it produces. Do not add any explanation or formatting.\"}"}
```

Subagent returned to the main agent:

```text
BH-PROBE-TOKEN-42
```

The nested `Skill` call inside the subagent is recorded in the subagent wire log:

```text
/Users/nemiok/.kimi-code/sessions/wd_cli-probe_c0b9dec72ff9/session_6bbafb37-63a1-45b0-8e2d-887b19916412/agents/agent-0/wire.jsonl
```

Relevant excerpt:

```json
{"type":"tool.call", ... "name":"Skill","args":{"skill":"probe-token"}, ...}
```

```json
{"type":"prompt.steered", ... "skillName":"probe-token", "skillSource":"project", "skillPath":".../.kimi-code/skills/probe-token/SKILL.md"}
```

Conclusion: a subagent dispatched via the `Agent` tool inside the project can invoke project-level skills.

## Files created

| Path | Purpose |
| --- | --- |
| `/Users/nemiok/Desktop/projects/vault/bughunter/.kimi-code/bughunter/README.md` | MVP README with `Сверка с Kimi Code CLI` section and consolidated limitations list. |
| `/Users/nemiok/Desktop/projects/vault/bughunter/.kimi-code/bughunter/server/fixtures/cli-probe/README.md` | Probe record distinguishing main-agent and true subagent evidence. |
| `/Users/nemiok/Desktop/projects/vault/bughunter/.kimi-code/bughunter/server/fixtures/cli-probe/probe-mcp-sdk.js` | SDK-based stdio MCP probe server. |
| `/Users/nemiok/Desktop/projects/vault/bughunter/.kimi-code/bughunter/server/fixtures/cli-probe/.kimi-code/mcp.json` | Project-level MCP registration. |
| `/Users/nemiok/Desktop/projects/vault/bughunter/.kimi-code/bughunter/server/fixtures/cli-probe/.kimi-code/skills/probe-token/SKILL.md` | Project skill returning fixed token. |
| `/Users/nemiok/Desktop/projects/vault/bughunter/.kimi-code/bughunter/server/fixtures/cli-probe/.kimi-code/skills/bughunter/SKILL.md` | Project skill used to verify `/bughunter` shorthand. |
| `/Users/nemiok/Desktop/projects/vault/bughunter/.kimi-code/bughunter/server/fixtures/cli-probe/.kimi-code/agents/probe-agent.md` | Custom agent that invokes project skill. |
| `/Users/nemiok/Desktop/projects/vault/bughunter/.kimi-code/bughunter/server/fixtures/cli-probe/.kimi-code/agents/probe-mcp-agent.md` | Custom agent restricted to the MCP tool and skills. |
| `/Users/nemiok/Desktop/projects/vault/bughunter/.kimi-code/bughunter/server/fixtures/cli-probe/package.json` + `node_modules/` | Probe dependency on `@modelcontextprotocol/sdk`. |
| `/Users/nemiok/Desktop/projects/vault/bughunter/.kimi-code/bughunter/server/fixtures/cli-probe/*.stdout.jsonl`, `*.stderr.jsonl`, `*.exit.txt` | Captured raw CLI output for each probe. |

## Discrepancies and unresolved manual checks

- **stdio `cwd` default is not explicit in docs.** The MCP page only says `cwd` is an optional stdio field. Runtime evidence shows the default is the project root. The planned `mcp.json` fragment should therefore omit `cwd` unless a different working directory is required.
- **Interactive trust was not exercised.** Headless probes used `KIMI_CODE_TRUST_WORKSPACE=1`. A real user must still trust the folder on first interactive launch; this is documented in the probe README and main README as a manual prerequisite.
- **Subagent delegation was verified only in headless mode.** The `Agent` tool dispatched `probe-agent` successfully, and the nested `Skill` call is visible in the subagent wire log. In interactive mode the dispatch may still require user approval.
- **The docs home page returned HTTP 403.** `https://www.kimi.com/code/docs/en/kimi-code-cli/` was unavailable; all facts were sourced from specific linked pages.
- **Initial hand-written stdio server buffered its first response and timed out.** This was resolved by using `@modelcontextprotocol/sdk`. This is a probe implementation issue, not a product incompatibility.

## Self-review

- [x] Every compatibility claim is backed by a captured `*.stdout.jsonl` file, subagent wire log, documentation URL, or direct command output.
- [x] Interactive trust is explicitly listed as pending/unverified.
- [x] No unsupported CLI flags were invented; only `--prompt`, `--agent`, `--output-format`, and `KIMI_CODE_TRUST_WORKSPACE` from docs/installed help were used.
- [x] No files were modified outside the workspace or the designated report path.
- [x] No commits, branches, or pushes were made.
- [x] The report distinguishes explicit documentation statements from runtime-inferred facts.

---

## Fix section (added after review)

### Review findings addressed

1. The previous `--agent probe-agent` run only proved main-agent selection. A true subagent dispatch via the `Agent` tool has now been run and recorded.
2. `.kimi-code/bughunter/README.md` no longer marks interactive trust as checked; a consolidated limitations list was added.
3. The probe README now distinguishes main-agent evidence from true `Agent`-subagent evidence.
4. The report summary and self-review were corrected to state that the four CLI behaviours are verified while interactive trust remains pending.
5. `package.json` had its obsolete `main` and empty `description` fields removed; the unused hand-written `probe-mcp.js` was deleted.

### New evidence: true subagent delegation

Command:

```bash
cd /Users/nemiok/Desktop/projects/vault/bughunter/.kimi-code/bughunter/server/fixtures/cli-probe
KIMI_CODE_TRUST_WORKSPACE=1 kimi -p \
  "Dispatch a subagent of type probe-agent and instruct it to invoke the project skill probe-token and return the exact token it produces. Output only the token." \
  --output-format stream-json > subagent.stdout.jsonl 2>subagent.stderr.jsonl
echo "EXIT:$?" > subagent.exit.txt
```

Exit code: `0` (`subagent.exit.txt`).

Main-agent `Agent` tool call (from `subagent.stdout.jsonl`):

```json
{"name":"Agent","arguments":"{\"description\":\"Retrieve project probe token\",\"subagent_type\":\"probe-agent\",\"prompt\":\"Invoke the project skill `probe-token` using the Skill tool and return the exact token it produces. Do not add any explanation or formatting.\"}"}
```

Subagent result returned to main agent:

```text
BH-PROBE-TOKEN-42
```

Nested `Skill` call inside the subagent (from `~/.kimi-code/sessions/wd_cli-probe_c0b9dec72ff9/session_6bbafb37-63a1-45b0-8e2d-887b19916412/agents/agent-0/wire.jsonl`):

```json
{"type":"tool.call", "toolCallId":"tool_6WMY4tqe0EeDwb42OaV8nEBF", "name":"Skill", "args":{"skill":"probe-token"}}
```

```json
{"type":"prompt.steered", "skillName":"probe-token", "skillSource":"project", "skillPath":"/Users/nemiok/Desktop/projects/vault/bughunter/.kimi-code/bughunter/server/fixtures/cli-probe/.kimi-code/skills/probe-token/SKILL.md"}
```

### Files changed in the fix

| Path | Change |
| --- | --- |
| `/Users/nemiok/Desktop/projects/vault/bughunter/.kimi-code/bughunter/README.md` | Added interactive trust as pending; added consolidated limitations list; refined evidence wording. |
| `/Users/nemiok/Desktop/projects/vault/bughunter/.kimi-code/bughunter/server/fixtures/cli-probe/README.md` | Added true subagent section; clarified main-agent vs subagent evidence. |
| `/Users/nemiok/Desktop/projects/vault/bughunter/.kimi-code/bughunter/server/fixtures/cli-probe/subagent.stdout.jsonl` | New captured output from the true subagent probe. |
| `/Users/nemiok/Desktop/projects/vault/bughunter/.kimi-code/bughunter/server/fixtures/cli-probe/subagent.stderr.jsonl` | New captured stderr from the true subagent probe. |
| `/Users/nemiok/Desktop/projects/vault/bughunter/.kimi-code/bughunter/server/fixtures/cli-probe/subagent.exit.txt` | New exit code from the true subagent probe. |
| `/Users/nemiok/Desktop/projects/vault/bughunter/.kimi-code/bughunter/server/fixtures/cli-probe/package.json` | Removed obsolete `main` and `description` fields. |
| `/Users/nemiok/Desktop/projects/vault/bughunter/.kimi-code/bughunter/server/fixtures/cli-probe/probe-mcp.js` | Deleted; no longer needed as evidence. |
| `/Users/nemiok/Desktop/projects/vault/.superpowers/sdd/task-1-report.md` | Corrected summary/self-review and appended this fix section. |

### Test results after fix

- `kimi --version`: `2.5.2`
- stdio MCP cwd probe (`mcp3.stdout.jsonl`): exit 0, returned project root.
- `/bughunter` alias probe (`alias.stdout.jsonl`): exit 0, returned `BH-BUGHUNTER-ALIAS-OK`.
- Main-agent selection probe (`agent.stdout.jsonl`): exit 0, returned `BH-PROBE-TOKEN-42`.
- True subagent delegation probe (`subagent.stdout.jsonl`): exit 0, main agent called `Agent(subagent_type="probe-agent")`, subagent returned `BH-PROBE-TOKEN-42`; nested `Skill` call confirmed in subagent wire log.
