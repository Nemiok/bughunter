import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rm } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright-core';
import { scanSignals } from '../detectors/index.ts';
import { writeJsonAtomic } from '../run-store.ts';
import type {
  Candidate,
  Check,
  Config,
  ElementSnapshot,
  Journal,
  SemanticLocator,
  Signal,
  Step,
} from '../types.ts';
import { collectElements, toPlaywrightLocator } from './elements.ts';

export type StateResult = {
  url: string;
  title: string;
  elements: ElementSnapshot[];
  signals: Signal[];
  stepsLeft: number;
};

export type ActInput = {
  elementId: string;
  action: NonNullable<Step['action']>;
  value?: string;
};

export type ActResult = {
  ok: boolean;
  error?: string;
  navigated: boolean;
  signals: Signal[];
};

export type ProbeKind = NonNullable<Step['probe']>;

export type CandidateInput = {
  title: string;
  expected: string;
  actual: string;
  signalIds: string[];
  check?: Check;
};

type Session = {
  id: string;
  runId: string;
  context: BrowserContext;
  page: Page;
  journal: Journal;
  elements: Map<string, ElementSnapshot>;
  signals: Map<string, Signal>;
  candidateIds: string[];
  mediaDir: string;
};

type SharedMemoryEntry = {
  id?: string;
  candidateId?: string;
  sourceCandidate?: string;
  signature?: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) || runId === '.' || runId === '..') {
    throw new Error(`RUN_ID_INVALID: ${runId}`);
  }
}

export function resolveSemanticLocator(page: Page, locator: SemanticLocator): Locator {
  let resolved: Locator;
  switch (locator.kind) {
    case 'testid':
      resolved = page.getByTestId(locator.value);
      break;
    case 'role':
      resolved = page.getByRole(locator.role as Parameters<Page['getByRole']>[0], { name: locator.name, exact: true });
      break;
    case 'text':
      resolved = page.getByText(locator.value, { exact: true });
      break;
    case 'css':
      resolved = page.locator(locator.value);
      break;
  }
  return locator.index === undefined ? resolved : resolved.nth(locator.index);
}

export class SessionManager {
  private browser?: Browser;
  private browserPromise?: Promise<Browser>;
  private readonly sessions = new Map<string, Session>();
  private readonly blockedNavigations = new Set<Page>();
  private readonly blockedPopups = new WeakSet<BrowserContext>();
  private readonly config: Config;
  private readonly stateDir: string;

  constructor(config: Config, stateDir: string) {
    this.config = config;
    this.stateDir = stateDir;
  }

