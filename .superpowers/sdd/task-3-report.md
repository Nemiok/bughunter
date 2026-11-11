# Task 3 report: Seeded Vite/React Demo Application

## Status

Implemented the standalone fixture at `.kimi-code/bughunter/server/fixtures/buggy-app`. No server `src`, core tests, or CLI probe files were modified. No commits were created.

## RED evidence

Created `package.json`, `tsconfig.json`, and the two ordinary sample test files before any application implementation. The tests import `calculateTotal` and `validateOrder` from the then-absent `src/App` module.

The first two install attempts failed before testing due to npm registry read timeouts:

```bash
npm install && npm test
# ETIMEDOUT while fetching https://registry.npmjs.org/react

npm install --fetch-timeout=300000 --fetch-retries=2 && npm test
# ETIMEDOUT (network read)
```

A registry connectivity check then returned HTTP 200, and the install/test command was rerun:

```bash
npm install --fetch-timeout=300000 --fetch-retries=2 && npm test
```

Result: 102 packages installed; expected RED followed:

```text
FAIL src/orders.test.ts — Cannot find module './App'
FAIL src/profile.test.ts — Cannot find module './App'
Test Files 2 failed (2)
Tests no tests
exit 1
```

Both failures were due only to the missing implementation module. `package-lock.json` was retained.

## GREEN and compile evidence

```bash
npm test -- --run
```

Result:

```text
Test Files 2 passed (2)
Tests 2 passed (2)
exit 0
```

The passing ordinary tests are the known-amount total (`10 + 15 = 25`) and positive order validation (`2` is accepted). No tests assert that a seeded bug is correct.

```bash
npx tsc --noEmit
```

Result: exit 0 with no output.

## Real dev-server route and API smoke checks

Started:

```bash
npm run dev -- --host 127.0.0.1 --port 4173
```

Requested every required route with `curl`, checking HTTP 200 and the Vite HTML shell (`#root` and `/src/main.tsx`):

```text
/ -> HTTP 200; Vite HTML confirmed
/profile -> HTTP 200; Vite HTML confirmed
/orders -> HTTP 200; Vite HTML confirmed
/orders/new -> HTTP 200; Vite HTML confirmed
/orders?page=2 -> HTTP 200; Vite HTML confirmed
/clean -> HTTP 200; Vite HTML confirmed
```

Mock API results:

```text
POST /api/orders {"quantity":0}
-> {"error":"Quantity cannot be zero"} HTTP 500

POST /api/orders {"quantity":2} (first request)
-> {"id":3,"amount":20} HTTP 201
POST /api/orders {"quantity":2} (second request)
-> {"id":4,"amount":20} HTTP 201

GET /api/orders
-> [{"id":1,"amount":10},{"id":2,"amount":15},{"id":3,"amount":20},{"id":4,"amount":20}] HTTP 200
```

This confirms quantity zero reaches the server, and two separate requests append two separate orders. The background task was stopped after smoke testing; a follow-up request confirmed port 4173 no longer responds. No dev server was left running.

## Files created

- `.kimi-code/bughunter/server/fixtures/buggy-app/package.json`
- `.kimi-code/bughunter/server/fixtures/buggy-app/package-lock.json`
- `.kimi-code/bughunter/server/fixtures/buggy-app/index.html`
- `.kimi-code/bughunter/server/fixtures/buggy-app/vite.config.ts`
- `.kimi-code/bughunter/server/fixtures/buggy-app/tsconfig.json`
- `.kimi-code/bughunter/server/fixtures/buggy-app/src/main.tsx`
- `.kimi-code/bughunter/server/fixtures/buggy-app/src/App.tsx`
- `.kimi-code/bughunter/server/fixtures/buggy-app/src/styles.css`
- `.kimi-code/bughunter/server/fixtures/buggy-app/src/orders.test.ts`
- `.kimi-code/bughunter/server/fixtures/buggy-app/src/profile.test.ts`
- `.kimi-code/bughunter/server/fixtures/buggy-app/e2e/.gitkeep`

## Self-review against the brief

1. `/profile` has stable `profile-name` and `profile-save` test IDs. Saving an exactly empty name throws uncaught `Error('Profile name is required')` synchronously in the click handler.
2. `/orders/new` has stable `order-quantity` and `order-create` test IDs. Quantity zero is sent without client-side blocking, and the UI displays `Response status: 500`.
3. Create has no pending/disabled state. Each click independently posts; the middleware appends one order per successful request. The two-request HTTP smoke check produced IDs 3 and 4.
4. `calculateTotal` uses `Number(orders[0]?.amount)` as the reduce initial value and reduces `orders.slice(1)`. Empty input therefore produces visible `NaN` via `String(...)`; non-empty known totals pass the ordinary unit test. Orders use stable `order-row` and `orders-total` test IDs.
5. `/orders?page=2` still initializes page state to `1` and logs exactly `console.error('Orders page filter reset')`. The `orders-page-two` normal link provides navigation to that URL.
6. `/clean` renders a controlled input backed only by static local state. It has no fetch effect, console call, or intentional error.
7. Routing uses `window.location.pathname` and `URLSearchParams` with normal links; no router dependency was added. Orders live in the Vite middleware process.

Generated Vite/Vitest cache output under `node_modules/.vite` was removed after verification. Pre-existing unrelated working-tree changes were left untouched.

## Concerns

- Install-time warning only: `npm install` printed `3 vulnerabilities (1 moderate, 2 critical)`. The earlier command output contained no package identifiers, and this warning was not independently investigated. No audit was run and no vulnerability-related upgrade was applied.
- Verification was the requested unit/TypeScript and real HTTP smoke coverage, not browser automation. Browser integration remains for the later task.
- All five defects are intentional seeded fixture behavior and were not fixed.

## Review fix: Playwright dependency

Added the current compatible `@playwright/test` release to the fixture's `devDependencies` (`^1.65.0`) and regenerated only its lockfile. No browser download or installation command was run.

```bash
npm install --save-dev @playwright/test
```

Result: exit 0; `added 4 packages, and audited 107 packages in 3s`. The same install-time warning was printed: `3 vulnerabilities (1 moderate, 2 critical)`.

Ran each requested check once after the dependency change:

```bash
npm test -- --run
# Test Files 2 passed (2)
# Tests 2 passed (2)
# exit 0

npx tsc --noEmit
# exit 0; no output
```

No audit, package upgrade, browser installation, commit, or unrelated edit was performed for this review fix.
