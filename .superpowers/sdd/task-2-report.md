# Task 2: Server Scaffold, Configuration, Project Root, and Run Store

Status: DONE

## Implementation

Created the Node.js/TypeScript server package with direct TypeScript execution, strict no-emit typechecking, the required runtime dependencies (`@modelcontextprotocol/sdk`, `playwright-core`, `zod`), and only the required development dependencies (`typescript`, `@types/node`). `npm install` generated `package-lock.json`; `node_modules/` is excluded by the deliverable-local `.gitignore`.

Implemented the required exports:

- `loadConfig(stateDir?)` and `ensureConfig(stateDir?)` in `server/src/config.ts`.
  - The template exactly matches the source specification, including `limits.stepsPerSession: 60` and `candidatesPerRun: 20`.
  - Missing config is created atomically and returned as `{ createdPath }` without creating a run.
  - Existing valid config is returned as `{ config }`.
  - Malformed JSON, invalid fields, and unknown fields produce `CONFIG_INVALID: <concrete path>: <issue>`.
  - Default state is `resolve(import.meta.dirname, '../../state')`, independent of process cwd.
- `findProjectRoot(start?)` in `server/src/project.ts` walks ancestors until `.git` and reports `PROJECT_ROOT_NOT_FOUND` if none exists.
- `createRun`, `readRun`, `updateRun`, and `writeJsonAtomic` in `server/src/run-store.ts`.
  - Diff selection executes `git diff --name-only <baseBranch>...HEAD` via `execFile` with no shell interpolation.
  - Local glob matching supports literal segments, `*` within a path segment, and `**` across segments.
  - Diff route selection preserves configured route order, de-duplicates through that order, and falls back to all routes when nothing matches.
  - Route runs require a configured route and reject missing/disallowed routes with `ROUTE_REQUIRED` / `ROUTE_NOT_ALLOWED`.
  - Run IDs combine a UTC ISO timestamp with a random hexadecimal suffix. Read/update IDs reject path separators and traversal.
  - Unknown runs report `RUN_NOT_FOUND: <runId>`.
  - JSON writes use a same-directory exclusive temporary file, file `fsync`, close, and atomic `rename`; failed/interrupted writes cannot expose partial target JSON.
- `Config`, `Run`, `Candidate`, `Journal`, `Step`, `Signal`, `Check`, and `Scope` are erasable shared types in `server/src/types.ts`.

Created `state/known-bugs.json` and `state/suppressions.json`, each containing only `[]`. No browser, MCP, authentication, or demo behavior was added. The required `auth` script is present; its future `src/auth.ts` target is intentionally outside this task.

## TDD evidence

### RED

Command:

```bash
cd /Users/nemiok/Desktop/projects/vault/bughunter/.kimi-code/bughunter/server
npm install && node --test test/config-store.bhtest.ts
```

Relevant output:

```text
added 99 packages, and audited 100 packages in 4s
found 0 vulnerabilities
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../server/src/config.ts' imported from '.../server/test/config-store.bhtest.ts'
✖ test/config-store.bhtest.ts
ℹ tests 1
ℹ pass 0
ℹ fail 1
Command failed with exit code: 1
```

The failure was the expected missing-source failure, before any production module existed.

### GREEN

Full test command:

```bash
cd /Users/nemiok/Desktop/projects/vault/bughunter/.kimi-code/bughunter/server
npm test
```

Relevant output:

```text
✔ missing config creates template without starting a run
✔ existing valid config loads without being recreated
✔ malformed config JSON includes the concrete path
✔ invalid and unknown config fields include the concrete path and Zod issue
✔ project root is found by walking up to .git
✔ diff run uses git diff and routeMap to select routes
✔ diff run falls back to all routes when no route-map glob matches
✔ route run requires one allowed configured route
✔ run updates persist and unknown or unsafe IDs fail clearly
✔ atomic writes leave valid JSON when a writer is interrupted
ℹ tests 10
ℹ pass 10
ℹ fail 0
```

Required filtered verification:

```bash
npm test -- --test-name-pattern='config|run'
```