  async open(runId: string, route: string, persona: string): Promise<{ sessionId: string }> {
    validateRunId(runId);
    const target = this.navigationUrl(route);
    const sessionId = randomUUID();
    const browser = await this.getBrowser();
    const mediaDir = join(this.stateDir, 'runs', runId, 'artifacts', `.${sessionId}-media`);
    await mkdir(mediaDir, { recursive: true });
    const storageStatePath = join(this.stateDir, 'auth', 'storage-state.json');
    let context: BrowserContext | undefined;
    try {
      let storageState: string | undefined;
      try {
        await access(storageStatePath);
        storageState = storageStatePath;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      context = await browser.newContext({
        ...(storageState === undefined ? {} : { storageState }),
        recordVideo: { dir: mediaDir },
      });
      await this.installNavigationGuard(context);
      await context.tracing.start({ screenshots: true, snapshots: true });
      const page = await context.newPage();
      const journal: Journal = {
        sessionId,
        runId,
        route,
        persona,
        steps: [],
        createdAt: new Date().toISOString(),
      };
      const session: Session = {
        id: sessionId,
        runId,
        context,
        page,
        journal,
        elements: new Map(),
        signals: new Map(),
        candidateIds: [],
        mediaDir,
      };
      this.sessions.set(sessionId, session);
      await scanSignals(page, this.config);
      await page.goto(target, { waitUntil: 'domcontentloaded' });
      await this.settle(page);
      await this.writeJournal(session);
      return { sessionId };
    } catch (error) {
      this.sessions.delete(sessionId);
      await context?.close().catch(() => undefined);
      await rm(mediaDir, { recursive: true, force: true });
      throw error;
    }
  }

  async state(sessionId: string): Promise<StateResult> {
    return this.readState(this.session(sessionId));
  }

  async act(sessionId: string, input: ActInput): Promise<ActResult> {
    const session = this.session(sessionId);
    if (this.stepsLeft(session) <= 0) {
      return { ok: false, error: 'LIMIT_REACHED', navigated: false, signals: [] };
    }
    const element = session.elements.get(input.elementId);
    if (!element) {
      return { ok: false, error: `ELEMENT_NOT_FOUND: ${input.elementId}`, navigated: false, signals: [] };
    }
    const locator = resolveSemanticLocator(session.page, element.locator);
    if (await this.isForbidden(element, locator)) {
      return { ok: false, error: 'FORBIDDEN_ACTION', navigated: false, signals: [] };
    }
    if (await this.isReadOnlySubmission(locator, input)) {
      return { ok: false, error: 'FORM_SUBMISSION_BLOCKED', navigated: false, signals: [] };
    }

    const beforeUrl = session.page.url();
    const value = input.action === 'fill' && input.value === undefined
      ? `${this.config.testDataPrefix}${randomUUID().slice(0, 8)}`
      : input.value;
    let actionError: unknown;
    try {
      await this.executeAction(locator, input.action, value);
    } catch (error) {
      actionError = error;
    }
    const navigationBlocked = this.blockedNavigations.delete(session.page);
    if (navigationBlocked) {
      await session.page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
      if (session.page.url() !== beforeUrl) {
        await session.page.goto(beforeUrl, { waitUntil: 'domcontentloaded' });
      }
      actionError ??= new Error('NAVIGATION_NOT_ALLOWED');
    }
    const popupBlocked = this.blockedPopups.delete(session.context);
    if (popupBlocked) actionError ??= new Error('FORBIDDEN_ORIGIN');
    await this.settle(session.page);
    const signals = await this.collectSignals(session);
    if (actionError !== undefined) {
      return {
        ok: false,
        error: navigationBlocked ? 'NAVIGATION_NOT_ALLOWED' : popupBlocked ? 'FORBIDDEN_ORIGIN' : `ACTION_FAILED: ${errorMessage(actionError)}`,
        navigated: beforeUrl !== session.page.url(),
        signals,
      };
    }

    await this.appendStep(session, {
      id: randomUUID(),
      kind: 'act',
      timestamp: new Date().toISOString(),
      routeTemplate: this.currentRoute(session.page),
      action: input.action,
      elementId: input.elementId,
      ...(value === undefined ? {} : { value }),
      locator: toPlaywrightLocator(element.locator),
      signalIds: signals.map((signal) => signal.id),
    });
    return { ok: true, navigated: beforeUrl !== session.page.url(), signals };
  }

  async navigate(sessionId: string, path: string): Promise<StateResult> {
    const session = this.session(sessionId);
    this.assertStepsRemain(session);
    const target = this.navigationUrl(path);
    await session.page.goto(target, { waitUntil: 'domcontentloaded' });
    const result = await this.readState(session);
    await this.appendStep(session, {
      id: randomUUID(),
      kind: 'navigate',
      timestamp: new Date().toISOString(),
      routeTemplate: this.currentRoute(session.page),
      path,
      signalIds: result.signals.map((signal) => signal.id),
    });
    result.stepsLeft = this.stepsLeft(session);
    return result;
  }

  async probe(sessionId: string, kind: ProbeKind): Promise<StateResult> {
    const session = this.session(sessionId);
    this.assertStepsRemain(session);
    switch (kind) {
      case 'reload':
        await session.page.reload({ waitUntil: 'domcontentloaded' });
        break;
      case 'back':
        await session.page.goBack({ waitUntil: 'domcontentloaded' });
        break;
      case 'mobile_viewport':
        await session.page.setViewportSize({ width: 390, height: 844 });
        break;
    }
    const result = await this.readState(session);
    await this.appendStep(session, {
      id: randomUUID(),
      kind: 'probe',
      timestamp: new Date().toISOString(),
      routeTemplate: this.currentRoute(session.page),
      probe: kind,
      signalIds: result.signals.map((signal) => signal.id),
    });
    result.stepsLeft = this.stepsLeft(session);
    return result;
  }

  async reportCandidate(sessionId: string, input: CandidateInput): Promise<{ candidateId: string; duplicateOf?: string }> {
    const session = this.session(sessionId);
    const referencedSignals = input.signalIds.map((id) => {
      const signal = session.signals.get(id);
      if (!signal) throw new Error(`SIGNAL_NOT_FOUND: ${id}`);
      return signal;
    });
    const route = this.currentRoute(session.page);
    let signature: string;
    if (referencedSignals.length > 0) {
      signature = referencedSignals[0]!.signature;
    } else if (input.check) {
      const canonical = JSON.stringify([
        input.check.kind,
        input.check.target,
        input.check.expected ?? null,
        route,
      ]);
      signature = createHash('sha256').update(canonical).digest('hex');
    } else {
      throw new Error('CANDIDATE_ORACLE_REQUIRED');
    }

    const candidateId = randomUUID();
    const duplicateOf = await this.findDuplicate(signature);
    const candidate: Candidate = {
      id: candidateId,
      runId: session.runId,
      sessionId,
      route,
      title: input.title,
      expected: input.expected,
      actual: input.actual,
      signalIds: [...input.signalIds],
      signature,
      steps: session.journal.steps.map((step) => ({ ...step, ...(step.signalIds ? { signalIds: [...step.signalIds] } : {}) })),
      artifacts: [],
      status: 'unprocessed',
      createdAt: new Date().toISOString(),
      ...(input.check === undefined ? {} : { check: input.check }),
      ...(duplicateOf === undefined ? {} : { duplicateOf }),
      reproduction: { status: 'unreproduced', attempts: 0 },
    };
    await writeJsonAtomic(this.candidatePath(session.runId, candidateId), candidate);
    session.candidateIds.push(candidateId);
    return { candidateId, ...(duplicateOf === undefined ? {} : { duplicateOf }) };
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    const artifactId = session.candidateIds[0] ?? session.id;
    const artifactDir = join(this.stateDir, 'runs', session.runId, 'artifacts', artifactId);
    const tracePath = join(artifactDir, 'trace.zip');
    const screenshotPath = join(artifactDir, 'screenshot.png');
    const videoPath = join(artifactDir, 'video.webm');
    const video = session.page.video();
    const errors: unknown[] = [];
    try {
      await mkdir(artifactDir, { recursive: true });
      try {
        await session.page.screenshot({ path: screenshotPath, fullPage: true });
      } catch (error) {
        errors.push(error);
      }
      try {
        await session.context.tracing.stop({ path: tracePath });
      } catch (error) {
        errors.push(error);
      }
    } finally {
      try {
        await session.context.close();
      } catch (error) {
        errors.push(error);
      }
    }

    try {
      if (video) await video.saveAs(videoPath);
      const artifacts = [tracePath, screenshotPath, videoPath]
        .map((path) => relative(this.stateDir, path).split(sep).join('/'));
      for (const candidateId of session.candidateIds) {
        const path = this.candidatePath(session.runId, candidateId);
        const candidate = JSON.parse(await readFile(path, 'utf8')) as Candidate;
        await writeJsonAtomic(path, { ...candidate, artifacts });
      }
    } catch (error) {
      errors.push(error);
    } finally {
      await rm(session.mediaDir, { recursive: true, force: true });
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `SESSION_CLOSE_FAILED: ${sessionId}: ${errors.map(errorMessage).join('; ')}`);
    }
  }

