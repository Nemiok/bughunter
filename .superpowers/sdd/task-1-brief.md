### Task 1: Verify Kimi Code CLI Compatibility

**Files:**
- Create: `.kimi-code/bughunter/README.md`
- Create: `.kimi-code/bughunter/server/fixtures/cli-probe/README.md`

**Interfaces:**
- Consumes: installed `kimi` 2.5.2 and official documentation.
- Produces: four recorded facts: stdio working directory, `/bughunter` alias behavior, project-agent discovery, and project-skill access from a subagent.

- [ ] **Step 1: Read product documentation before creating configuration**

Invoke the built-in `check-kimi-code-docs` skill with the four compatibility questions from the source specification. Fetch `https://www.kimi.com/code/docs/en/kimi-code-cli/` and the specific MCP, skills, and agents pages linked by the documentation. Record document URLs and whether each statement is explicit or only inferred.

- [ ] **Step 2: Inspect the installed command surface**

Run:
```bash
kimi --version
kimi --help
```
Expected: version `2.5.2`; help lists the actual noninteractive and session options used by the following manual probes. Do not invent unsupported CLI flags.

- [ ] **Step 3: Run isolated CLI probes**

Create the probe directory inside the workspace and initialize it only when execution reaches this task:
```bash
mkdir -p .kimi-code/bughunter/server/fixtures/cli-probe
cd .kimi-code/bughunter/server/fixtures/cli-probe
git init
```
Add the smallest MCP stdio probe, project skill, and agent permitted by the installed CLI documentation. The MCP probe returns `process.cwd()`; the skill returns a fixed token; the agent must invoke that skill and return the token. Launch `kimi` from the probe root, trust the folder interactively, and record actual results in the probe README.

- [ ] **Step 4: Record the compatibility verdict**

Write one `Сверка с Kimi Code CLI` section in `.kimi-code/bughunter/README.md` with four rows: `checked`, actual result, evidence, required adjustment. If `/bughunter` is unavailable, document `/skill:bughunter` rather than claiming the alias works. If MCP cwd is not the project root, specify the documented `cwd` field in the planned `mcp.json` fragment.

- [ ] **Step 5: Stage report**

Report installed version, documentation URLs, manual probe results, and every discrepancy. Do not proceed with an undocumented assumption about cwd or agent discovery.

