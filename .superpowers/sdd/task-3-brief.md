### Task 3: Seeded Vite/React Demo Application

**Files:**
- Create: `.kimi-code/bughunter/server/fixtures/buggy-app/package.json`
- Create: `.kimi-code/bughunter/server/fixtures/buggy-app/{index.html,vite.config.ts,tsconfig.json}`
- Create: `.kimi-code/bughunter/server/fixtures/buggy-app/src/{main.tsx,App.tsx,styles.css}`
- Create: `.kimi-code/bughunter/server/fixtures/buggy-app/src/{orders,profile}.test.ts`
- Create: `.kimi-code/bughunter/server/fixtures/buggy-app/e2e/.gitkeep`

**Interfaces:**
- Produces routes `/`, `/profile`, `/orders`, `/orders/new`, `/orders?page=2`, and `/clean`.
- Produces stable `data-testid` values `profile-name`, `profile-save`, `order-quantity`, `order-create`, `order-row`, `orders-total`, and `orders-page-two`.
- Mock API: `POST /api/orders` returns 500 for quantity `0`; otherwise appends one order per request.

- [ ] **Step 1: Add ordinary sample unit tests and show them red before the fixture exists**

The sample tests cover normal total calculation and positive order validation, not the seeded bugs:
```ts
it('sums known order amounts', () => {
  expect(calculateTotal([{ amount: 10 }, { amount: 15 }])).toBe(25);
});
```
Run `npm install && npm test` in the fixture. Expected initial FAIL because implementation is absent; retain the lockfile after installation.

- [ ] **Step 2: Implement the minimal fixture and all five seeded bugs**

Use React without a router dependency: read `window.location.pathname` and `URLSearchParams`, use normal links for navigation, and keep orders in the Vite middleware process. Implement exactly:
1. Empty profile name triggers an uncaught `Error('Profile name is required')` from the Save click handler.
2. Quantity zero sends the mock request and renders the 500 response without client-side prevention.
3. Create remains enabled while awaiting the request; a double click sends two requests and appends two rows.
4. `calculateTotal` incorrectly uses `Number(orders[0]?.amount)` as the initial value and reduces the remaining orders; an empty list therefore renders visible `NaN` without throwing before rendering, while non-empty totals remain correct.
5. `/orders?page=2` initializes page `1` after reload and calls `console.error('Orders page filter reset')`.
`/clean` renders and edits static local state without console, page, or network errors.

- [ ] **Step 3: Run fixture unit tests and production compile check**

Run:
```bash
cd .kimi-code/bughunter/server/fixtures/buggy-app
npm test -- --run
npx tsc --noEmit
```
Expected: ordinary unit tests PASS and TypeScript PASS. Do not write tests that codify seeded bugs as desired behavior.

- [ ] **Step 4: Start and smoke-test the real fixture**

Run `npm run dev -- --host 127.0.0.1 --port 4173` as a background task. Request all routes using `curl` and confirm the Vite HTML response. Leave the server available for browser integration; stop it when the stage is complete.

