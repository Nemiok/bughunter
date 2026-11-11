import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';
import type { ViteDevServer } from '../fixtures/buggy-app/node_modules/vite/dist/node/index.d.ts';
import { SessionManager } from '../src/browser/session.ts';
import type { CandidateInput } from '../src/browser/session.ts';
import { exportE2e, generatePlaywrightTest } from '../src/export/playwright.ts';
import { reproduceCandidate } from '../src/reproduce.ts';
import { createRun, triageCandidate, writeJsonAtomic } from '../src/run-store.ts';
import type { Candidate, Config, Step } from '../src/types.ts';

const fixtureRoot = resolve(import.meta.dirname, '../fixtures/buggy-app');
const repositoryRoot = resolve(import.meta.dirname, '../../../..');
const originalFiles = [
  'index.html',
  'package.json',
  'package-lock.json',
  'playwright.config.ts',
  'src/App.tsx',
  'src/main.tsx',
  'src/styles.css',
  'vite.config.ts',
];

type CommandResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  timedOut: boolean;
};

type BugEvidence = {
  id: number;
  port: number;
  source: string;
  reproduced: string;
  minimalSteps: number;
  redAssertion: string;
};

const redAssertions = [
  'expect(matched).toBe(false);',
  'expect(matched).toBe(false);',
  'expect(page.getByText("Order 4: 10", { exact: true }).first()).not.toBeVisible();',
  'expect(matched).toBe(false);',
  'expect(matched).toBe(false);',
];

const profileSave = 'click:page.getByTestId("profile-save")';
const quantityFill = 'fill:page.getByTestId("order-quantity")';
const createClick = 'click:page.getByTestId("order-create")';
const createDoubleClick = 'dblclick:page.getByTestId("order-create")';
const ordersClick = 'click:page.getByRole("link", { name: "Orders", exact: true })';
const mobileProbe = 'probe:mobile_viewport';
const reloadProbe = 'probe:reload';
const expectedOriginalSteps = [
  [mobileProbe, profileSave],
  [mobileProbe, quantityFill, createClick],
  [mobileProbe, createDoubleClick, ordersClick],
  [mobileProbe],
  [mobileProbe, reloadProbe],
];
const expectedMinimalSteps = [
  [profileSave],
  [quantityFill, createClick],
  [createDoubleClick, ordersClick],
  [],
  [],
];

function journalSteps(steps: Step[]): string[] {
  return steps.map((step) => {
    if (step.kind === 'act') return `${step.action ?? 'missing'}:${step.locator ?? 'missing'}`;
    if (step.kind === 'probe') return `probe:${step.probe ?? 'missing'}`;
    return `navigate:${step.path ?? 'missing'}`;
  });
}

function demoConfig(baseUrl: string): Config {
  return {
    baseUrl,
    allowedOrigins: [baseUrl],
    routes: ['/', '/profile', '/orders', '/orders/new', '/clean'],
    routeMap: {},
    baseBranch: 'main',
    limits: { stepsPerSession: 60, candidatesPerRun: 20 },
    safety: { forbiddenActionText: ['delete'], readOnly: false },
    testDataPrefix: 'bh_',
    detectors: {
      ignoreConsole: [],
      ignoreRequests: [],
      anomalyTexts: ['undefined', 'NaN', '[object Object]', 'Invalid Date'],
      errorBoundarySelector: '[data-error-boundary]',
    },
    tests: { unit: { command: null }, e2e: { dir: 'e2e/bughunter' } },
  };
}

async function hashes(): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(originalFiles.map(async (file) => [
    file,
    createHash('sha256').update(await readFile(join(fixtureRoot, file))).digest('hex'),
  ])));
}

async function availablePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    probe.once('error', rejectListen);
    probe.listen(0, '127.0.0.1', resolveListen);
  });
  const address = probe.address();
  assert.ok(address && typeof address === 'object');
  await new Promise<void>((resolveClose, rejectClose) => {
    probe.close((error) => error ? rejectClose(error) : resolveClose());
  });
  return address.port;
}

