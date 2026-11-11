# Task 12: One-File Red/Green/Broken Verdicts

## Status

Implemented `verifyRed` and the `bh_verify_red` MCP tool. Jest and Vitest are executed through the command returned by the unchanged `detectTests` contract, with one absolute target file and a JSON report in a temporary directory. Verdicts are based on the selected file's report, not on process exit status alone.

No commits were created. No dependencies were added. The intentionally failing fixtures remain unchanged.

## RED / GREEN evidence

### RED

After creating all 12 fixtures and `test/verify-red.bhtest.ts`, and before creating production code:

```text
$ node --test test/verify-red.bhtest.ts
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../src/tests/verify-red.ts'
tests 1
pass 0
fail 1
```

This is the required failure caused by the absent implementation.

### GREEN and integration

- First implementation run executed both real frameworks: 16/17 tests passed. The sole failure was a test diagnostic regex that did not include Jest's actual zero-test wording, `Your test suite must contain at least one test`; the returned status was already `broken`. The assertion was corrected to accept that diagnostic, without weakening the status assertion.
- `node --test test/verify-red.bhtest.ts`: **17/17 passed** after the diagnostic assertion correction.
- The first combined detector run showed the two existing fixture expectations still required `examples: []`. They were updated to the three sorted neighboring examples now present; `src/tests/detect.ts` was not changed.
- `node --test test/detect.bhtest.ts test/verify-red.bhtest.ts`: **45/45 passed**.
- `npm test`: **124/124 passed**, including a real MCP stdio invocation of `bh_verify_red` and its strict schema checks.
- `npm run typecheck`: **passed** after all changes (TypeScript `tsc`, exit 0).

## Six-status real-framework matrix

Every row ran the installed project-local Jest 30 / Vitest 3 fixture binary through `verifyRed`. Tests assert the exact status, a useful framework diagnostic, and `message.length <= 1500`.

| Framework | Fixture | Required | Actual | Diagnostic evidence |
|---|---|---:|---:|---|
| Jest | `red.test.js` | red | red | `expect(received).toBe(expected)`, `Expected: 2`, `Received: 1` |
| Jest | `green.test.js` | green | green | `green assertion: all 1 test(s) passed` |
| Jest | `broken.test.js` | broken | broken | `setup exploded` |
| Jest | `syntax.test.js` | broken | broken | `Jest encountered an unexpected token`, `SyntaxError`, `Unexpected token` |
| Jest | `import.test.js` | broken | broken | `Cannot find module './missing-module'` |
| Jest | `timeout.test.js` | broken | broken | `Test run timed out` |
| Vitest | `red.test.ts` | red | red | `AssertionError: expected 1 to be 2` |
| Vitest | `green.test.ts` | green | green | `green assertion: all 1 test(s) passed` |
| Vitest | `broken.test.ts` | broken | broken | `Error: setup exploded` |
| Vitest | `syntax.test.ts` | broken | broken | `Transform failed`, `Unexpected end of file` |
| Vitest | `import.test.ts` | broken | broken | `Cannot find module './missing-module.ts'` |
| Vitest | `timeout.test.ts` | broken | broken | `Test run timed out` |

Focused-run timings for both timeout cases were approximately 305 ms with the internal `timeoutMs: 300`; neither waited for a runner-level assertion timeout.

## Classification evidence

- Jest uses `--runTestsByPath <absolute-file> --runInBand --json --outputFile=<temp>`.
- Vitest uses `<absolute-file> --reporter=json --outputFile=<temp>` with the detected `vitest run` command.
- A report is accepted only when it contains exactly one suite and that suite's resolved path is the selected file.
- Green requires a successful report, a passed selected suite, at least one test, and every reported test passed.
- Jest red requires failed tests with `failureDetails[].matcherResult.pass === false`; thrown errors have no matcher result and become broken.
- Vitest red requires failed tests whose report diagnostics are assertion failures (`AssertionError`); ordinary thrown `Error` diagnostics become broken.
- Empty files/zero discovered tests, syntax/import failures, missing or malformed reports, runner/reporter failures, non-assertion test-body errors, incomplete/non-passed results, and timeouts return broken.
- A dedicated nonzero-exit-without-report test returns broken, proving red is not inferred from exit status.
- Explicit `unitCommand` precedence is tested with a direct project-local Jest binary. The configured command is combined with exactly one target and the mandatory reporter arguments.

