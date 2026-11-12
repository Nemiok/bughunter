import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { isValidScroll, scrollDeltas } from '../browser/point.ts';
import { loadConfig } from '../config.ts';
import { loadActiveProfile, resolveTestDataFile } from '../profile/load.ts';
import type { Profile } from '../profile/types.ts';
import { findProjectRoot } from '../project.ts';
import { readCandidate, readRun, readSharedMemory, recordCandidateTest } from '../run-store.ts';
import type { SharedMemoryEntry } from '../run-store.ts';
import type { Candidate, Config, Journal, Step } from '../types.ts';

const defaultStateDir = resolve(import.meta.dirname, '../../state');
const jsonString = '"(?:\\\\.|[^"\\\\])*"';

function allowedUrl(path: string, config: Config): string {
  let target: URL;
  try {
    target = new URL(path, config.baseUrl);
  } catch {
    throw new Error(`ROUTE_NOT_ALLOWED: ${path}`);
  }
  // Граница та же, что у рантайм-навигации (SessionManager.isAllowed): разрешённый origin.
  // config.routes — область исследования, а не allowlist переходов, иначе легально
  // записанный журнал оказывался бы неэкспортируемым.
  const allowed = ['http:', 'https:'].includes(target.protocol)
    && !target.username
    && !target.password
    && config.allowedOrigins.some((origin) => {
      try {
        const allowedOrigin = new URL(origin);
        return !allowedOrigin.username && !allowedOrigin.password && allowedOrigin.origin === target.origin;
      } catch {
        return false;
      }
    });
  if (!allowed) throw new Error(`ROUTE_NOT_ALLOWED: ${path}`);
  return target.href;
}

function semanticLocator(source: string): string {
  const patterns = [
    {
      regex: new RegExp(`^page\\.getByTestId\\((${jsonString})\\)(?:\\.nth\\((\\d+)\\))?$`),
      format: (match: RegExpMatchArray) => `page.getByTestId(${JSON.stringify(JSON.parse(match[1]!) as string)})`,
    },
    {
      regex: new RegExp(`^page\\.getByText\\((${jsonString}), \\{ exact: true \\}\\)(?:\\.nth\\((\\d+)\\))?$`),
      format: (match: RegExpMatchArray) => `page.getByText(${JSON.stringify(JSON.parse(match[1]!) as string)}, { exact: true })`,
    },
    {
      regex: new RegExp(`^page\\.locator\\((${jsonString})\\)(?:\\.nth\\((\\d+)\\))?$`),
      format: (match: RegExpMatchArray) => `page.locator(${JSON.stringify(JSON.parse(match[1]!) as string)})`,
    },
    {
      regex: new RegExp(`^page\\.getByRole\\((${jsonString}), \\{ name: (${jsonString}), exact: true \\}\\)(?:\\.nth\\((\\d+)\\))?$`),
      format: (match: RegExpMatchArray) => `page.getByRole(${JSON.stringify(JSON.parse(match[1]!) as string)}, { name: ${JSON.stringify(JSON.parse(match[2]!) as string)}, exact: true })`,
    },
  ];
  for (const { regex, format } of patterns) {
    const match = source.match(regex);
    if (!match) continue;
    const expression = format(match);
    const index = match[match.length - 1];
    return index === undefined ? expression : `${expression}.nth(${Number(index)})`;
  }
  throw new Error(`STEP_LOCATOR_INVALID: ${source}`);
}

