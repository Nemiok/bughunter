### Task 10: Prove Every Exported E2E Is Red Then Green in a Fixed Copy

**Files:**
- Create: `.kimi-code/bughunter/server/test/e2e-export.bhtest.ts`
- Create: `.kimi-code/bughunter/server/fixtures/buggy-app/playwright.config.ts`

**Interfaces:**
- Consumes: real candidates, minimal journals, and exporter from Tasks 3, 8, and 9.
- Produces: one verified red exported test per seeded bug and one green run per independently fixed copy.

- [ ] **Step 1: Write the integration harness**

For each bug, create a fresh temporary copy of the fixture, copy `node_modules` only with filesystem links or run `npm ci` in the copy, start its Vite server on an ephemeral port, export the test into that copy, and run:
```bash
npx playwright test <generated-file> --reporter=line --workers=1
```
Expected on the original bug: nonzero exit with the generated symptom assertion failing, not a syntax/import error.

- [ ] **Step 2: Apply each minimal fix only in the disposable copy**

Patch the copied source deterministically: guard empty profile name, reject zero quantity in the UI before API, disable Create while pending, supply a numeric empty-total fallback, and initialize/retain page 2 without console error. Re-run the corresponding single exported test. Expected: exit zero.

- [ ] **Step 3: Verify the original fixture remains buggy**

Run all five exported tests against the original fixture. Expected: five failing symptom assertions. Check `git diff` and assert original fixture source hashes equal their pre-test values; only run state may change.

- [ ] **Step 4: Stage 2 report**

Run the complete server `npm test` and typecheck. Report reproduction ratios, minimized step counts, and red/green evidence per bug. Any export that is `broken` blocks completion of this stage.