## Timeout, process, message, and cleanup evidence

- Production default is the literal `120000` ms in `src/tests/verify-red.ts`; only the optional internal `options.timeoutMs` overrides it. The MCP input exposes only `testFile`.
- On POSIX, the runner starts detached and timeout sends `SIGKILL` to its negative process-group ID, terminating the complete tree. Windows uses `taskkill /T /F`.
- The timeout test's configured command spawns a grandchild Node process, records its PID, and hangs. After `verifyRed` returns broken, the test polls that PID and confirms `ESRCH` within two seconds. This passed in focused and full runs.
- Final `pgrep -fl 'spawn-child.cjs|fixtures/jest-project|fixtures/vitest-project|bh-verify-red-'` returned no processes.
- Every verdict passes through one message formatter that strips NUL characters and truncates to at most 1500 characters. All 12 matrix tests assert this cap and useful diagnostics.
- JSON is read in `finally`, including timeout/error paths; the temporary report directory is recursively removed there. The fixture audit found no leftover `empty.test.js` or helper files.

## MCP verification

`bh_verify_red` is registered next to `bh_detect_tests` in `src/index.ts`. It loads `config.tests.unit.command` and calls `verifyRed(testFile, { unitCommand })` without passing a timeout. The real MCP integration test verifies:

- tool discovery and Russian description;
- strict schema with required input exactly `testFile`;
- a real call on `fixtures/jest-project/green.test.js` returning `status: green`.

## Files changed

Created:

- `.kimi-code/bughunter/server/src/tests/verify-red.ts`
- `.kimi-code/bughunter/server/test/verify-red.bhtest.ts`
- `.kimi-code/bughunter/server/fixtures/jest-project/red.test.js`
- `.kimi-code/bughunter/server/fixtures/jest-project/green.test.js`
- `.kimi-code/bughunter/server/fixtures/jest-project/broken.test.js`
- `.kimi-code/bughunter/server/fixtures/jest-project/syntax.test.js`
- `.kimi-code/bughunter/server/fixtures/jest-project/import.test.js`
- `.kimi-code/bughunter/server/fixtures/jest-project/timeout.test.js`
- `.kimi-code/bughunter/server/fixtures/vitest-project/red.test.ts`
- `.kimi-code/bughunter/server/fixtures/vitest-project/green.test.ts`
- `.kimi-code/bughunter/server/fixtures/vitest-project/broken.test.ts`
- `.kimi-code/bughunter/server/fixtures/vitest-project/syntax.test.ts`
- `.kimi-code/bughunter/server/fixtures/vitest-project/import.test.ts`
- `.kimi-code/bughunter/server/fixtures/vitest-project/timeout.test.ts`

Modified:

- `.kimi-code/bughunter/server/src/index.ts` — dynamic import and `bh_verify_red` registration.
- `.kimi-code/bughunter/server/test/detect.bhtest.ts` — existing expected neighboring examples updated for the new fixtures; detector contract and production behavior unchanged.
- `.kimi-code/bughunter/server/test/core-integration.bhtest.ts` — tool/schema registration expectations, updated detector fixture examples, and real `bh_verify_red` green call.

## Self-review

- Contract signature and verdict union match the brief.
- Production timeout is exactly 120000 ms; fast timeout is internal only.
- Both framework commands select one file and produce JSON reports.
- Selected-file and nonzero-test requirements guard green.
- Assertion-specific report fields guard red; nonzero exit alone never produces red.
- All specified broken categories are handled conservatively.
- Full child-tree timeout, stdout/stderr capture, report reading, temporary cleanup, and message truncation are implemented.
- `detectTests` production code and return shape were preserved.
- No server dependency, commit, agent, or unrelated production edit was introduced.
- Intentional red/broken/syntax/import/timeout fixtures were not fixed or removed.

## Concerns

