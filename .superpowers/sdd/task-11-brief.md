### Task 11: Jest/Vitest Detection and Neighbor Examples

**Files:**
- Create: `.kimi-code/bughunter/server/src/tests/detect.ts`
- Create: `.kimi-code/bughunter/server/test/detect.bhtest.ts`
- Create: `.kimi-code/bughunter/server/fixtures/jest-project/{package.json,jest.config.js,sum.js,sum.test.js}`
- Create: `.kimi-code/bughunter/server/fixtures/vitest-project/{package.json,vite.config.ts,sum.ts,sum.test.ts}`

**Interfaces:**
- Produces `detectTests(inputPath: string, options?: { unitCommand?: string | null }): Promise<{ framework: 'jest' | 'vitest' | null; command: string | null; examples: string[] }>`.

- [ ] **Step 1: Write failing detection fixtures and tests**

Cover nearest-package precedence, Jest config variants, Vitest config variants, explicit config command priority, unknown framework returning nulls, and at most three neighboring existing test files sorted by proximity then name. Do not return the target file itself as an example.

- [ ] **Step 2: Implement detection without adding a framework dependency**

Read the nearest `package.json` upward from the input file. Detect dependency versions and local config files. Use project-local binaries via `npm exec -- <framework> ...`, never a global framework. For explicit `tests.unit.command`, preserve the configured command and append the test path in `verify-red`, not during detection. Return relative example paths from the project root.

- [ ] **Step 3: Register and verify `bh_detect_tests`**

Run fixture installs, then:
```bash
cd .kimi-code/bughunter/server
node --test test/detect.bhtest.ts
npm run typecheck
```
Expected: Jest and Vitest cases PASS with correct commands and examples.