function actionSource(step: Step, profile: Profile | null): string {
  if (step.action === undefined) throw new Error(`STEP_ACTION_INVALID: ${step.id}`);
  const element = (): string => {
    if (step.locator === undefined) throw new Error(`STEP_ACTION_INVALID: ${step.id}`);
    return semanticLocator(step.locator);
  };
  switch (step.action) {
    case 'click':
    case 'dblclick':
    case 'check':
    case 'hover':
      return `await ${element()}.${step.action}();`;
    case 'fill':
    case 'press':
      if (step.value === undefined) throw new Error(`STEP_VALUE_REQUIRED: ${step.id}`);
      return `await ${element()}.${step.action}(${JSON.stringify(step.value)});`;
    case 'select':
      if (step.value === undefined) throw new Error(`STEP_VALUE_REQUIRED: ${step.id}`);
      return `await ${element()}.selectOption(${JSON.stringify(step.value)});`;
    case 'drag':
      if (step.to?.locator === undefined) throw new Error(`STEP_ACTION_INVALID: ${step.id}`);
      return `await ${element()}.dragTo(${semanticLocator(step.to.locator)});`;
    case 'scroll': {
      if (!isValidScroll(step.scroll)) throw new Error(`STEP_ACTION_INVALID: ${step.id}`);
      const { dx, dy } = scrollDeltas(step.scroll);
      // Без элемента скроллится страница, с элементом — конкретный контейнер (виртуальные списки BI).
      return step.locator === undefined
        ? `await page.mouse.wheel(${dx}, ${dy});`
        : `await ${element()}.evaluate((element) => element.scrollBy(${dx}, ${dy}));`;
    }
    case 'clickAt':
    case 'hoverAt': {
      if (step.at === undefined) throw new Error(`STEP_ACTION_INVALID: ${step.id}`);
      const method = step.action === 'clickAt' ? 'click' : 'move';
      return `await page.mouse.${method}(${step.at.x}, ${step.at.y});`;
    }
    case 'upload':
      if (step.file === undefined) throw new Error(`STEP_ACTION_INVALID: ${step.id}`);
      return `await ${element()}.setInputFiles(${JSON.stringify(resolveTestDataFile(profile, step.file))});`;
  }
}

function replaySource(candidate: Candidate, config: Config, profile: Profile | null): string {
  const steps = (candidate as Candidate & { minimalSteps?: Step[] }).minimalSteps ?? candidate.steps;
  return steps.map((step) => {
    if (step.kind === 'act') return `  ${actionSource(step, profile)}\n`;
    if (step.kind === 'navigate') {
      if (!step.path) throw new Error(`STEP_PATH_REQUIRED: ${step.id}`);
      return `  await page.goto(new URL(${JSON.stringify(step.path)}, ${JSON.stringify(config.baseUrl)}).href, { waitUntil: 'domcontentloaded' });\n`;
    }
    switch (step.probe) {
      case 'reload':
        return "  await page.reload({ waitUntil: 'domcontentloaded' });\n";
      case 'back':
        return "  await page.goBack({ waitUntil: 'domcontentloaded' });\n";
      case 'mobile_viewport':
        return '  await page.setViewportSize({ width: 390, height: 844 });\n';
      default:
        throw new Error(`STEP_PROBE_INVALID: ${step.id}`);
    }
  }).join('');
}

function checkAssertion(candidate: Candidate): string {
  if (!candidate.check) throw new Error('CANDIDATE_ORACLE_REQUIRED');
  const check = candidate.check;
  switch (check.kind) {
    case 'visibleText':
      return `await expect(page.getByText(${JSON.stringify(check.target)}, { exact: true }).first()).toBeVisible();`;
    case 'notVisibleText':
      return `await expect(page.getByText(${JSON.stringify(check.target)}, { exact: true }).first()).not.toBeVisible();`;
    case 'elementCount': {
      const expected = check.expected ?? 0;
      if (typeof expected !== 'number' || !Number.isFinite(expected) || !Number.isInteger(expected) || expected < 0) {
        throw new Error(`ELEMENT_COUNT_EXPECTED_INVALID: ${JSON.stringify(expected)}`);
      }
      return `await expect(page.locator(${JSON.stringify(check.target)})).toHaveCount(${JSON.stringify(expected)});`;
    }
  }
}