async function startVite(root: string, cacheDir: string, port: number, delayOrders = false, configurationFile?: string): Promise<{ server: ViteDevServer; baseUrl: string }> {
  const canonicalRoot = await realpath(root);
  const configFile = configurationFile ? await realpath(configurationFile) : join(canonicalRoot, 'vite.config.ts');
  const { createServer } = await import('../fixtures/buggy-app/node_modules/vite/dist/node/index.js');
  const server = await createServer({
    root: canonicalRoot,
    configFile,
    cacheDir,
    server: { host: '127.0.0.1', port, strictPort: true },
  });
  if (delayOrders) {
    const middlewares = server.middlewares as unknown as {
      stack: Array<{ route: string; handle: (request: { url?: string }, response: unknown, next: () => void) => void }>;
    };
    middlewares.stack.unshift({
      route: '',
      handle: (request, _response, next) => {
        if (request.url?.startsWith('/api/orders')) setTimeout(next, 250);
        else next();
      },
    });
  }
  await server.listen();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

async function copyFixture(destination: string): Promise<void> {
  const excluded = new Set(['node_modules', 'test-results', 'playwright-report']);
  await cp(fixtureRoot, destination, {
    recursive: true,
    filter: (source) => {
      const path = relative(fixtureRoot, source);
      return path === '' || !excluded.has(path.split(sep)[0]!);
    },
  });
  await mkdir(join(destination, '.git'));
  await symlink(join(fixtureRoot, 'node_modules'), join(destination, 'node_modules'), 'dir');
}

async function installOrderResetHook(projectRoot: string): Promise<void> {
  const file = join(projectRoot, 'vite.config.ts');
  const source = await readFile(file, 'utf8');
  const marker = '    configureServer(server) {\n';
  assert.ok(source.includes(marker));
  const hook = `      server.middlewares.use('/orders/new', (req, _res, next) => {
        if (req.method === 'GET') {
          orders.splice(0, orders.length, { id: 1, amount: 10 }, { id: 2, amount: 15 });
        }
        next();
      });
`;
  await writeFile(file, source.replace(marker, marker + hook), 'utf8');
}

async function act(
  manager: SessionManager,
  sessionId: string,
  testId: string,
  action: 'click' | 'dblclick' | 'fill',
  value?: string,
) {
  const state = await manager.state(sessionId);
  const element = state.elements.find((candidate) =>
    candidate.locator.kind === 'testid' && candidate.locator.value === testId,
  );
  assert.ok(element, `Missing ${testId}`);
  const result = await manager.act(sessionId, {
    elementId: element.id,
    action,
    ...(value === undefined ? {} : { value }),
  });
  assert.equal(result.ok, true, result.error);
  return result;
}

async function clickOrders(manager: SessionManager, sessionId: string): Promise<void> {
  const state = await manager.state(sessionId);
  const element = state.elements.find((candidate) =>
    candidate.locator.kind === 'role' && candidate.locator.role === 'link' && candidate.locator.name === 'Orders',
  );
  assert.ok(element, 'Missing Orders link');
  const result = await manager.act(sessionId, { elementId: element.id, action: 'click' });
  assert.equal(result.ok, true, result.error);
}

function signalCandidate(input: CandidateInput, signals: Array<{ id: string; kind: string }>, kind: string): CandidateInput {
  const signal = signals.find((candidate) => candidate.kind === kind);
  assert.ok(signal, `Missing ${kind} signal`);
  return { ...input, signalIds: [signal.id] };
}

async function exploreBug(id: number, manager: SessionManager, sessionId: string): Promise<CandidateInput> {
  const initial = await manager.probe(sessionId, 'mobile_viewport');
  switch (id) {
    case 1: {
      const clicked = await act(manager, sessionId, 'profile-save', 'click');
      return signalCandidate({
        title: 'Empty profile throws', expected: 'Validation without an exception', actual: 'Unhandled error', signalIds: [],
      }, clicked.signals, 'pageerror');
    }
    case 2: {
      await act(manager, sessionId, 'order-quantity', 'fill', '0');
      const clicked = await act(manager, sessionId, 'order-create', 'click');
      return signalCandidate({
        title: 'Zero quantity reaches the API', expected: 'UI validation before API', actual: 'HTTP 500', signalIds: [],
      }, clicked.signals, 'response');
    }
    case 3: {
      await act(manager, sessionId, 'order-create', 'dblclick');
      await clickOrders(manager, sessionId);
      await manager.state(sessionId);
      return {
        title: 'Double click creates a duplicate order',
        expected: 'Only Order 3 is created',
        actual: 'Duplicate Order 4 is visible',
        signalIds: [],
        check: { kind: 'notVisibleText', target: 'Order 4: 10' },
      };
    }
    case 4: {
      return signalCandidate({
        title: 'Empty orders total is NaN', expected: 'Numeric empty-total fallback', actual: 'NaN', signalIds: [],
      }, initial.signals, 'anomaly');
    }
    case 5: {
      const reloaded = await manager.probe(sessionId, 'reload');
      return signalCandidate({
        title: 'Page two reload resets the filter', expected: 'Page 2 retained without console error', actual: 'Console error', signalIds: [],
      }, reloaded.signals, 'console');
    }
    default:
      throw new Error(`Unknown bug ${id}`);
  }
}

function runCommand(command: string, args: string[], cwd: string, environment: NodeJS.ProcessEnv = {}): Promise<CommandResult> {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, 90_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectCommand(error);
    });
    child.once('exit', (exitCode, signal) => {
      clearTimeout(timer);
      resolveCommand({ exitCode, signal, output, timedOut });
    });
  });
}

