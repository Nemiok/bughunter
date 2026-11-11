### Task 7: Minimal Explorer and Manual Hypothesis Gate

**Files:**
- Create: `.kimi-code/agents/bh-explorer.md`
- Create: `.kimi-code/mcp.json`
- Modify: `.kimi-code/bughunter/README.md`

**Interfaces:**
- Consumes: the nine core MCP tools.
- Produces: manual candidate IDs and an explicit pass/stop decision for Stage 1.

- [ ] **Step 1: Add the minimal self-contained explorer agent**

Frontmatter must contain `name: bh-explorer`, a Russian description, full MCP tool names plus `Skill`, and `subagents: []`. The body instructs one action per state, deterministic candidate requirements, the five-candidate stop, `LIMIT_REACHED`, mandatory close, and a final standalone list of candidate IDs. Do not add reproduce/triage/export tools yet.

- [ ] **Step 2: Merge MCP configuration without overwriting other servers**

The resulting fragment is:
```json
{
  "mcpServers": {
    "bughunter": {
      "command": "node",
      "args": [".kimi-code/bughunter/server/src/index.ts"],
      "startupTimeoutMs": 30000,
      "toolTimeoutMs": 600000
    }
  }
}
```
Add the documented `cwd` only if Task 1 proved it necessary. Preserve every pre-existing server entry.

- [ ] **Step 3: Perform the manual Kimi run**

Start a fresh `kimi` session from the project root, trust the folder, and invoke `bh-explorer` sequentially for each demo route with all three MVP personas. Record route, persona, candidate IDs, signal types, last successful action, and error at any stuck point. Do not substitute a scripted manager test for this model-driven gate.

- [ ] **Step 4: Apply the stop rule**

Count distinct seeded bugs with candidates. If fewer than three: stop the entire implementation, write the manual matrix and stuck points to README, and report that later tasks remain blocked. If at least three: record PASS and continue.