  async closeAll(): Promise<void> {
    const errors: unknown[] = [];
    for (const sessionId of [...this.sessions.keys()]) {
      try {
        await this.close(sessionId);
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await this.browser?.close();
    } catch (error) {
      errors.push(error);
    } finally {
      this.browser = undefined;
      this.browserPromise = undefined;
    }
    if (errors.length > 0) throw new AggregateError(errors, 'SESSION_CLOSE_ALL_FAILED');
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (!this.browserPromise) {
      this.browserPromise = chromium.launch({ channel: 'chrome', headless: true }).then((browser) => {
        this.browser = browser;
        return browser;
      });
    }
    try {
      return await this.browserPromise;
    } catch (error) {
      this.browserPromise = undefined;
      throw error;
    }
  }

  private session(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`SESSION_NOT_FOUND: ${sessionId}`);
    return session;
  }

  private navigationUrl(path: string): string {
    let target: URL;
    try {
      target = new URL(path, this.config.baseUrl);
    } catch {
      throw new Error(`NAVIGATION_NOT_ALLOWED: ${path}`);
    }
    if (!this.isAllowed(target)) throw new Error(`NAVIGATION_NOT_ALLOWED: ${path}`);
    return target.href;
  }

  private isAllowed(target: URL): boolean {
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) return false;
    return this.config.allowedOrigins.some((origin) => {
      try {
        const allowed = new URL(origin);
        return !allowed.username && !allowed.password && allowed.origin === target.origin;
      } catch {
        return false;
      }
    });
  }

  private async installNavigationGuard(context: BrowserContext): Promise<void> {
    await context.route('**/*', async (route) => {
      const request = route.request();
      let allowed = false;
      try {
        allowed = this.isAllowed(new URL(request.url()));
      } catch {
        allowed = false;
      }
      if (allowed) {
        await route.continue();
        return;
      }

      let page: Page | undefined;
      try {
        page = request.frame().page();
      } catch {
        page = undefined;
      }
      const isMainPage = [...this.sessions.values()].some((session) => session.page === page);
      if (request.isNavigationRequest() && page && isMainPage) this.blockedNavigations.add(page);
      const popupPage = request.isNavigationRequest() && !isMainPage && !page
        ? context.waitForEvent('page', { timeout: 5000 }).catch(() => undefined)
        : undefined;
      await route.abort('blockedbyclient').catch(() => undefined);
      if (request.isNavigationRequest() && !isMainPage) {
        this.blockedPopups.add(context);
        let pages = (page ? [page] : context.pages())
          .filter((candidate) => ![...this.sessions.values()].some((session) => session.page === candidate));
        if (pages.length === 0 && popupPage) {
          const popup = await popupPage;
          if (popup) pages = [popup];
        }
        await Promise.all(pages.map((candidate) => candidate.close().catch(() => undefined)));
      }
    });
    context.on('page', (page) => {
      page.on('framenavigated', (frame) => {
        if (frame !== page.mainFrame()) return;
        let allowed = frame.url() === 'about:blank';
        if (!allowed) {
          try {
            allowed = this.isAllowed(new URL(frame.url()));
          } catch {
            allowed = false;
          }
        }
        const isMainPage = [...this.sessions.values()].some((session) => session.page === page);
        if (!allowed && !isMainPage) void page.close().catch(() => undefined);
      });
    });
  }

  private async isForbidden(element: ElementSnapshot, locator: Locator): Promise<boolean> {
    const text = await locator.textContent().catch(() => '') ?? '';
    const searchable = `${element.name}\n${text}`.toLocaleLowerCase();
    return this.config.safety.forbiddenActionText.some((forbidden) =>
      forbidden.length > 0 && searchable.includes(forbidden.toLocaleLowerCase()),
    );
  }

  private async isReadOnlySubmission(locator: Locator, input: ActInput): Promise<boolean> {
    if (!this.config.safety.readOnly) return false;
    if (!['click', 'dblclick', 'press'].includes(input.action)) return false;
    return locator.evaluate((element, action) => {
      if (!(element instanceof HTMLButtonElement || element instanceof HTMLInputElement) || !element.form) return false;
      if (action.action !== 'press') return ['submit', 'image'].includes(element.type);
      return ['Enter', 'NumpadEnter'].includes(action.value ?? '');
    }, input);
  }

  private async executeAction(locator: Locator, action: NonNullable<Step['action']>, value?: string): Promise<void> {
    switch (action) {
      case 'click':
        await locator.click();
        break;
      case 'dblclick':
        await locator.dblclick();
        break;
      case 'fill':
        await locator.fill(value ?? '');
        break;
      case 'select':
        if (value === undefined) throw new Error('VALUE_REQUIRED: select');
        await locator.selectOption(value);
        break;
      case 'press':
        if (value === undefined) throw new Error('VALUE_REQUIRED: press');
        await locator.press(value);
        break;
      case 'check':
        await locator.check();
        break;
      case 'hover':
        await locator.hover();
        break;
    }
  }

  private async settle(page: Page): Promise<void> {
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined);
    await page.locator('body').waitFor({ state: 'visible', timeout: 5000 });
    await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  }

  private async readState(session: Session): Promise<StateResult> {
    await this.settle(session.page);
    const elements = await collectElements(session.page);
    session.elements = new Map(elements.map((element) => [element.id, element]));
    const signals = await this.collectSignals(session);
    return {
      url: session.page.url(),
      title: await session.page.title(),
      elements,
      signals,
      stepsLeft: this.stepsLeft(session),
    };
  }

  private async collectSignals(session: Session): Promise<Signal[]> {
    const signals = await scanSignals(session.page, this.config);
    for (const signal of signals) session.signals.set(signal.id, signal);
    return signals;
  }

  private stepsLeft(session: Session): number {
    return Math.max(0, this.config.limits.stepsPerSession - session.journal.steps.length);
  }

  private assertStepsRemain(session: Session): void {
    if (this.stepsLeft(session) <= 0) throw new Error('LIMIT_REACHED');
  }

  private async appendStep(session: Session, step: Step): Promise<void> {
    session.journal.steps.push(step);
    await this.writeJournal(session);
  }

  private journalPath(runId: string, sessionId: string): string {
    return join(this.stateDir, 'runs', runId, 'journals', `${sessionId}.json`);
  }

  private candidatePath(runId: string, candidateId: string): string {
    return join(this.stateDir, 'runs', runId, 'candidates', `${candidateId}.json`);
  }

  private async writeJournal(session: Session): Promise<void> {
    await writeJsonAtomic(this.journalPath(session.runId, session.id), session.journal);
  }

  private currentRoute(page: Page): string {
    try {
      return new URL(page.url()).pathname;
    } catch {
      return page.url();
    }
  }

  private async findDuplicate(signature: string): Promise<string | undefined> {
    for (const file of ['known-bugs.json', 'suppressions.json']) {
      let entries: SharedMemoryEntry[];
      try {
        entries = JSON.parse(await readFile(join(this.stateDir, file), 'utf8')) as SharedMemoryEntry[];
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (!Array.isArray(entries)) throw new Error(`SHARED_MEMORY_INVALID: ${file}`);
      const match = entries.find((entry) => entry.signature === signature);
      const id = match?.id ?? match?.candidateId ?? match?.sourceCandidate;
      if (id) return id;
    }
    return undefined;
  }
}
