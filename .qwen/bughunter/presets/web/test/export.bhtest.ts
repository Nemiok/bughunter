import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { signalSignature } from '@bughunter/core';
import { exportTest, generatePlaywrightTest } from '../src/export-playwright.ts';
import { triageCandidate, writeJsonAtomic } from '@bughunter/core';
import { createRun } from '../src/runs.ts';
import type { Candidate } from '@bughunter/core';
import type { Step } from '../src/types.ts';
import type { WebConfig as Config } from '../src/config.ts';

const createdAt = '2026-11-10T00:00:00.000Z';

function config(): Config {
  return {
    baseUrl: 'https://example.test/app/',
    allowedOrigins: ['https://example.test'],
    routes: ['/', '/profile', '/orders'],
    targetMap: {},
    baseBranch: 'main',
    limits: { stepsPerSession: 60, candidatesPerRun: 20 },
    safety: { forbiddenActionText: [], readOnly: false },
    testDataPrefix: 'bh_',
    detectors: {
      ignoreConsole: [],
      ignoreRequests: [],
      anomalyTexts: ['NaN', '[object Object]'],
      errorBoundarySelector: '[data-error-boundary]',
    },
    tests: { unit: { command: null }, generated: { dir: 'e2e/bughunter' } },
  };
}

function candidate(patch: Partial<Omit<Candidate, 'steps' | 'minimalSteps'>> & { steps?: Step[]; minimalSteps?: Step[] } = {}): Candidate & { minimalSteps?: Step[] } {
  const { minimalSteps, ...candidatePatch } = patch;
  return {
    id: 'candidate-one',
    runId: 'run-one',
    sessionId: 'session-one',
    target: '/profile',
    title: 'Profile "save" fails\nsafely',
    expected: 'Profile saves',
    actual: 'Unhandled error',
    signalIds: ['signal-one'],
    signature: 'signature-one',
    steps: [],
    artifacts: [],
    status: 'confirmed',
    createdAt,
    reproduction: { status: 'reproduced', attempts: 1 },
    ...candidatePatch,
    ...(minimalSteps === undefined ? {} : { minimalSteps }),
  };
}

