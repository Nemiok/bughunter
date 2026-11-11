# Kimi Code CLI compatibility probe

This directory is a throwaway, self-contained project used to verify four Kimi Code CLI behaviours required by the Bughunter MVP. It is intentionally not part of the final deliverable.

## Probe files

| File | Purpose |
| --- | --- |
| `probe-mcp-sdk.js` | Minimal stdio MCP server using `@modelcontextprotocol/sdk`; exposes `get_cwd`. |
| `.kimi-code/mcp.json` | Project-level MCP registration for `probe-cwd`. |
| `.kimi-code/skills/probe-token/SKILL.md` | Project skill that returns a fixed token. |
| `.kimi-code/skills/bughunter/SKILL.md` | Project skill used to verify the `/bughunter` shorthand. |
| `.kimi-code/agents/probe-agent.md` | Custom agent that can invoke the `probe-token` skill. |
| `.kimi-code/agents/probe-mcp-agent.md` | Custom agent restricted to the `mcp__probe-cwd__get_cwd` tool and skills. |
| `*.stdout.jsonl`, `*.stderr.jsonl`, `*.exit.txt` | Raw captured output from each `kimi -p` run. |

## Installed CLI

```text
$ kimi --version
2.5.2
```

## Trust note

Interactive trust prompts cannot be simulated in a non-interactive verification. Every probe was run with `KIMI_CODE_TRUST_WORKSPACE=1` so that project-level `.kimi-code/mcp.json`, skills, and agents were loaded in headless `kimi -p` mode. In normal use a user must trust the folder when first launching `kimi` from this directory; that interactive step was **not** performed.

## Probe results

### 1. stdio MCP working directory

Command (from this directory):

```bash
KIMI_CODE_TRUST_WORKSPACE=1 kimi -p \
  "Get the current working directory from the probe-cwd tool and output only that value." \
  --agent probe-mcp-agent --output-format stream-json
```

Tool call observed (`mcp3.stdout.jsonl`):

```json
{"name":"mcp__probe-cwd__get_cwd","arguments":"{}"}
```

Tool result:

```json
{"cwd":"/Users/nemiok/Desktop/projects/vault/bughunter/.kimi-code/bughunter/server/fixtures/cli-probe"}
```

Verdict: the stdio MCP server process runs with `cwd` equal to the project root (the directory that contains `.git` and `.kimi-code/mcp.json`). No explicit `cwd` field is required in `mcp.json` for this default.

### 2. `/bughunter` alias behaviour

Command:

```bash
KIMI_CODE_TRUST_WORKSPACE=1 kimi -p "/bughunter" --output-format stream-json
```

Observed tool call (`alias.stdout.jsonl`):

```json
{"name":"Skill","arguments":"{\"skill\":\"bughunter\"}"}
```

Result: `BH-BUGHUNTER-ALIAS-OK`

Verdict: `/bughunter` resolves to `/skill:bughunter` when no built-in or plugin slash command claims the name. This matches the documented shorthand rule.

### 3. Project-agent discovery (main-agent selection)

A custom agent file at `.kimi-code/agents/probe-agent.md` was discovered automatically and selected with `--agent probe-agent`.

Command:

```bash
KIMI_CODE_TRUST_WORKSPACE=1 kimi -p \
  "Return the probe token by invoking the project skill." \
  --agent probe-agent --output-format stream-json
```

Observed tool call (`agent.stdout.jsonl`):

```json
{"name":"Skill","arguments":"{\"skill\":\"probe-token\"}"}
```

Result: `BH-PROBE-TOKEN-42`

Verdict: custom agents in `.kimi-code/agents/` are discovered for the project and can be selected as the main agent.

### 4. Project-skill access from a subagent (true `Agent` delegation)

This is the stricter check: the **default** main agent was asked to dispatch a subagent of type `probe-agent`, and the subagent invoked the project skill.

Command:

```bash
KIMI_CODE_TRUST_WORKSPACE=1 kimi -p \
  "Dispatch a subagent of type probe-agent and instruct it to invoke the project skill probe-token and return the exact token it produces. Output only the token." \
  --output-format stream-json
```

Main-agent `Agent` call observed (`subagent.stdout.jsonl`):

```json
{"name":"Agent","arguments":"{\"description\":\"Retrieve project probe token\",\"subagent_type\":\"probe-agent\",\"prompt\":\"Invoke the project skill `probe-token` using the Skill tool and return the exact token it produces. Do not add any explanation or formatting.\"}"}
```

Subagent result returned to the main agent:

```text
BH-PROBE-TOKEN-42
```

The nested `Skill` call inside the subagent is captured in the subagent wire log:

```text
/Users/nemiok/.kimi-code/sessions/wd_cli-probe_c0b9dec72ff9/session_6bbafb37-63a1-45b0-8e2d-887b19916412/agents/agent-0/wire.jsonl
```

Relevant excerpt:

```json
{"type":"tool.call", ... "name":"Skill","args":{"skill":"probe-token"}, ...}
```

```json
{"type":"prompt.steered", ... "skillName":"probe-token", ... "skillSource":"project", "skillPath":".../.kimi-code/skills/probe-token/SKILL.md"}
```

Verdict: project skills are visible to subagents dispatched via the `Agent` tool inside the same project.

## Documentation references

- [MCP configuration](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/mcp.html)
- [Agent Skills](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/skills.html)
- [Agents and Sub-Agents](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/agents.html)
- [Slash Commands](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/slash-commands.html)
- [`kimi` command reference](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html)

## Limitations recorded for the MVP README

- The default stdio `cwd` is inferred from runtime behaviour, not explicitly documented.
- Interactive workspace trust was bypassed with `KIMI_CODE_TRUST_WORKSPACE=1`; the real user flow remains unverified.
- The docs home page (`.../kimi-code-cli/`) returned HTTP 403 during this check.
- The first hand-written stdio server timed out; the SDK-based server is used for the final evidence.
