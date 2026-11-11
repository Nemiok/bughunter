### Task 12: One-File Red/Green/Broken Verdicts

**Files:**
- Create: `.kimi-code/bughunter/server/src/tests/verify-red.ts`
- Create: `.kimi-code/bughunter/server/test/verify-red.bhtest.ts`
- Create: `.kimi-code/bughunter/server/fixtures/jest-project/{red,green,broken,syntax,import,timeout}.test.js`
- Create: `.kimi-code/bughunter/server/fixtures/vitest-project/{red,green,broken,syntax,import,timeout}.test.ts`
- Modify: `.kimi-code/bughunter/server/src/index.ts`

**Interfaces:**
- Consumes: `detectTests`.
- Produces `verifyRed(testFile: string, options?: { timeoutMs?: number; unitCommand?: string | null }): Promise<{ status: 'red' | 'green' | 'broken'; message: string }>`.
- The MCP input remains only `testFile`; the optional timeout supports fast deterministic tests, while production defaults to 120000 ms.

- [ ] **Step 1: Create failing fixture tests and classifier tests**

Each framework gets equivalent cases:
```js
test('red assertion', () => { expect(1).toBe(2); });
test('green assertion', () => { expect(1).toBe(1); });
test('broken outside assertion', () => { throw new Error('setup exploded'); });
```
Also create a syntax error, a missing import, and a test that never completes. Assert statuses `red`, `green`, `broken`, `broken`, `broken`, `broken` respectively. Assert every message is at most 1500 characters and contains the useful framework diagnostic.

- [ ] **Step 2: Verify the classifier tests fail**

Run `node --test test/verify-red.bhtest.ts`. Expected: FAIL because `verify-red.ts` is absent.

- [ ] **Step 3: Implement reporter-based classification**

For Jest run the project-local binary with the single file, `--runInBand --json --outputFile=<temp>`. For Vitest run `vitest run <file> --reporter=json --outputFile=<temp>`. Capture stdout/stderr and always read the report in `finally`. Classify `green` only when the selected file ran and all assertions passed; `red` only when at least one assertion failed normally; suite parse errors, missing imports, zero discovered tests, reporter failure, and setup/teardown exceptions are `broken`.

Use a 120000 ms default timeout and terminate the complete child process tree on expiry. Timeout is always `broken`. Never infer `red` merely from a nonzero process exit. Resolve the explicit unit command before framework defaults and still require a single target file.

- [ ] **Step 4: Register and run Stage 3 verification**

Run:
```bash
cd .kimi-code/bughunter/server
node --test test/detect.bhtest.ts test/verify-red.bhtest.ts
npm run typecheck
```
Expected: both Jest and Vitest matrices PASS. Report exact statuses and timeout behavior.