async function runPlaywright(projectRoot: string, files: string[], baseUrl: string, slowMo = 0): Promise<CommandResult> {
  return runCommand('npx', [
    'playwright',
    'test',
    ...files.map((file) => relative(projectRoot, file)),
    '--reporter=line',
    '--workers=1',
  ], projectRoot, {
    BUGHUNTER_BASE_URL: baseUrl,
    BUGHUNTER_PLAYWRIGHT_OUTPUT: join(projectRoot, '.playwright-output'),
    BUGHUNTER_SLOW_MO: String(slowMo),
    FORCE_COLOR: undefined,
    NO_COLOR: undefined,
  });
}

function assertNotBroken(result: CommandResult): void {
  assert.equal(result.timedOut, false, `BROKEN_EXPORT: command timed out\n${result.output}`);
  assert.equal(result.signal, null, `BROKEN_EXPORT: command terminated by ${result.signal}\n${result.output}`);
  assert.doesNotMatch(result.output, /SyntaxError|Cannot find package|ERR_MODULE_NOT_FOUND|Test timeout of \d+ms exceeded/);
}

function assertRed(result: CommandResult, assertion: string, failed: number): void {
  assertNotBroken(result);
  assert.equal(result.exitCode, 1, `Expected a red symptom assertion\n${result.output}`);
  assert.ok(result.output.includes(`${failed} failed`), result.output);
  assert.ok(result.output.includes(assertion), `Missing symptom assertion ${assertion}\n${result.output}`);
}

function assertGreen(result: CommandResult): void {
  assertNotBroken(result);
  assert.equal(result.exitCode, 0, `Expected a green fixed copy\n${result.output}`);
  assert.ok(result.output.includes('1 passed'), result.output);
}