No known functional failures remain. Verification was performed on macOS; the Windows `taskkill` branch is implemented but was not exercised on this host. The full suite emitted pre-existing informational Babel/Vite output, but all 124 tests passed.

## Review follow-up: clean-exit green and hook failures

### Changes

- Green now additionally requires `execution.code === 0` and `execution.signal === null` in `src/tests/verify-red.ts`.
- Red remains report-driven and does not require exit 0: ordinary assertion failures with a valid report still return red even though test runners normally exit nonzero.
- Added a real-Jest regression helper through `unitCommand`: it invokes `node_modules/jest/bin/jest.js` with the verifier's exact reporter/target arguments, waits for Jest to write the passing report, then exits 7.
- Added real `beforeEach` and `afterEach` failure fixtures for both frameworks. Existing test-body exception fixtures remain and still assert broken.
- Added four files: `fixtures/jest-project/setup-hook.test.js`, `fixtures/jest-project/teardown-hook.test.js`, `fixtures/vitest-project/setup-hook.test.ts`, and `fixtures/vitest-project/teardown-hook.test.ts`; expanded `test/verify-red.bhtest.ts` accordingly.

### Exact RED evidence

Before adding the clean-exit predicates:

```text
$ node --test test/verify-red.bhtest.ts
✔ jest one-file verdict matrix (8 subtests, including setup-hook and teardown-hook)
✔ vitest one-file verdict matrix (8 subtests, including setup-hook and teardown-hook)
✖ passing report followed by nonzero exit is broken
  AssertionError [ERR_ASSERTION]: green assertion: all 1 test(s) passed
  'green' !== 'broken'
tests 22
pass 21
fail 1
```

This demonstrates that the helper produced a real passing Jest report and that the old classifier incorrectly ignored its subsequent exit 7.

### Exact GREEN evidence

After adding only the exit/signal requirements to the green predicate:

```text
$ node --test test/verify-red.bhtest.ts
✔ passing report followed by nonzero exit is broken (205.961875ms)
✔ jest one-file verdict matrix (8 subtests)
✔ vitest one-file verdict matrix (8 subtests)
tests 22
pass 22
fail 0
```

Final broader verification:

- `npm test`: **129/129 passed**, including the new real-reporter regression and all 16 matrix cases.
- `npm run typecheck`: **passed**, exit 0.
- Final process audit for verifier helpers/framework commands returned no leftover processes.

### Expanded real-framework matrix

| Framework | Fixture | Actual | Useful reporter/process diagnostic asserted |
|---|---|---:|---|
| Jest | `red.test.js` | red | `Expected: 2`, `Received: 1` |
| Jest | `green.test.js` | green | `green assertion: all 1 test(s) passed` |
| Jest | `broken.test.js` | broken | `setup exploded` |
| Jest | `setup-hook.test.js` | broken | `setup hook exploded` from real `beforeEach` |
| Jest | `teardown-hook.test.js` | broken | `teardown hook exploded` from real `afterEach` |
| Jest | `syntax.test.js` | broken | `Unexpected token` |
| Jest | `import.test.js` | broken | `Cannot find module './missing-module'` |
| Jest | `timeout.test.js` | broken | `Test run timed out` |
| Vitest | `red.test.ts` | red | `AssertionError: expected 1 to be 2` |
| Vitest | `green.test.ts` | green | `green assertion: all 1 test(s) passed` |
| Vitest | `broken.test.ts` | broken | `setup exploded` |
| Vitest | `setup-hook.test.ts` | broken | `setup hook exploded` from real `beforeEach` |
| Vitest | `teardown-hook.test.ts` | broken | `teardown hook exploded` from real `afterEach` |
| Vitest | `syntax.test.ts` | broken | `Unexpected end of file` |
| Vitest | `import.test.ts` | broken | `Cannot find module './missing-module.ts'` |
| Vitest | `timeout.test.ts` | broken | `Test run timed out` |

Separate exit regression: real passing Jest report + explicit exit 7 = **broken** after the fix. All matrix cases continue to assert messages no longer than 1500 characters.

No commits, dependencies, agents, or unrelated edits were introduced. The only remaining platform concern is unchanged: Windows `taskkill` behavior was not exercised on this macOS host.
