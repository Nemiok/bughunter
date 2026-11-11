### Task 2: Server Scaffold, Configuration, Project Root, and Run Store

**Files:**
- Create: `.kimi-code/bughunter/.gitignore`
- Create: `.kimi-code/bughunter/server/package.json`
- Create: `.kimi-code/bughunter/server/tsconfig.json`
- Create: `.kimi-code/bughunter/server/src/types.ts`
- Create: `.kimi-code/bughunter/server/src/project.ts`
- Create: `.kimi-code/bughunter/server/src/config.ts`
- Create: `.kimi-code/bughunter/server/src/run-store.ts`
- Create: `.kimi-code/bughunter/state/{known-bugs,suppressions}.json`
- Create: `.kimi-code/bughunter/server/test/config-store.bhtest.ts`

**Interfaces:**
- Produces:
  - `loadConfig(stateDir?: string): Promise<Config>`
  - `ensureConfig(stateDir?: string): Promise<{ config?: Config; createdPath?: string }>`
  - `findProjectRoot(start = process.cwd()): Promise<string>`
  - `createRun(scope: Scope, route: string | undefined, deps: { config: Config; projectRoot: string; stateDir: string }): Promise<Run>`
  - `readRun(runId: string, stateDir?: string): Promise<Run>`
  - `updateRun(runId: string, patch: Partial<Run>, stateDir?: string): Promise<Run>`
  - `writeJsonAtomic(file: string, value: unknown): Promise<void>`
- `Config`, `Run`, `Candidate`, `Journal`, `Step`, `Signal`, and `Check` are shared erasable TypeScript types exported from `types.ts`.

- [ ] **Step 1: Write failing configuration and store tests**

Use `node:test` and `assert/strict`. Cover: missing config returns `createdPath` and a valid template; malformed JSON and invalid Zod fields include the concrete path; `diff` uses `git diff --name-only <baseBranch>...HEAD` and `routeMap`; no route-map matches falls back to all routes; `route` requires an allowed configured route; atomic writes leave valid JSON after interruption; unknown run IDs fail clearly.

The central test shape is:
```ts
test('missing config creates template without starting a run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bh-config-'));
  const result = await ensureConfig(root);
  assert.equal(result.config, undefined);
  assert.equal(result.createdPath, join(root, 'config.json'));
  const written = JSON.parse(await readFile(result.createdPath!, 'utf8'));
  assert.equal(written.limits.stepsPerSession, 60);
});
```

- [ ] **Step 2: Verify the tests fail before implementation**

Run:
```bash
cd .kimi-code/bughunter/server
npm install
node --test test/config-store.bhtest.ts
```
Expected: FAIL because the source modules do not exist. Generate the committed lockfile with this install; subsequent installs must use `npm ci`.

- [ ] **Step 3: Add the exact package and TypeScript configuration**

`package.json` must contain `"type": "module"`, `engines.node: ">=22.18"`, scripts `test: "node --test test/*.bhtest.ts"`, `typecheck: "tsc"`, and `auth: "node src/auth.ts"`. `tsconfig.json` enables `strict`, `noEmit`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `allowImportingTsExtensions`, `module: "NodeNext"`, `moduleResolution: "NodeNext"`, and types `node`.

`.gitignore` contains exactly the deliverable-local ignores:
```gitignore
server/node_modules/
server/fixtures/*/node_modules/
state/runs/
state/auth/
```

- [ ] **Step 4: Implement validation and durable state**

Use the full config shape and defaults from the source specification. Reject unknown or invalid values with `CONFIG_INVALID: <path>: <zod issue>`. Resolve default state as `resolve(import.meta.dirname, '../../state')` from `src`. Generate run IDs from UTC timestamp plus random suffix; never accept path separators in IDs. Write JSON using a same-directory temporary file, `fsync`, and `rename`.

For diff route selection execute Git with `execFile`, not shell interpolation. Match route-map globs with a small explicit matcher supporting `*`, `**`, and literal path segments; do not add a glob dependency.

- [ ] **Step 5: Verify Task 2**

Run:
```bash
cd .kimi-code/bughunter/server
npm test -- --test-name-pattern='config|run'
npm run typecheck
```
Expected: selected config/store tests PASS; typecheck PASS. `known-bugs.json` and `suppressions.json` both contain `[]`.