async function applyMinimalFix(id: number, projectRoot: string): Promise<void> {
  const file = join(projectRoot, 'src/App.tsx');
  let source = await readFile(file, 'utf8');
  const replace = (before: string, after: string) => {
    assert.ok(source.includes(before), `Fix ${id} did not find its exact source patch`);
    source = source.replace(before, after);
  };
  switch (id) {
    case 1:
      replace("    if (name === '') {\n      throw new Error('Profile name is required');\n    }", "    if (name === '') return;");
      break;
    case 2:
      replace(
        '  async function createOrder() {\n    const response = await fetch',
        "  async function createOrder() {\n    if (Number(quantity) === 0) {\n      setResponseStatus(400);\n      return;\n    }\n    const response = await fetch",
      );
      break;
    case 3:
      replace(
        "  const [responseStatus, setResponseStatus] = useState<number>();",
        "  const [responseStatus, setResponseStatus] = useState<number>();\n  const [pending, setPending] = useState(false);",
      );
      replace(
        '  async function createOrder() {\n    const response = await fetch',
        '  async function createOrder() {\n    if (pending) return;\n    setPending(true);\n    const response = await fetch',
      );
      replace(
        '    setResponseStatus(response.status);\n  }',
        '    setResponseStatus(response.status);\n    setPending(false);\n  }',
      );
      replace(
        '<button type="button" data-testid="order-create" onClick={createOrder}>',
        '<button type="button" data-testid="order-create" onClick={createOrder} disabled={pending}>',
      );
      break;
    case 4:
      replace('Number(orders[0]?.amount)', 'Number(orders[0]?.amount ?? 0)');
      break;
    case 5:
      replace(
        "  const [orders, setOrders] = useState<Order[]>([]);\n  const [page] = useState(1);\n  const [loadError, setLoadError] = useState('');\n  const requestedPage = Number(new URLSearchParams(window.location.search).get('page') ?? '1');\n\n  useEffect(() => {\n    if (requestedPage !== 1) {\n      console.error('Orders page filter reset');\n    }\n  }, [requestedPage]);",
        "  const [orders, setOrders] = useState<Order[]>([]);\n  const requestedPage = Number(new URLSearchParams(window.location.search).get('page') ?? '1');\n  const [page] = useState(requestedPage);\n  const [loadError, setLoadError] = useState('');",
      );
      break;
    default:
      throw new Error(`Unknown bug ${id}`);
  }
  await writeFile(file, source, 'utf8');
}

async function proveBug(id: number, suiteRoot: string): Promise<BugEvidence> {
  const projectRoot = join(suiteRoot, `bug-${id}`);
  const stateDir = join(suiteRoot, `state-${id}`);
  const cacheDir = join(suiteRoot, `vite-cache-${id}`);
  const port = await availablePort();
  await copyFixture(projectRoot);
  if (id === 3) await installOrderResetHook(projectRoot);
  let vite = await startVite(projectRoot, cacheDir, port, id === 4);
  let manager: SessionManager | undefined;
  try {
    const config = demoConfig(vite.baseUrl);
    const run = await createRun('full', undefined, { config, projectRoot, stateDir });
    await writeJsonAtomic(join(stateDir, 'config.json'), config);
    manager = new SessionManager(config, stateDir);
    const route = id === 1 ? '/profile' : id === 2 || id === 3 ? '/orders/new' : id === 5 ? '/orders?page=2' : '/orders';
    const { sessionId } = await manager.open(run.id, route, 'e2e-export-integration');
    const input = await exploreBug(id, manager, sessionId);
    const { candidateId } = await manager.reportCandidate(sessionId, input);
    await manager.close(sessionId);
    const reproduction = await reproduceCandidate({ runId: run.id, candidateId, attempts: 3, stateDir });
    assert.equal(reproduction.reproduced, '3/3');
    const candidatePath = join(stateDir, 'runs', run.id, 'candidates', `${candidateId}.json`);
    const candidate = JSON.parse(await readFile(candidatePath, 'utf8')) as Candidate & { minimalSteps?: Step[] };
    assert.equal(candidate.minimalSteps?.length, reproduction.minimalSteps);
    assert.equal(reproduction.steps, expectedOriginalSteps[id - 1]!.length);
    assert.deepEqual(journalSteps(candidate.steps), expectedOriginalSteps[id - 1]);
    assert.ok(candidate.minimalSteps);
    assert.deepEqual(journalSteps(candidate.minimalSteps), expectedMinimalSteps[id - 1]);
    const minimalSteps = candidate.minimalSteps.length;
    await triageCandidate({ runId: run.id, candidateId, verdict: 'confirmed', reason: 'Reproduced 3/3 in real Chrome', stateDir });
    const previousCwd = process.cwd();
    let exported: Awaited<ReturnType<typeof exportE2e>>;
    try {
      process.chdir(projectRoot);
      exported = await exportE2e({ runId: run.id, bugId: candidateId, stateDir });
    } finally {
      process.chdir(previousCwd);
    }
    assert.equal(exported.placedInProject, true);
    const source = await readFile(exported.file, 'utf8');
    assert.equal(source, generatePlaywrightTest(candidate, config, route));
    const red = await runPlaywright(projectRoot, [exported.file], vite.baseUrl, id === 2 ? 100 : 0);
    const redAssertion = redAssertions[id - 1]!;
    assertRed(red, redAssertion, 1);
    await applyMinimalFix(id, projectRoot);
    if (id === 3) {
      await vite.server.close();
      vite = await startVite(projectRoot, cacheDir, port);
    }
    const green = await runPlaywright(projectRoot, [exported.file], vite.baseUrl, id === 2 ? 100 : 0);
    assertGreen(green);
    console.log(JSON.stringify({
      bug: id,
      reproduced: reproduction.reproduced,
      originalSteps: reproduction.steps,
      minimalSteps,
      redExit: red.exitCode,
      redAssertion,
      greenExit: green.exitCode,
      exportedFile: relative(projectRoot, exported.file),
    }));
    return { id, port, source, reproduced: reproduction.reproduced, minimalSteps, redAssertion };
  } finally {
    try {
      await manager?.closeAll();
    } finally {
      await vite.server.close();
    }
  }
}