Result: exit 0; 10 passed, 0 failed, 0 skipped.

Typecheck:

```bash
npm run typecheck
```

Relevant output and result:

```text
> typecheck
> tsc
```

Exit 0, no diagnostics.

The interruption test starts a real child writer, terminates it with `SIGKILL`, and parses the resulting target JSON. Diff tests initialize temporary Git repositories and make real commits/branches. All test state is under `mkdtemp` directories and removed after the suite; real Bughunter state is never mutated.

## Files changed

Created under `/Users/nemiok/Desktop/projects/vault/bughunter`:

- `.kimi-code/bughunter/.gitignore`
- `.kimi-code/bughunter/server/package.json`
- `.kimi-code/bughunter/server/package-lock.json`
- `.kimi-code/bughunter/server/tsconfig.json`
- `.kimi-code/bughunter/server/src/types.ts`
- `.kimi-code/bughunter/server/src/project.ts`
- `.kimi-code/bughunter/server/src/config.ts`
- `.kimi-code/bughunter/server/src/run-store.ts`
- `.kimi-code/bughunter/server/test/config-store.bhtest.ts`
- `.kimi-code/bughunter/state/known-bugs.json`
- `.kimi-code/bughunter/state/suppressions.json`

Generated ignored directory: `.kimi-code/bughunter/server/node_modules/`.

Report written to `/Users/nemiok/Desktop/projects/vault/.superpowers/sdd/task-2-report.md`.

No Task 1 files or unrelated changes were modified. No commit, branch, or push was performed.

## Self-review

- Checked every brief-required file and export; all are present with `.ts` import extensions.
- `.gitignore` contains exactly the four required entries.
- Package scripts, module type, Node engine, and all required tsconfig flags match the brief.
- Config objects are strict at every nested level, so unknown keys are rejected rather than silently stripped.
- The default state path is module-relative in both config and run store.
- Tests cover the required missing/malformed/invalid config behavior, real Git diff routing, fallback, route validation, interruption-safe JSON, run updates, and unknown/unsafe run IDs.
- No extra runtime or development dependencies, glob package, browser/MCP implementation, or generated test output files were added.

## Concerns

None for this task's scope. Later tasks must supply `src/auth.ts` before `npm run auth` is usable.


## Review fix: zero-directory `**` glob matching

Added three focused tests to `server/test/config-store.bhtest.ts`: `src/**/index.ts` matching `src/index.ts`, `**/foo.ts` matching root-level `foo.ts`, and `src/pages/*/index.ts` matching one literal path segment. The first two demonstrate zero-directory `**` semantics; the third protects existing `*` behavior.

### Fix RED

Command:

```bash
cd /Users/nemiok/Desktop/projects/vault/bughunter/.kimi-code/bughunter/server
node --test --test-name-pattern='route glob' test/config-store.bhtest.ts
```

Relevant output:

```text
✖ route glob ** matches zero directories below a literal segment
✖ route glob ** matches zero directories at the repository root
✔ route glob * matches within a single path segment
ℹ tests 3
ℹ pass 1
ℹ fail 2
ℹ skipped 0
Command failed with exit code: 1
```

Both failing assertions returned all configured routes instead of `['/profile']`, confirming that the old `**/` regex required a directory separator and at least one directory.

### Minimal fix

Updated only `globMatches` in `server/src/run-store.ts`. It now tokenizes `**/`, `**`, and `*`; `**/` compiles to `(?:.*/)?`, allowing zero or more directories, while `*` remains `[^/]*` within one path segment. No dependencies or unrelated files changed.

### Fix GREEN

Ran the full suite once after the fix:

```bash
npm test
```

Relevant output:

```text
✔ route glob ** matches zero directories below a literal segment
✔ route glob ** matches zero directories at the repository root
✔ route glob * matches within a single path segment
ℹ tests 13
ℹ pass 13
ℹ fail 0
ℹ skipped 0
```

Ran typecheck once after the fix:

```bash
npm run typecheck
```

Result: exit 0, no diagnostics. No commits were created.
