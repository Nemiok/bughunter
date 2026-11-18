# Host evidence

This directory holds per-host verification evidence consumed by
`support-matrix.mjs` and `release.mjs`. Evidence files are runtime artifacts:
they are gitignored and must never be committed.

## Layout

- `<host>/<gate>.json` — CLI surface evidence (`qwen`, `kimi`, `claude`)
- `<host>/desktop/<gate>.json` — Desktop surface evidence
- `<host>/mcp-only/<gate>.json` — MCP-only surface evidence (`qwen/mcp-only`)

Gates: `install`, `target`, `resume` (CLI full), `safety` (MCP-only).

## Required fields

- `host`, `surface` (`cli` | `desktop` | `mcp-only`), `gate`
- `status`: only `passed` counts toward certification
- `clientVersion`: host client version; all gates of one surface must agree
- `sourceCommit`: 40-char commit the evidence was recorded against
- `runId`: non-empty for `target` and `resume` gates
- Qwen CLI specifics: `install` requires `source: "marketplace"`;
  `target` requires `afterHostRefactor: true` (a fresh run after the host
  refactor; historical run ids do not satisfy this)

## Privacy

Evidence must never contain API tokens, session cookies, credentials or full
transcripts. Record counts, statuses, versions and run identifiers only.