test('every exported seeded-bug E2E is red on the symptom and green after its minimal fix', { timeout: 600_000 }, async (t) => {
  await readFile(join(fixtureRoot, 'playwright.config.ts'), 'utf8');
  const before = await hashes();
  const suiteRoot = await realpath(await mkdtemp(join(tmpdir(), 'bh-e2e-export-')));
  t.after(() => rm(suiteRoot, { recursive: true, force: true }));
  const evidence: BugEvidence[] = [];
  for (let id = 1; id <= 5; id += 1) {
    await t.test(`bug ${id}`, async () => {
      evidence.push(await proveBug(id, suiteRoot));
    });
  }

  await t.test('all five exports remain red against the original fixture', async () => {
    const runnerRoot = join(suiteRoot, 'original-runner');
    await mkdir(join(runnerRoot, 'e2e/bughunter'), { recursive: true });
    await cp(join(fixtureRoot, 'playwright.config.ts'), join(runnerRoot, 'playwright.config.ts'));
    await cp(join(fixtureRoot, 'vite.config.ts'), join(runnerRoot, 'vite.config.ts'));
    await installOrderResetHook(runnerRoot);
    await symlink(join(fixtureRoot, 'node_modules'), join(runnerRoot, 'node_modules'), 'dir');
    let originalRed = 0;
    for (const bug of evidence) {
      const file = join(runnerRoot, 'e2e/bughunter', `bug-${bug.id}.spec.ts`);
      await writeFile(file, bug.source, 'utf8');
      const vite = await startVite(
        fixtureRoot,
        join(suiteRoot, `original-vite-cache-${bug.id}`),
        bug.port,
        bug.id === 4,
        bug.id === 3 ? join(runnerRoot, 'vite.config.ts') : undefined,
      );
      try {
        const red = await runPlaywright(runnerRoot, [file], vite.baseUrl, 100);
        assertRed(red, bug.redAssertion, 1);
        originalRed += 1;
      } finally {
        await vite.server.close();
      }
    }
    assert.equal(originalRed, 5);
    console.log(JSON.stringify({ originalFixtureRed: originalRed }));
  });

  assert.deepEqual(await hashes(), before);
  const diff = await runCommand('git', ['diff', '--', relative(repositoryRoot, fixtureRoot)], repositoryRoot);
  assert.equal(diff.exitCode, 0, diff.output);
  assert.equal(diff.output, '');
  console.log(JSON.stringify({ originalFixtureHashes: before }));
});