function signalSource(candidate: Candidate, config: Config, initialRoute: string, replay: string): string {
  const signature = JSON.stringify(candidate.signature);
  return `import { createHash } from 'node:crypto';
import { test, expect } from '@playwright/test';

test(${JSON.stringify(candidate.title)}, async ({ page }) => {
  let matched = false;
  const normalize = (value: string): string => value
    .replace(/([?&][^=\\s&]+)=([^&\\s]*)/g, '$1=<value>')
    .replace(/\\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\b/gi, '<uuid>')
    .replace(/\\d+(?:\\.\\d+)?/g, '<number>')
    .replace(/\\s+/g, ' ')
    .trim();
  const signature = (input: { kind: string; message: string; route: string; stack?: string }): string => {
    const topFrame = input.stack?.split('\\n').find((line) => /^\\s*at\\s+/.test(line)) ?? '';
    return createHash('sha256').update([input.kind, normalize(input.message), normalize(input.route), normalize(topFrame)].join('\\n')).digest('hex');
  };
  const route = (): string => {
    try {
      return new URL(page.url()).pathname;
    } catch {
      return page.url();
    }
  };
  page.on('pageerror', (error) => {
    if (signature({ kind: 'pageerror', message: error.message, route: route(), ...(error.stack === undefined ? {} : { stack: error.stack }) }) === ${signature}) matched = true;
  });
  page.on('console', (message) => {
    if (message.type() === 'error' && signature({ kind: 'console', message: message.text(), route: route() }) === ${signature}) matched = true;
  });
  page.on('requestfailed', (request) => {
    const url = request.url();
    const reason = request.failure()?.errorText ?? 'Request failed';
    if (signature({ kind: 'requestfailed', message: \`\${request.method()} \${url}: \${reason}\`, route: route() }) === ${signature}) matched = true;
  });
  page.on('response', (response) => {
    const status = response.status();
    const url = response.url();
    if (status >= 400 && signature({ kind: 'response', message: \`\${response.request().method()} \${url}: HTTP \${status}\`, route: route() }) === ${signature}) matched = true;
  });
  const observedAnomalies: Array<{ text: string; route: string }> = [];
  await page.exposeFunction('__bughunterReportAnomalies', (entries: Array<{ text: string; route: string }>) => {
    for (const entry of entries) observedAnomalies.push(entry);
  });
  await page.addInitScript((anomalyTexts: string[]) => {
    const target = window as unknown as Window & {
      __bughunterAnomalyObserver?: MutationObserver;
      __bughunterSeenAnomalies?: Set<string>;
      __bughunterReportAnomalies: (entries: Array<{ text: string; route: string }>) => void;
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
        target.__bughunterReportAnomalies([{ text: token, route: observedRoute }]);
      }
    };
    target.__bughunterAnomalyObserver = new MutationObserver(scan);
    target.__bughunterAnomalyObserver.observe(document, { characterData: true, childList: true, subtree: true });
    scan();
  }, ${JSON.stringify(config.detectors.anomalyTexts)});
  await page.goto(new URL(${JSON.stringify(initialRoute)}, ${JSON.stringify(config.baseUrl)}).href, { waitUntil: 'domcontentloaded' });
${replay}  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
  const bodyText = await page.locator('body').innerText();
  for (const text of ${JSON.stringify(config.detectors.anomalyTexts)}) {
    const escaped = text.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
    if (text.length > 0 && new RegExp(\`(?<![\\\\p{L}\\\\p{N}_])\${escaped}(?![\\\\p{L}\\\\p{N}_])\`, 'u').test(bodyText) && signature({ kind: 'anomaly', message: text, route: route() }) === ${signature}) matched = true;
  }
  for (const entry of observedAnomalies) {
    if (signature({ kind: 'anomaly', message: entry.text, route: entry.route }) === ${signature}) matched = true;
  }
  const boundaries = page.locator(${JSON.stringify(config.detectors.errorBoundarySelector)});
  for (let index = 0; index < await boundaries.count(); index += 1) {
    const boundary = boundaries.nth(index);
    if (await boundary.isVisible()) {
      const text = (await boundary.innerText()).trim() || ${JSON.stringify(config.detectors.errorBoundarySelector)};
      if (signature({ kind: 'errorBoundary', message: text, route: route() }) === ${signature}) matched = true;
    }
  }
  expect(matched).toBe(false);
});
`;
}

export function generatePlaywrightTest(
  candidate: Candidate,
  config: Config,
  initialRoute = candidate.route,
  profile: Profile | null = null,
): string {
  allowedUrl(initialRoute, config);
  const replay = replaySource(candidate, config, profile);
  for (const step of (candidate as Candidate & { minimalSteps?: Step[] }).minimalSteps ?? candidate.steps) {
    if (step.kind === 'navigate' && step.path) allowedUrl(step.path, config);
  }
  if (candidate.signalIds.length > 0) return signalSource(candidate, config, initialRoute, replay);
  return `import { test, expect } from '@playwright/test';

test(${JSON.stringify(candidate.title)}, async ({ page }) => {
  await page.goto(new URL(${JSON.stringify(initialRoute)}, ${JSON.stringify(config.baseUrl)}).href, { waitUntil: 'domcontentloaded' });
${replay}  ${checkAssertion(candidate)}
});
`;
}

async function candidatesForRun(runId: string, stateDir: string): Promise<Candidate[]> {
  const directory = join(stateDir, 'runs', runId, 'candidates');
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return Promise.all(files.filter((file) => file.endsWith('.json')).map(async (file) =>
    JSON.parse(await readFile(join(directory, file), 'utf8')) as Candidate,
  ));
}

