### Task 6: Core MCP Tools and Scripted Discovery Integration

**Files:**
- Create: `.kimi-code/bughunter/server/src/index.ts`
- Create: `.kimi-code/bughunter/server/src/auth.ts`
- Create: `.kimi-code/bughunter/server/test/core-integration.bhtest.ts`
- Modify: `.kimi-code/bughunter/server/package.json`

**Interfaces:**
- Consumes: `SessionManager`, run-store, and config functions from earlier tasks.
- Produces MCP tools `bh_start_run`, `bh_resume_run`, `bh_open`, `bh_state`, `bh_act`, `bh_navigate`, `bh_probe`, `bh_report_candidate`, and `bh_close` with the exact fields in the source specification.
- Produces `runAuth(): Promise<void>`, which saves `state/auth/storage-state.json` after an explicit terminal confirmation.

- [ ] **Step 1: Write the scripted no-LLM discovery test**

Start Vite programmatically on an ephemeral port, create a temporary state config pointing at it, and use the exported core functions rather than an LLM. Script these actions:
```ts
await manager.open(run.runId, '/profile', 'scripted');
await fillByTestId('profile-name', '');
await clickByTestId('profile-save');
assert.ok(signalsOfType('pageerror').length > 0);

await manager.open(run.runId, '/orders/new', 'scripted');
await fillByTestId('order-quantity', '0');
await clickByTestId('order-create');
assert.ok(signalsOfType('response').some((s) => s.message.includes('500')));

await manager.open(run.runId, '/orders', 'scripted');
assert.ok(signalsOfType('anomalyText').some((s) => s.message.includes('NaN')));

await manager.open(run.runId, '/orders?page=2', 'scripted');
await manager.probe(sessionId, 'reload');
assert.ok(signalsOfType('console').some((s) => s.message.includes('filter reset')));

await manager.open(run.runId, '/clean', 'scripted');
assert.deepEqual(newSignals, []);
```
Keep helpers in the test file and use the public manager methods for actions; direct page access is allowed only to set deterministic fixture state where the public API intentionally hides it.

- [ ] **Step 2: Run the integration test and verify failure**

Run `node --test test/core-integration.bhtest.ts`. Expected: FAIL before MCP registration and any missing integration behavior are implemented.

- [ ] **Step 3: Register MCP tools with strict input schemas**

Use `McpServer` and `StdioServerTransport`; each `registerTool` has a short Russian description and Zod shape. Return `{ content: [{ type: 'text', text: JSON.stringify(value) }] }`. Map known errors to compact JSON with `isError: true` and codes `CONFIG_CREATED`, `CONFIG_INVALID`, `LIMIT_REACHED`, `FORBIDDEN_ORIGIN`, `FORBIDDEN_ACTION`, and `NOT_FOUND`.

At startup validate Node ≥22.18 before loading the transport. On missing dependencies print `Зависимости Bughunter не установлены. Выполните: cd .kimi-code/bughunter/server && npm ci` to stderr and exit nonzero. Do not log protocol messages to stdout.

- [ ] **Step 4: Implement manual authentication capture**

`auth.ts` loads the same validated config, launches headed Chrome with `channel: 'chrome'`, opens `baseUrl`, and uses `readline/promises` to wait for Enter only after the user has logged in:
```ts
const answer = createInterface({ input: process.stdin, output: process.stderr });
try {
  await answer.question('Войдите в открытом Chrome, затем нажмите Enter здесь…');
  await mkdir(dirname(storageStatePath), { recursive: true });
  await context.storageState({ path: storageStatePath });
} finally {
  answer.close();
  await browser.close();
}
```
Use the state path derived from `import.meta.dirname`, never cwd. The automated suite checks that this path and headed launch options are correct; actual login remains a documented manual operation and must not be simulated.

- [ ] **Step 5: Add a real stdio handshake test**

Spawn `node src/index.ts`, connect the MCP SDK stdio client, call `tools/list`, and assert the nine tool names and shortened output shapes. Close client and child process in `finally`; a two-second no-output timer is not a valid startup check.

- [ ] **Step 6: Run Stage 1 automated verification and report**

Run:
```bash
cd .kimi-code/bughunter/server
npm test
npm run typecheck
```
Expected: all current tests and stdio handshake PASS. Report discovered seeded signals, clean-page result, safety tests, auth implementation, and any Chrome limitations.

