# Host evidence

This directory holds per-host verification evidence consumed by
`support-matrix.mjs` and `release.mjs`. Evidence files are runtime artifacts:
they are gitignored and must never be committed.

## Layout

- `<host>/<gate>.json` — CLI surface evidence (`qwen`, `kimi`, `claude`)
- `<host>/desktop/<gate>.json` — Desktop surface evidence
- `<host>/mcp-only/<gate>.json` — MCP-only surface evidence (`qwen/mcp-only`)

Gates: `install`, `public-install`, `activation`, `target`, `node-target`,
`resume` (CLI full); `safety`, `workspace` (MCP-only); `install`, `workspace`,
`target`, `resume` (extension). Only the gates listed in `requirements` count
for a surface.

## Required fields

- `host`, `surface` (`cli` | `desktop` | `mcp-only` | `extension`), `gate`
- `status`: only `passed` counts toward certification
- `clientVersion`: host client version; all gates of one surface must agree
- `sourceCommit`: 40-char commit the evidence was recorded against
- `runId`: non-empty for `target`, `node-target` and `resume` gates
- Qwen CLI specifics: `install` requires `source: "marketplace"`;
  `public-install` requires `source: "github-marketplace"`, `public: true`,
  `sha256Verified: true`, `statePreserved: true`.
- Qwen CLI `activation` is a two-session gate. It requires
  `activationMode: "new-session"`, `preset: "web"`, and all of
  `setupValidated`, `restartVerified`, `newSessionVerified`,
  `sameProjectVerified`, `configPreserved`, `continuationVerified`,
  `activeToolsVerified` set to `true`; `toolCount: 19`, `skillCount: 7`,
  `agentCount: 6`; a non-empty `pluginVersion`; and two transcript SHA256
  values. The writer derives them from the setup transcript, the fresh
  session transcript and the validated public-install evidence. A reload-only
  transcript does not satisfy this gate.
- `target` requires `afterHostRefactor: true`, `finished: true`, `pending: 0`,
  `confirmedFalse: 0`, native foreground agents, a single explorer,
  `mainRestrictedTools: 0` and a non-zero independent red assertion count.
  `resume` requires the same strict fields. `node-target` additionally requires
  `activeToolsVerified: true`, `preset: "node"` and `toolCount: 16` from the
  init of the same project root.

## Privacy

Evidence must never contain API tokens, session cookies, credentials or full
transcripts. Record counts, statuses, versions and run identifiers only.
