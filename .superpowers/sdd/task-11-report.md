# Task 11: Jest/Vitest Detection and Neighbor Examples

## Status

Implemented `detectTests`, registered `bh_detect_tests`, added both minimal framework fixtures with independently retained lockfiles, and covered the detection contract with fixture-backed and real MCP stdio tests. `verifyRed` was deliberately not implemented; it remains Task 12 scope. No commits or server dependency changes were made.

Environment used for verification: Node.js 24.14.0, npm 11.9.0.

## TDD RED evidence

Baseline before Task 11 changes:

- `npm test`: 79 passed, 0 failed.

Initial contract tests were written before production code:

- `node --test test/detect.bhtest.ts`: failed with `ERR_MODULE_NOT_FOUND` for `src/tests/detect.ts`, as expected.
- `node --test --test-name-pattern='real MCP stdio' test/core-integration.bhtest.ts`: failed because the registered tool list did not contain `bh_detect_tests`, as expected.

During self-review, a separate test-first cycle covered Jest configuration embedded in `package.json`:

- `node --test --test-name-pattern='package.json Jest config' test/detect.bhtest.ts`: failed with actual framework `null`, expected `jest`.

## GREEN evidence

- `node --test test/detect.bhtest.ts`: 28 passed, 0 failed.
- `node --test --test-name-pattern='real MCP stdio' test/core-integration.bhtest.ts`: 1 passed, 0 failed. This exercised `bh_detect_tests` through an actual MCP stdio client and verified its strict `path`-only input schema and result.
- `npm test`: 107 passed, 0 failed, 0 skipped.
- `npm run typecheck`: passed (`tsc`, no output/errors).
- Jest fixture smoke run, `npm exec -- jest sum.test.js --runInBand`: 1 suite and 1 test passed.
- Vitest fixture smoke run, `npm exec -- vitest run sum.test.ts`: 1 file and 1 test passed.

## Fixture dependencies

Dependencies were installed separately with `npm install` in each fixture directory. Server `package.json` and `package-lock.json` were not changed.

| Fixture | Declared range | Lockfile-resolved version | Lockfile |
| --- | --- | --- | --- |
| Jest | `jest: ^30.2.0` | 30.5.2 | `server/fixtures/jest-project/package-lock.json` |
| Vitest | `vitest: ^3.2.4` | 3.2.7 | `server/fixtures/vitest-project/package-lock.json` |

Both lockfiles use lockfile version 3. Generated `node_modules` directories remain covered by the existing `.kimi-code/bughunter/.gitignore` rule.

## Detection matrix

| Case | Expected and verified behavior |
| --- | --- |
| Jest fixture dependency | `framework: jest`, `command: npm exec -- jest` |
| Vitest fixture dependency | `framework: vitest`, `command: npm exec -- vitest run` |
| Nearest package precedence | A nested Vitest package/config wins over an outer Jest package/config |
| Unknown nearest package | Does not inherit the outer Jest framework; returns `framework: null`, `command: null`, `examples: []` |
| Jest config files | Supports `jest.config.js`, `.cjs`, `.mjs`, `.ts`, `.cts`, `.mts`, and `.json`, including without a declared Jest dependency |
| Jest package config | Supports the `jest` property in the nearest `package.json` |
| Vitest config files | Supports `vitest.config.*` and `vite.config.*` with `.js`, `.cjs`, `.mjs`, `.ts`, `.cts`, and `.mts`, including without a declared Vitest dependency |
| Dependency locations | Recognizes Jest/Vitest in `dependencies`, `devDependencies`, `optionalDependencies`, and `peerDependencies` |
| Explicit unit command | `unitCommand` is returned verbatim and has priority over framework defaults; the target path is not appended |
| Neighbor examples | Existing `.test.*`/`.spec.*` JS/TS variants only; target excluded; `node_modules` and `.git` excluded; sorted by directory proximity then relative name; capped at three; paths relative to nearest package root |
| MCP registration | `bh_detect_tests` accepts only required `path`, loads `tests.unit.command`, and returns the detection result |

## Files changed

Created:

- `.kimi-code/bughunter/server/src/tests/detect.ts`
- `.kimi-code/bughunter/server/test/detect.bhtest.ts`
- `.kimi-code/bughunter/server/fixtures/jest-project/package.json`
- `.kimi-code/bughunter/server/fixtures/jest-project/package-lock.json`
- `.kimi-code/bughunter/server/fixtures/jest-project/jest.config.js`
- `.kimi-code/bughunter/server/fixtures/jest-project/sum.js`
- `.kimi-code/bughunter/server/fixtures/jest-project/sum.test.js`
- `.kimi-code/bughunter/server/fixtures/vitest-project/package.json`
- `.kimi-code/bughunter/server/fixtures/vitest-project/package-lock.json`
- `.kimi-code/bughunter/server/fixtures/vitest-project/vite.config.ts`
- `.kimi-code/bughunter/server/fixtures/vitest-project/sum.ts`
- `.kimi-code/bughunter/server/fixtures/vitest-project/sum.test.ts`

Modified:

- `.kimi-code/bughunter/server/src/index.ts` — registers `bh_detect_tests` and passes the configured unit command.
- `.kimi-code/bughunter/server/test/core-integration.bhtest.ts` — verifies tool discovery, strict schema, and a real detection call.

Report:

- `.superpowers/sdd/task-11-report.md`

## Self-review

- Detection starts at the input file's directory, stops at the nearest `package.json`, and does not accidentally inherit a framework from an outer package.
- Config lookup walks from the input directory toward that package root, preserving nearest-config behavior.
- Default commands use `npm exec --` and therefore the project-local binary contract; no global Jest/Vitest invocation was introduced.
- Explicit commands remain unchanged for Task 12 to append exactly one test file.
- Neighbor traversal uses existing regular files, excludes the target and dependency/VCS directories, and returns portable project-relative paths.
- The MCP tool keeps the specified public input (`path` only); internal configuration supplies `unitCommand`.
- No `verifyRed`, test execution/classification, new server dependency, commit, agent, or unrelated source edit was introduced.
- All test and fixture processes completed; no background task was left running.

## Concerns / follow-up

- Fixture-only `npm install` reported dependency-tree advisories: Jest 19 (1 low, 18 moderate, plus a deprecated `glob@10.5.0` warning); Vitest 3 (1 moderate, 2 critical). No `npm audit fix` was run because it would cause unrequested fixture/lockfile upgrades. The server dependency tree was unchanged.
- The full suite still prints the pre-existing non-fatal `Port 5173 is in use, trying another one...` message and Babel deoptimization notices; all 107 tests pass.
- Task 12 still needs to implement `verifyRed` and append the single test path when executing the preserved command.