async function resolveExportCandidate(runId: string, bugId: string, stateDir: string): Promise<{ candidate: Candidate; known: SharedMemoryEntry }> {
  const knownBugs = await readSharedMemory('known-bugs.json', stateDir);
  let known = knownBugs.find((entry) => entry.id === bugId) ?? knownBugs.find((entry) => entry.sourceCandidate === bugId);
  if (known) {
    const candidates = await candidatesForRun(runId, stateDir);
    const matches = candidates.filter((candidate) => candidate.signature === known!.signature && candidate.runId === runId);
    const candidate = matches.find((value) => value.id === known!.sourceCandidate)
      ?? matches.sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    if (!candidate) throw new Error(`BUG_NOT_FOUND: ${bugId}`);
    return { candidate, known };
  }
  const candidate = await readCandidate(runId, bugId, stateDir);
  known = knownBugs.find((entry) => entry.signature === candidate.signature);
  if (!known) throw new Error(`BUG_NOT_CONFIRMED: ${bugId}`);
  return { candidate, known };
}

async function nearestPlaywrightProject(): Promise<string | undefined> {
  let root: string;
  try {
    root = await findProjectRoot();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('PROJECT_ROOT_NOT_FOUND:')) return undefined;
    throw error;
  }
  let directory = process.cwd();
  const filesystemRoot = parse(directory).root;
  while (true) {
    let packageJson: { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> } | undefined;
    try {
      packageJson = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as typeof packageJson;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (packageJson?.dependencies?.['@playwright/test'] !== undefined || packageJson?.devDependencies?.['@playwright/test'] !== undefined) {
      return directory;
    }
    if (directory === root || directory === filesystemRoot) return undefined;
    directory = dirname(directory);
  }
}

async function writeExport(file: string, source: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  try {
    const existing = await readFile(file, 'utf8');
    if (existing !== source) throw new Error(`EXPORT_FILE_EXISTS: ${file}`);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    await writeFile(file, source, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`EXPORT_FILE_EXISTS: ${file}`);
    throw error;
  }
}

async function journalRoute(candidate: Candidate, stateDir: string): Promise<string> {
  let journal: Journal;
  try {
    journal = JSON.parse(await readFile(join(stateDir, 'runs', candidate.runId, 'journals', `${candidate.sessionId}.json`), 'utf8')) as Journal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`JOURNAL_NOT_FOUND: ${candidate.sessionId}`);
    throw error;
  }
  if (journal.runId !== candidate.runId || journal.sessionId !== candidate.sessionId) {
    throw new Error(`JOURNAL_MISMATCH: ${candidate.sessionId}`);
  }
  return journal.route;
}

export async function exportE2e(input: { runId: string; bugId: string; stateDir?: string }): Promise<{ file: string; placedInProject: boolean }> {
  const stateDir = input.stateDir ? resolve(input.stateDir) : defaultStateDir;
  await readRun(input.runId, stateDir);
  const { candidate, known } = await resolveExportCandidate(input.runId, input.bugId, stateDir);
  if (typeof known.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(known.id) || known.id === '.' || known.id === '..') {
    throw new Error(`BUG_ID_INVALID: ${known.id}`);
  }
  if (candidate.status !== 'confirmed') throw new Error(`BUG_NOT_CONFIRMED: ${input.bugId}`);
  if (candidate.reproduction?.status !== 'reproduced') throw new Error(`CANDIDATE_UNREPRODUCED: ${candidate.id}`);
  const [config, initialRoute, profile] = await Promise.all([
    loadConfig(stateDir),
    journalRoute(candidate, stateDir),
    loadActiveProfile(stateDir),
  ]);
  const source = generatePlaywrightTest(candidate, config, initialRoute, profile);
  const project = await nearestPlaywrightProject();
  const destination = project
    ? resolve(project, config.tests.e2e.dir)
    : resolve(stateDir, 'runs', input.runId, 'e2e');
  const file = resolve(destination, `${known.id}.spec.ts`);
  const relativeFile = relative(destination, file);
  if (relativeFile === '..' || relativeFile.startsWith(`..${sep}`) || isAbsolute(relativeFile)) {
    throw new Error(`EXPORT_PATH_UNSAFE: ${file}`);
  }
  await writeExport(file, source);
  await recordCandidateTest(input.runId, candidate.id, 'e2e', file, stateDir);
  return { file, placedInProject: project !== undefined };
}