function expectedSignalSource(signature: string): string {
  return `import { createHash } from 'node:crypto';
import { test, expect } from '@playwright/test';

test("Profile \\"save\\" fails\\nsafely", async ({ page }) => {
  let dialogPolicy: 'accept' | 'dismiss' = 'dismiss';
  page.on('dialog', (dialog) => {
    if (signature({ kind: 'dialog', message: \`\${dialog.type()}: \${dialog.message()}\`, target: route() }) === ${JSON.stringify(signature)}) matched = true;
    if (dialogPolicy === 'accept') void dialog.accept(); else void dialog.dismiss();
  });
  let matched = false;
  const normalize = (value: string): string => value
    .replace(/([?&][^=\\s&]+)=([^&\\s]*)/g, '$1=<value>')
    .replace(/\\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\b/gi, '<uuid>')
    .replace(/\\d+(?:\\.\\d+)?/g, '<number>')
    .replace(/\\s+/g, ' ')
    .trim();
  const signature = (input: { kind: string; message: string; target: string; stack?: string }): string => {
    const topFrame = input.stack?.split('\\n').find((line) => /^\\s*at\\s+/.test(line)) ?? '';
    return createHash('sha256').update([input.kind, normalize(input.message), normalize(input.target), normalize(topFrame)].join('\\n')).digest('hex');
  };
  const route = (): string => {
    try {
      return new URL(page.url()).pathname;
    } catch {
      return page.url();
    }
  };
  page.on('pageerror', (error) => {
    if (signature({ kind: 'pageerror', message: error.message, target: route(), ...(error.stack === undefined ? {} : { stack: error.stack }) }) === ${JSON.stringify(signature)}) matched = true;
  });
  page.on('console', (message) => {
    if (message.type() === 'error' && signature({ kind: 'console', message: message.text(), target: route() }) === ${JSON.stringify(signature)}) matched = true;
  });
  page.on('requestfailed', (request) => {
    const url = request.url();
    const reason = request.failure()?.errorText ?? 'Request failed';
    if (signature({ kind: 'requestfailed', message: \`\${request.method()} \${url}: \${reason}\`, target: route() }) === ${JSON.stringify(signature)}) matched = true;
  });
  page.on('response', (response) => {
    const status = response.status();
    const url = response.url();
    if (status >= 400 && signature({ kind: 'response', message: \`\${response.request().method()} \${url}: HTTP \${status}\`, target: route() }) === ${JSON.stringify(signature)}) matched = true;
  });
  const observedAnomalies: Array<{ text: string; target: string }> = [];
  await page.exposeFunction('__bughunterReportAnomalies', (entries: Array<{ text: string; target: string }>) => {
    for (const entry of entries) observedAnomalies.push(entry);
  });
  await page.addInitScript((anomalyTexts: string[]) => {
    const target = window as unknown as Window & {
      __bughunterAnomalyObserver?: MutationObserver;
      __bughunterSeenAnomalies?: Set<string>;
      __bughunterReportAnomalies: (entries: Array<{ text: string; target: string }>) => void;
    };
    if (target.__bughunterAnomalyObserver) return;
    target.__bughunterSeenAnomalies = new Set();
    const scan = (): void => {
      if (!document.body) return;
      const text = document.body.innerText;
      for (const token of anomalyTexts) {
        if (token.length === 0) continue;
        const escaped = token.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
        if (!new RegExp(\`(?<![\\\\p{L}\\\\p{N}_])\${escaped}(?![\\\\p{L}\\\\p{N}_])\`, 'u').test(text)) continue;
        let observedRoute: string;
        try {
          observedRoute = new URL(location.href).pathname;
        } catch {
          observedRoute = location.href;
        }
        const key = \`\${token}\\n\${observedRoute}\`;
        if (target.__bughunterSeenAnomalies!.has(key)) continue;
        target.__bughunterSeenAnomalies!.add(key);
        target.__bughunterReportAnomalies([{ text: token, target: observedRoute }]);
      }
    };
    target.__bughunterAnomalyObserver = new MutationObserver(scan);
    target.__bughunterAnomalyObserver.observe(document, { characterData: true, childList: true, subtree: true });
    scan();
  }, ["NaN","[object Object]"]);
  await page.goto(new URL("/profile", "https://example.test/app/").href, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
  const bodyText = await page.locator('body').innerText();
  for (const text of ["NaN","[object Object]"]) {
    const escaped = text.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
    if (text.length > 0 && new RegExp(\`(?<![\\\\p{L}\\\\p{N}_])\${escaped}(?![\\\\p{L}\\\\p{N}_])\`, 'u').test(bodyText) && signature({ kind: 'anomaly', message: text, target: route() }) === ${JSON.stringify(signature)}) matched = true;
  }
  for (const entry of observedAnomalies) {
    if (signature({ kind: 'anomaly', message: entry.text, target: entry.target }) === ${JSON.stringify(signature)}) matched = true;
  }
  const boundaries = page.locator("[data-error-boundary]");
  for (let index = 0; index < await boundaries.count(); index += 1) {
    const boundary = boundaries.nth(index);
    if (await boundary.isVisible()) {
      const text = (await boundary.innerText()).trim() || "[data-error-boundary]";
      if (signature({ kind: 'errorBoundary', message: text, target: route() }) === ${JSON.stringify(signature)}) matched = true;
    }
  }
  expect(matched).toBe(false);
});
`;
}

const signalCases = [
  { name: 'pageerror signature', input: { kind: 'pageerror', message: 'Profile is empty 42', target: '/profile', stack: 'Error: Profile is empty 42\n    at save (app.ts:10:1)' } },
  { name: 'failed request', input: { kind: 'requestfailed', message: 'GET https://example.test/api/profile: net::ERR_FAILED', target: '/profile' } },
  { name: 'response status', input: { kind: 'response', message: 'POST https://example.test/api/orders: HTTP 500', target: '/orders' } },
  { name: 'anomaly text', input: { kind: 'anomaly', message: 'NaN', target: '/orders' } },
  { name: 'error boundary', input: { kind: 'errorBoundary', message: 'Something went wrong', target: '/profile' } },
];

for (const signalCase of signalCases) {
  test(`golden Playwright source detects ${signalCase.name} by its stable signature`, () => {
    const signature = signalSignature(signalCase.input);
    const source = generatePlaywrightTest(candidate({ signature, target: signalCase.input.target }), config());
    assert.equal(source, expectedSignalSource(signature).replace('new URL("/profile"', `new URL(${JSON.stringify(signalCase.input.target)}`));
    assert.equal(source.match(/^test\(/gm)?.length, 1);
    assert.equal(source.match(/\bexpect\(/g)?.length, 1);
    assert.ok(!source.includes('waitForTimeout'));
    assert.ok(!source.includes('toBeTruthy'));
  });
}

function expectedCheckSource(assertion: string, steps = ''): string {
  return `import { test, expect } from '@playwright/test';

test("Profile \\"save\\" fails\\nsafely", async ({ page }) => {
  await page.goto(new URL("/profile", "https://example.test/app/").href, { waitUntil: 'domcontentloaded' });
${steps}  ${assertion}
});
`;
}

test('golden visibleText source asserts the saved expected text', () => {
  const source = generatePlaywrightTest(candidate({
    signalIds: [],
    check: { kind: 'visibleText', target: 'Saved "Alice"', expected: 'Saved "Alice"' },
  }), config());
  assert.equal(source, expectedCheckSource('await expect.poll(async () => { const matches = page.getByText("Saved \\"Alice\\"", { exact: true }); const total = await matches.count(); for (let index = 0; index < total; index += 1) { if (await matches.nth(index).isVisible()) return true; } return false; }, { timeout: 5000 }).toBe(true);'));
});

test('golden notVisibleText source observes an absence window', () => {
  const source = generatePlaywrightTest(candidate({
    signalIds: [],
    check: { kind: 'notVisibleText', target: 'Saved Alice' },
  }), config());
  assert.equal(source, expectedCheckSource('const symptomAppeared = await (async () => { try { await expect.poll(async () => { const matches = page.getByText("Saved Alice", { exact: true }); const total = await matches.count(); for (let index = 0; index < total; index += 1) { if (await matches.nth(index).isVisible()) return true; } return false; }, { timeout: 3000 }).toBe(true); return true; } catch { return false; } })(); expect(symptomAppeared).toBe(false);'));
});

test('golden elementCount source asserts the saved count', () => {
  const source = generatePlaywrightTest(candidate({
    signalIds: [],
    check: { kind: 'elementCount', target: '[data-testid="order-row"]', expected: 2 },
  }), config());
  assert.equal(source, expectedCheckSource('await expect(page.locator("[data-testid=\\"order-row\\"]")).toHaveCount(2);'));
});

test('golden replay preserves semantic locator indexes, every action, navigation, and all probes', () => {
  const steps: Step[] = [
    { id: '1', kind: 'act', action: 'click', locator: 'page.getByTestId("save").nth(2)', timestamp: createdAt, targetRef: '/profile' },
    { id: '2', kind: 'act', action: 'fill', value: `Alice");\nthrow new Error("injected')`, locator: 'page.getByRole("textbox", { name: "Name", exact: true })', timestamp: createdAt, targetRef: '/profile' },
    { id: '3', kind: 'act', action: 'select', value: 'two', locator: 'page.getByText("Choice", { exact: true })', timestamp: createdAt, targetRef: '/profile' },
    { id: '4', kind: 'act', action: 'press', value: 'Enter', locator: 'page.locator("#name")', timestamp: createdAt, targetRef: '/profile' },
    { id: '5', kind: 'act', action: 'check', locator: 'page.getByTestId("enabled")', timestamp: createdAt, targetRef: '/profile' },
    { id: '6', kind: 'act', action: 'hover', locator: 'page.getByRole("button", { name: "More", exact: true })', timestamp: createdAt, targetRef: '/profile' },
    { id: '7', kind: 'act', action: 'dblclick', locator: 'page.getByText("Save", { exact: true })', timestamp: createdAt, targetRef: '/profile' },
    { id: '8', kind: 'navigate', path: '/orders?page=2', timestamp: createdAt, targetRef: '/orders' },
    { id: '9', kind: 'probe', probe: 'reload', timestamp: createdAt, targetRef: '/orders' },
    { id: '10', kind: 'probe', probe: 'back', timestamp: createdAt, targetRef: '/orders' },
    { id: '11', kind: 'probe', probe: 'mobile_viewport', timestamp: createdAt, targetRef: '/profile' },
  ];
  const source = generatePlaywrightTest(candidate({
    signalIds: [], steps, minimalSteps: steps,
    check: { kind: 'elementCount', target: '.row', expected: 1 },
  }), config());
  const replay = `  await page.getByTestId("save").nth(2).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Alice\\");\\nthrow new Error(\\"injected')");
  await page.getByText("Choice", { exact: true }).selectOption("two");
  await page.locator("#name").press("Enter");
  await page.getByTestId("enabled").check();
  await page.getByRole("button", { name: "More", exact: true }).hover();
  await page.getByText("Save", { exact: true }).dblclick();
  await page.goto(new URL("/orders?page=2", "https://example.test/app/").href, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.goBack({ waitUntil: 'domcontentloaded' });
  await page.setViewportSize({ width: 390, height: 844 });
`;
  assert.equal(source, expectedCheckSource('await expect(page.locator(".row")).toHaveCount(1);', replay));
  assert.ok(!source.includes('\nthrow new Error("injected");'));
});

test('generation accepts any same-origin route and rejects other origins and protocols', () => {
  const source = generatePlaywrightTest(candidate({ target: '/admin/deep' }), config());
  assert.ok(source.includes('new URL("/admin/deep", "https://example.test/app/")'));
  for (const path of ['https://evil.test/profile', 'file:///etc/passwd', 'javascript:alert(1)']) {
    assert.throws(() => generatePlaywrightTest(candidate({
      steps: [{ id: '1', kind: 'navigate', path, timestamp: createdAt, targetRef: '/profile' }],
    }), config()), /TARGET_NOT_ALLOWED/, path);
  }
});

type TriageFixture = {
  stateDir: string;
  runId: string;
  candidate: Candidate;
};

async function triageFixture(patch: Partial<Omit<Candidate, 'steps' | 'minimalSteps'>> & { steps?: Step[]; minimalSteps?: Step[] } = {}): Promise<TriageFixture> {
  const stateDir = await mkdtemp(join(tmpdir(), 'bh-triage-'));
  const projectRoot = join(stateDir, 'project');
  const run = await createRun('full', undefined, { config: config(), projectRoot, stateDir });
  const value = candidate({ id: 'candidate-one', runId: run.id, status: 'unprocessed', ...patch });
  await writeJsonAtomic(join(stateDir, 'runs', run.id, 'candidates', `${value.id}.json`), value);
  await writeJsonAtomic(join(stateDir, 'known-bugs.json'), []);
  await writeJsonAtomic(join(stateDir, 'suppressions.json'), []);
  return { stateDir, runId: run.id, candidate: value };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

test('confirmed triage atomically creates and updates stable shared known-bug memory', async (t) => {
  const fixture = await triageFixture();
  t.after(() => rm(fixture.stateDir, { recursive: true, force: true }));
  const confirmed = await triageCandidate({
    runId: fixture.runId, candidateId: fixture.candidate.id, verdict: 'confirmed', reason: 'Reproduced locally', stateDir: fixture.stateDir,
  });
  assert.equal(confirmed.status, 'confirmed');
  assert.deepEqual(confirmed.review, { status: 'confirmed', reason: 'Reproduced locally' });
  const knownPath = join(fixture.stateDir, 'known-bugs.json');
  const known = await readJson(knownPath) as Array<Record<string, unknown>>;
  assert.equal(known.length, 1);
  assert.equal(known[0]?.id, fixture.candidate.id);
  assert.equal(known[0]?.sourceCandidate, fixture.candidate.id);
  assert.equal(known[0]?.signature, fixture.candidate.signature);
  assert.equal(known[0]?.title, fixture.candidate.title);
  assert.equal(known[0]?.target, fixture.candidate.target);
  assert.equal(known[0]?.reason, 'Reproduced locally');
  assert.equal(typeof known[0]?.createdAt, 'string');
  assert.equal(typeof known[0]?.updatedAt, 'string');
  assert.equal((await readJson(join(fixture.stateDir, 'runs', fixture.runId, 'candidates', `${fixture.candidate.id}.json`)) as Candidate).status, 'confirmed');
  await triageCandidate({
    runId: fixture.runId, candidateId: fixture.candidate.id, verdict: 'confirmed', reason: 'Reviewed again', stateDir: fixture.stateDir,
  });
  const updated = await readJson(knownPath) as Array<Record<string, unknown>>;
  assert.equal(updated.length, 1);
  assert.equal(updated[0]?.id, known[0]?.id);
  assert.equal(updated[0]?.createdAt, known[0]?.createdAt);
  assert.equal(updated[0]?.reason, 'Reviewed again');
  assert.deepEqual((await readdir(fixture.stateDir)).filter((file) => file.endsWith('.tmp')), []);
});

test('rejected triage updates only the candidate unless suppression is explicitly requested', async (t) => {
  const first = await triageFixture();
  t.after(() => rm(first.stateDir, { recursive: true, force: true }));
  const rejected = await triageCandidate({
    runId: first.runId, candidateId: first.candidate.id, verdict: 'rejected', reason: 'Third-party script', stateDir: first.stateDir,
  });
  assert.equal(rejected.status, 'rejected');
  assert.deepEqual(await readJson(join(first.stateDir, 'suppressions.json')), []);

  const second = await triageFixture();
  t.after(() => rm(second.stateDir, { recursive: true, force: true }));
  await triageCandidate({
    runId: second.runId, candidateId: second.candidate.id, verdict: 'rejected', reason: 'Expected 401', suppress: true, stateDir: second.stateDir,
  });
  const suppressions = await readJson(join(second.stateDir, 'suppressions.json')) as Array<Record<string, unknown>>;
  assert.equal(suppressions.length, 1);
  assert.equal(suppressions[0]?.signature, second.candidate.signature);
  assert.equal(suppressions[0]?.sourceCandidate, second.candidate.id);
  assert.equal(suppressions[0]?.reason, 'Expected 401');
});

test('duplicate triage links and retains duplicateOf without creating another known bug', async (t) => {
  const fixture = await triageFixture({ duplicateOf: 'stable-known-id' });
  t.after(() => rm(fixture.stateDir, { recursive: true, force: true }));
  await writeJsonAtomic(join(fixture.stateDir, 'known-bugs.json'), [{
    id: 'stable-known-id', signature: fixture.candidate.signature, title: 'Known', target: '/profile', reason: 'Original',
    sourceCandidate: 'original-candidate', createdAt, updatedAt: createdAt,
  }]);
  const duplicate = await triageCandidate({
    runId: fixture.runId, candidateId: fixture.candidate.id, verdict: 'duplicate', reason: 'Same signature', stateDir: fixture.stateDir,
  });
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(duplicate.duplicateOf, 'stable-known-id');
  const second = candidate({ id: 'candidate-two', runId: fixture.runId, status: 'unprocessed' });
  await writeJsonAtomic(join(fixture.stateDir, 'runs', fixture.runId, 'candidates', `${second.id}.json`), second);
  const linked = await triageCandidate({
    runId: fixture.runId, candidateId: second.id, verdict: 'duplicate', reason: 'Same known signature', stateDir: fixture.stateDir,
  });
  assert.equal(linked.duplicateOf, 'stable-known-id');
  const known = await readJson(join(fixture.stateDir, 'known-bugs.json')) as unknown[];
  assert.equal(known.length, 1);
});

test('a suppressed signature cannot subsequently become a confirmed known bug', async (t) => {
  const fixture = await triageFixture();
  t.after(() => rm(fixture.stateDir, { recursive: true, force: true }));
  await writeJsonAtomic(join(fixture.stateDir, 'suppressions.json'), [{
    id: 'suppression-one', signature: fixture.candidate.signature, sourceCandidate: 'old-candidate', reason: 'Expected', createdAt, updatedAt: createdAt,
  }]);
  await assert.rejects(triageCandidate({
    runId: fixture.runId, candidateId: fixture.candidate.id, verdict: 'confirmed', reason: 'Try to confirm', stateDir: fixture.stateDir,
  }), /SIGNATURE_SUPPRESSED/);
  assert.deepEqual(await readJson(join(fixture.stateDir, 'known-bugs.json')), []);
  assert.equal((await readJson(join(fixture.stateDir, 'runs', fixture.runId, 'candidates', `${fixture.candidate.id}.json`)) as Candidate).status, 'unprocessed');
});

async function exportFixture(options: { playwright: boolean; reproduced?: boolean }): Promise<{ stateDir: string; projectRoot: string; runId: string; candidateId: string }> {
  const stateDir = await mkdtemp(join(tmpdir(), 'bh-export-'));
  const projectRoot = join(stateDir, 'project');
  const run = await createRun('full', undefined, { config: config(), projectRoot, stateDir });
  await writeJsonAtomic(join(projectRoot, 'package.json'), {
    name: 'fixture', ...(options.playwright ? { devDependencies: { '@playwright/test': '1.56.1' } } : {}),
  });
  await writeFile(join(projectRoot, '.git'), '', { flag: 'wx' });
  await writeJsonAtomic(join(stateDir, 'config.json'), config());
  const value = candidate({
    id: 'candidate-one', runId: run.id, status: 'confirmed',
    reproduction: { status: options.reproduced === false ? 'unreproduced' : 'reproduced', attempts: 1 },
  });
  await writeJsonAtomic(join(stateDir, 'runs', run.id, 'candidates', `${value.id}.json`), value);
  await writeJsonAtomic(join(stateDir, 'runs', run.id, 'journals', `${value.sessionId}.json`), {
    sessionId: value.sessionId, runId: run.id, target: value.target, persona: 'export-test', steps: value.steps, createdAt,
  });
  await writeJsonAtomic(join(stateDir, 'known-bugs.json'), [{
    id: 'stable-bug-id', signature: value.signature, title: value.title, target: value.target, reason: 'Confirmed',
    sourceCandidate: 'original-candidate', createdAt, updatedAt: createdAt,
  }]);
  await writeJsonAtomic(join(stateDir, 'suppressions.json'), []);
  return { stateDir, projectRoot, runId: run.id, candidateId: value.id };
}

test('export accepts stable known-bug or source candidate IDs and uses the stable filename in the project', async (t) => {
  const fixture = await exportFixture({ playwright: true });
  const previousCwd = process.cwd();
  process.chdir(fixture.projectRoot);
  t.after(async () => {
    process.chdir(previousCwd);
    await rm(fixture.stateDir, { recursive: true, force: true });
  });
  const byStableId = await exportTest({ runId: fixture.runId, bugId: 'stable-bug-id', stateDir: fixture.stateDir });
  assert.deepEqual(byStableId, {
    file: join(process.cwd(), 'e2e/bughunter/stable-bug-id.spec.ts'), placedInProject: true,
  });
  assert.equal(await readFile(byStableId.file, 'utf8'), expectedSignalSource(fixture.candidateId === '' ? '' : 'signature-one'));
  const byCandidateId = await exportTest({ runId: fixture.runId, bugId: fixture.candidateId, stateDir: fixture.stateDir });
  assert.deepEqual(byCandidateId, byStableId);
  const stored = await readJson(join(fixture.stateDir, 'runs', fixture.runId, 'candidates', `${fixture.candidateId}.json`)) as Candidate;
  assert.equal(stored.tests?.e2e, byStableId.file);
});

test('export without project Playwright uses run e2e and never overwrites an unrelated file', async (t) => {
  const fixture = await exportFixture({ playwright: false });
  t.after(() => rm(fixture.stateDir, { recursive: true, force: true }));
  const exported = await exportTest({ runId: fixture.runId, bugId: fixture.candidateId, stateDir: fixture.stateDir });
  assert.deepEqual(exported, {
    file: join(fixture.stateDir, 'runs', fixture.runId, 'e2e/stable-bug-id.spec.ts'), placedInProject: false,
  });
  await writeFile(exported.file, 'unrelated test\n', 'utf8');
  await assert.rejects(exportTest({ runId: fixture.runId, bugId: 'stable-bug-id', stateDir: fixture.stateDir }), /EXPORT_FILE_EXISTS/);
  assert.equal(await readFile(exported.file, 'utf8'), 'unrelated test\n');
});

test('export rejects unreproduced candidates before creating a test', async (t) => {
  const fixture = await exportFixture({ playwright: false, reproduced: false });
  t.after(() => rm(fixture.stateDir, { recursive: true, force: true }));
  await assert.rejects(exportTest({ runId: fixture.runId, bugId: fixture.candidateId, stateDir: fixture.stateDir }), /CANDIDATE_UNREPRODUCED/);
  await assert.rejects(readdir(join(fixture.stateDir, 'runs', fixture.runId, 'e2e')), { code: 'ENOENT' });
});

test('exported source is standalone and has no application imports', () => {
  const source = generatePlaywrightTest(candidate(), config());
  assert.ok(source.startsWith("import { createHash } from 'node:crypto';\nimport { test, expect } from '@playwright/test';"));
  assert.ok(!source.includes('../src/'));
});


test('export starts at the persisted journal route before an SPA step that reaches the reported route', async (t) => {
  const fixture = await exportFixture({ playwright: false });
  t.after(() => rm(fixture.stateDir, { recursive: true, force: true }));
  const spaStep: Step = {
    id: 'spa-profile', kind: 'act', action: 'click',
    locator: 'page.getByRole("link", { name: "Profile", exact: true })', timestamp: createdAt, targetRef: '/',
  };
  const candidatePath = join(fixture.stateDir, 'runs', fixture.runId, 'candidates', `${fixture.candidateId}.json`);
  const saved = await readJson(candidatePath) as Candidate & { minimalSteps?: Step[] };
  saved.target = '/profile';
  saved.steps = [spaStep];
  saved.minimalSteps = [spaStep];
  await writeJsonAtomic(candidatePath, saved);
  await writeJsonAtomic(join(fixture.stateDir, 'runs', fixture.runId, 'journals', `${saved.sessionId}.json`), {
    sessionId: saved.sessionId, runId: fixture.runId, target: '/', persona: 'export-test', steps: [spaStep], createdAt,
  });

  const exported = await exportTest({ runId: fixture.runId, bugId: fixture.candidateId, stateDir: fixture.stateDir });
  const source = await readFile(exported.file, 'utf8');
  const initialNavigation = 'await page.goto(new URL("/", "https://example.test/app/").href';
  const spaAction = 'await page.getByRole("link", { name: "Profile", exact: true }).click();';
  assert.ok(source.includes(initialNavigation));
  assert.ok(source.includes(spaAction));
  assert.ok(source.indexOf(initialNavigation) < source.indexOf(spaAction));
  assert.ok(!source.includes('await page.goto(new URL("/profile"'));
});

test('export rejects malicious stable bug IDs without writing outside the selected destination', async (t) => {
  const absoluteId = join(await mkdtemp(join(tmpdir(), 'bh-export-absolute-')), 'escape');
  t.after(() => rm(dirname(absoluteId), { recursive: true, force: true }));
  for (const maliciousId of ['../escape', absoluteId]) {
    const fixture = await exportFixture({ playwright: true });
    const previousCwd = process.cwd();
    process.chdir(fixture.projectRoot);
    try {
      const knownPath = join(fixture.stateDir, 'known-bugs.json');
      const known = await readJson(knownPath) as Array<Record<string, unknown>>;
      known[0]!.id = maliciousId;
      await writeJsonAtomic(knownPath, known);
      await assert.rejects(
        exportTest({ runId: fixture.runId, bugId: maliciousId, stateDir: fixture.stateDir }),
        /BUG_ID_INVALID|EXPORT_PATH_UNSAFE/,
      );
      const escapedFile = maliciousId === '../escape'
        ? resolve(fixture.projectRoot, 'e2e/bughunter', `${maliciousId}.spec.ts`)
        : `${maliciousId}.spec.ts`;
      await assert.rejects(readFile(escapedFile), { code: 'ENOENT' });
    } finally {
      process.chdir(previousCwd);
      await rm(fixture.stateDir, { recursive: true, force: true });
    }
  }
});

test('elementCount rejects non-finite, string, negative, and fractional expected values', () => {
  for (const expected of [Number.NaN, Number.POSITIVE_INFINITY, '2', -1, 1.5]) {
    assert.throws(() => generatePlaywrightTest(candidate({
      signalIds: [], check: { kind: 'elementCount', target: '.row', expected },
    }), config()), /ELEMENT_COUNT_EXPECTED_INVALID/);
  }
});
