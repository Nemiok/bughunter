import { randomUUID } from 'node:crypto';
import { access, mkdir, readdir, rm } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright-core';
import { reportDialogSignal, scanSignals } from '../detectors/index.ts';
import { validateWebCheck } from '../checks.ts';
import type { Profile } from '../profile/types.ts';
import { attachCandidateArtifacts, countRunCandidates, reportCandidate as reportCoreCandidate, writeJsonAtomic } from '@bughunter/core';
import { resolveTestDataFile } from '../profile/load.ts';
import type {
  Candidate,
  Check,
  Journal,
  Signal,
  StepBase,
} from '@bughunter/core';
import type {
  DialogPolicy,
  DialogRecord,
  ElementSnapshot,
  ScrollInput,
  SemanticLocator,
  Step,
  StepAction,
} from '../types.ts';
import type { WebConfig as Config } from '../config.ts';
import { defaultElementsPerSnapshot } from '../config.ts';
import { collectElements, paginateElements, rankElements, toPlaywrightLocator } from './elements.ts';
import type { Viewport } from './elements.ts';
import { attachNetworkCapture, type NetworkCapture } from './network.ts';
import { describeScreen, type ScreenStructure } from './screen.ts';
import { coordinateActions, isValidScroll, resolvePointTarget, scrollDeltas, type Point, type PointTarget } from './point.ts';

export type StateResult = {
  url: string;
  title: string;
  elements: ElementSnapshot[];
  signals: Signal[];
  stepsLeft: number;
  /** Сколько элементов на странице всего: показывает, что список отдан не целиком. */
  totalVisible: number;
  truncated: boolean;
  nextCursor?: number;
  screen?: ScreenStructure;
  /** Диалоги с прошлого снимка: буфер опустошается, каждый диалог отдаётся один раз. */
  dialogs: DialogRecord[];
};

export type StateOptions = {
  cursor?: number;
  limit?: number;
  /** Собрать структуру экрана по экстракторам профиля. */
  screen?: boolean;
  /** Полный список без лимита: нужен повтору, который ищет элемент по локатору. */
  full?: boolean;
};

export type ActInput = {
  elementId?: string;
  action: StepAction;
  value?: string;
  /** Вторая цель для drag. */
  toElementId?: string;
  /** Точка viewport для clickAt/hoverAt. */
  at?: Point;
  /** Путь файла загрузки относительно `profile.testData.dir`. */
  file?: string;
  scroll?: ScrollInput;
  /** Политика нативного диалога этого действия; по умолчанию 'dismiss'. */
  dialog?: DialogPolicy;
};

/** Действия, которым цель не нужна: скролл страницы работает по viewport. */
const elementlessActions: StepAction[] = ['scroll'];

const defaultViewport: Viewport = { width: 1280, height: 720 };

export type ActResult = {
  ok: boolean;
  error?: string;
  navigated: boolean;
  signals: Signal[];
  dialogs: DialogRecord[];
};

type ResolvedAction =
  | { ok: false; error: string }
  | {
    ok: true;
    element: ElementSnapshot | undefined;
    locator: Locator | null;
    point: PointTarget | undefined;
    target: { snapshot: ElementSnapshot; locator: Locator } | undefined;
    filePath: string | undefined;
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
  network: NetworkCapture;
  dialogPolicy: DialogPolicy;
  dialogs: DialogRecord[];
  dialogForbidden: boolean;
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

export type LaunchOptions = {
  args: string[];
  proxy?: { server: string };
  ignoreHTTPSErrors: boolean;
};

const forbiddenLaunchArgs = [
  '--disable-web-security',
  '--allow-running-insecure-content',
  '--unsafely-treat-insecure-origin-as-secure',
  '--remote-debugging-port',
];

const requiredLaunchArgs = ['--no-first-run', '--no-default-browser-check'];

export function resolveLaunchOptions(config: Config, profile: Profile | null): LaunchOptions {
  const merged = new Map<string, string>();
  for (const argument of [...(config.browser?.launchArgs ?? []), ...(profile?.browser?.launchArgs ?? [])]) {
    const name = argument.split('=', 1)[0]!;
    if (forbiddenLaunchArgs.includes(name)) throw new Error(`LAUNCH_ARG_FORBIDDEN: ${argument}`);
    merged.set(name, argument);
  }
  for (const required of requiredLaunchArgs) merged.set(required, required);
  const proxy = config.browser?.proxy;
  return {
    args: [...merged.values()],
    ...(proxy === undefined ? {} : { proxy: { server: proxy } }),
    ignoreHTTPSErrors: config.browser?.ignoreHTTPSErrors ?? false,
  };
}

export class SessionManager {
  private browser?: Browser;
  private browserPromise?: Promise<Browser>;
  private readonly sessions = new Map<string, Session>();
  private readonly blockedNavigations = new Set<Page>();
  private readonly blockedPopups = new WeakSet<BrowserContext>();
  private readonly config: Config;
  private readonly stateDir: string;
  private readonly profile: Profile | null;

  constructor(config: Config, stateDir: string, profile: Profile | null = null) {
    this.config = config;
    this.stateDir = stateDir;
    this.profile = profile;
  }

  /** Лимит элементов снимка; публичен, потому что страницы снимка нарезает слой MCP. */
  get snapshotLimit(): number {
    return this.config.limits.elementsPerSnapshot ?? defaultElementsPerSnapshot;
  }

  /** Страница сессии: нужна оракулам и детекторам, которые работают мимо слоя MCP. */
  pageOf(sessionId: string): Page {
    return this.session(sessionId).page;
  }

  /** Шаги журнала сессии на текущий момент; копия, чтобы журнал нельзя было изменить извне. */
  stepsOf(sessionId: string): StepBase[] {
    return [...this.session(sessionId).journal.steps];
  }

  private launchOptions(): LaunchOptions {
    return resolveLaunchOptions(this.config, this.profile);
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
    let network: NetworkCapture | undefined;
    try {
      let storageState: string | undefined;
      try {
        await access(storageStatePath);
        storageState = storageStatePath;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const launchOptions = this.launchOptions();
      context = await browser.newContext({
        ...(storageState === undefined ? {} : { storageState }),
        ...(launchOptions.ignoreHTTPSErrors ? { ignoreHTTPSErrors: true } : {}),
        recordVideo: { dir: mediaDir },
      });
      await this.installNavigationGuard(context);
      await context.tracing.start({ screenshots: true, snapshots: true });
      const page = await context.newPage();
      network = await attachNetworkCapture(page, {
        stateDir: this.stateDir,
        runId,
        allowedOrigins: this.config.allowedOrigins,
      });
      const journal: Journal = {
        sessionId,
        runId,
        target: route,
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
        network,
        dialogPolicy: 'dismiss',
        dialogs: [],
        dialogForbidden: false,
      };
      this.sessions.set(sessionId, session);
      // Без слушателя Playwright молча отклоняет диалоги: приложение, ждущее confirm(),
      // выглядело бы сломанным. Диалог становится сигналом и записью, политика — явной.
      page.on('dialog', (dialog) => {
        const message = dialog.message();
        const forbidden = this.config.safety.forbiddenActionText.some((token) =>
          token.length > 0 && message.toLocaleLowerCase().includes(token.toLocaleLowerCase()));
        const handled: DialogPolicy = session.dialogPolicy === 'accept' && !forbidden ? 'accept' : 'dismiss';
        session.dialogs.push({ type: dialog.type(), message, handled });
        if (forbidden && session.dialogPolicy === 'accept') session.dialogForbidden = true;
        reportDialogSignal(page, this.config, `${dialog.type()}: ${message}`);
        void (handled === 'accept' ? dialog.accept() : dialog.dismiss()).catch(() => undefined);
      });
      await scanSignals(page, this.config);
      await page.goto(target, { waitUntil: 'domcontentloaded' });
      await this.settle(page);
      await this.writeJournal(session);
      return { sessionId };
    } catch (error) {
      this.sessions.delete(sessionId);
      await network?.dispose().catch(() => undefined);
      await context?.close().catch(() => undefined);
      await rm(mediaDir, { recursive: true, force: true });
      throw error;
    }
  }

  async state(sessionId: string, options: StateOptions = {}): Promise<StateResult> {
    const session = this.session(sessionId);
    return this.presentState(session, await this.readState(session), options);
  }

  async act(sessionId: string, input: ActInput): Promise<ActResult> {
    const session = this.session(sessionId);
    if (this.stepsLeft(session) <= 0) {
      return { ok: false, error: 'LIMIT_REACHED', navigated: false, signals: [], dialogs: session.dialogs.splice(0) };
    }
    const resolved = await this.resolveAction(session, input);
    if (!resolved.ok) {
      return { ok: false, error: resolved.error, navigated: false, signals: [], dialogs: session.dialogs.splice(0) };
    }
    const { element, locator, point, target, filePath } = resolved;
    // Guard'ы проверяют разрешённую цель, а не аргументы модели: координата сначала
    // превращается в элемент, иначе клик по точке обошёл бы и запретный текст, и readOnly.
    if (element !== undefined && locator !== null) {
      if (await this.isForbidden(element, locator)) {
        return { ok: false, error: 'FORBIDDEN_ACTION', navigated: false, signals: [], dialogs: session.dialogs.splice(0) };
      }
      if (await this.isReadOnlySubmission(locator, input)) {
        return { ok: false, error: 'FORM_SUBMISSION_BLOCKED', navigated: false, signals: [], dialogs: session.dialogs.splice(0) };
      }
      if (target !== undefined && await this.isForbidden(target.snapshot, target.locator)) {
        return { ok: false, error: 'FORBIDDEN_ACTION', navigated: false, signals: [], dialogs: session.dialogs.splice(0) };
      }
    }

    session.dialogPolicy = input.dialog ?? 'dismiss';
    session.dialogForbidden = false;
    try {
      const beforeUrl = session.page.url();
      const value = input.action === 'fill' && input.value === undefined
        ? `${this.config.testDataPrefix}${randomUUID().slice(0, 8)}`
        : input.value;
      let actionError: unknown;
      try {
        await this.executeAction(session.page, locator, input, {
          ...(value === undefined ? {} : { value }),
          ...(target === undefined ? {} : { target: target.locator }),
          ...(filePath === undefined ? {} : { filePath }),
        });
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
      const dialogs = session.dialogs.splice(0);
      if (session.dialogForbidden) {
        return { ok: false, error: 'FORBIDDEN_ACTION', navigated: beforeUrl !== session.page.url(), signals, dialogs };
      }
      if (actionError !== undefined) {
        return {
          ok: false,
          error: navigationBlocked ? 'NAVIGATION_NOT_ALLOWED' : popupBlocked ? 'FORBIDDEN_ORIGIN' : `ACTION_FAILED: ${errorMessage(actionError)}`,
          navigated: beforeUrl !== session.page.url(),
          signals,
          dialogs,
        };
      }

      await this.appendStep(session, {
        id: randomUUID(),
        kind: 'act',
        timestamp: new Date().toISOString(),
        targetRef: this.currentRoute(session.page),
        action: input.action,
        ...(input.elementId === undefined ? {} : { elementId: input.elementId }),
        ...(value === undefined ? {} : { value }),
        // Для координатного действия локатор не записывается: повтор идёт по точке,
        // а семантическая цель под ней остаётся в resolvedLocator как доказательство для guard'ов и отчёта.
        ...(point !== undefined || element === undefined ? {} : { locator: toPlaywrightLocator(element.locator) }),
        ...(point === undefined ? {} : { at: input.at, resolvedLocator: point.locator }),
        ...(target === undefined ? {} : { to: { locator: toPlaywrightLocator(target.snapshot.locator) } }),
        ...(input.action === 'upload' && input.file !== undefined ? { file: input.file } : {}),
        ...(input.action === 'scroll' && isValidScroll(input.scroll) ? { scroll: input.scroll } : {}),
        ...(input.dialog === undefined ? {} : { dialog: input.dialog }),
        ...(dialogs.length === 0 ? {} : { dialogs }),
        signalIds: signals.map((signal) => signal.id),
      });
      return { ok: true, navigated: beforeUrl !== session.page.url(), signals, dialogs };
    } finally {
      // Политика принадлежит действию: спонтанный диалог навигации не подтверждается прошлым accept.
      session.dialogPolicy = 'dismiss';
    }
  }

  private async resolveAction(session: Session, input: ActInput): Promise<ResolvedAction> {
    const page = session.page;
    if (input.action === 'scroll' && !isValidScroll(input.scroll)) return { ok: false, error: 'SCROLL_INVALID' };
    if (coordinateActions.includes(input.action) && input.at === undefined) {
      return { ok: false, error: 'POINT_TARGET_UNRESOLVED' };
    }

    let point: PointTarget | undefined;
    let element: ElementSnapshot | undefined;
    let locator: Locator | null = null;
    if (input.at !== undefined) {
      try {
        point = await resolvePointTarget(page, input.at, this.profile);
      } catch (error) {
        const message = errorMessage(error);
        return { ok: false, error: message.startsWith('POINT_TARGET_UNRESOLVED') ? 'POINT_TARGET_UNRESOLVED' : message };
      }
      element = point.snapshot;
      locator = resolveSemanticLocator(page, element.locator);
    } else if (input.elementId !== undefined) {
      const found = session.elements.get(input.elementId);
      if (found === undefined) return { ok: false, error: `ELEMENT_NOT_FOUND: ${input.elementId}` };
      element = found;
      locator = resolveSemanticLocator(page, found.locator);
    } else if (!elementlessActions.includes(input.action)) {
      return { ok: false, error: `ELEMENT_NOT_FOUND: ${String(input.elementId)}` };
    }

    let target: { snapshot: ElementSnapshot; locator: Locator } | undefined;
    if (input.action === 'drag') {
      if (locator === null || input.toElementId === undefined) return { ok: false, error: 'DRAG_TARGET_REQUIRED' };
      const dropTarget = session.elements.get(input.toElementId);
      if (dropTarget === undefined) return { ok: false, error: `ELEMENT_NOT_FOUND: ${input.toElementId}` };
      target = { snapshot: dropTarget, locator: resolveSemanticLocator(page, dropTarget.locator) };
    }

    let filePath: string | undefined;
    if (input.action === 'upload') {
      if (locator === null || input.file === undefined) return { ok: false, error: 'UPLOAD_FILE_NOT_FOUND' };
      try {
        filePath = resolveTestDataFile(this.profile, input.file);
        await access(filePath);
      } catch {
        return { ok: false, error: 'UPLOAD_FILE_NOT_FOUND' };
      }
    }

    return { ok: true, element, locator, point, target, filePath };
  }

  async navigate(sessionId: string, path: string, options: StateOptions = {}): Promise<StateResult> {
    const session = this.session(sessionId);
    this.assertStepsRemain(session);
    const target = this.navigationUrl(path);
    await session.page.goto(target, { waitUntil: 'domcontentloaded' });
    const result = await this.readState(session);
    await this.appendStep(session, {
      id: randomUUID(),
      kind: 'navigate',
      timestamp: new Date().toISOString(),
      targetRef: this.currentRoute(session.page),
      path,
      signalIds: result.signals.map((signal) => signal.id),
    });
    result.stepsLeft = this.stepsLeft(session);
    return this.presentState(session, result, options);
  }

  async probe(sessionId: string, kind: ProbeKind, options: StateOptions = {}): Promise<StateResult> {
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
      targetRef: this.currentRoute(session.page),
      probe: kind,
      signalIds: result.signals.map((signal) => signal.id),
    });
    result.stepsLeft = this.stepsLeft(session);
    return this.presentState(session, result, options);
  }

  async reportCandidate(sessionId: string, input: CandidateInput): Promise<{ candidateId: string; duplicateOf?: string; suppressedBy?: string }> {
    const session = this.session(sessionId);
    const candidateCount = await countRunCandidates(session.runId, this.stateDir);
    if (candidateCount >= this.config.limits.candidatesPerRun) {
      throw new Error(`CANDIDATES_LIMIT_REACHED: ${this.config.limits.candidatesPerRun}`);
    }
    const referencedSignals = input.signalIds.map((id) => {
      const signal = session.signals.get(id);
      if (!signal) throw new Error(`SIGNAL_NOT_FOUND: ${id}`);
      return signal;
    });
    const route = this.currentRoute(session.page);
    if (input.check) {
      validateWebCheck(input.check);
      if (input.check.kind === 'elementCount') {
        // У elementCount `target` — селектор Playwright, а не текст. Ошибка парсинга иначе всплывёт
        // только внутри bh_reproduce, где её проглотит catch, и кандидат молча станет «не воспроизведён»
        // после трёх попыток. Проверяем здесь, пока автор check ещё в цикле и может его поправить.
        try {
          await session.page.locator(input.check.target).count();
        } catch (error) {
          const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
          throw new Error(`CHECK_INVALID: elementCount.target должен быть селектором, для текста используйте text=…: ${reason}`);
        }
      }
    }
    const { candidateId, duplicateOf, suppressedBy } = await reportCoreCandidate({
      runId: session.runId,
      sessionId,
      target: route,
      title: input.title,
      expected: input.expected,
      actual: input.actual,
      steps: session.journal.steps.map((step) => ({ ...step, ...(step.signalIds ? { signalIds: [...step.signalIds] } : {}) })),
      signalIds: [...input.signalIds],
      ...(referencedSignals.length > 0 ? { signalSignature: referencedSignals[0]!.signature } : {}),
      ...(input.check === undefined ? {} : { check: input.check }),
      stateDir: this.stateDir,
    });
    session.candidateIds.push(candidateId);
    return {
      candidateId,
      ...(duplicateOf === undefined ? {} : { duplicateOf }),
      ...(suppressedBy === undefined ? {} : { suppressedBy }),
    };
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
        await session.network.dispose();
      } catch (error) {
        errors.push(error);
      }
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
      await attachCandidateArtifacts({
        runId: session.runId,
        candidateIds: session.candidateIds,
        artifacts,
        stateDir: this.stateDir,
      });
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
      const options = this.launchOptions();
      this.browserPromise = chromium.launch({
        channel: 'chrome',
        headless: true,
        args: options.args,
        ...(options.proxy === undefined ? {} : { proxy: options.proxy }),
      }).then((browser) => {
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
    // clickAt — тот же клик, только заданный точкой: без него readOnly обходился бы координатой.
    if (!['click', 'dblclick', 'press', 'clickAt'].includes(input.action)) return false;
    return locator.evaluate((element, action) => {
      if (!(element instanceof HTMLButtonElement || element instanceof HTMLInputElement) || !element.form) return false;
      if (action.action !== 'press') return ['submit', 'image'].includes(element.type);
      return ['Enter', 'NumpadEnter'].includes(action.value ?? '');
    }, input);
  }

  private async executeAction(
    page: Page,
    locator: Locator | null,
    input: ActInput,
    context: { value?: string; target?: Locator; filePath?: string },
  ): Promise<void> {
    const required = (): Locator => {
      if (locator === null) throw new Error('ELEMENT_REQUIRED');
      return locator;
    };
    switch (input.action) {
      case 'click':
        await required().click();
        break;
      case 'dblclick':
        await required().dblclick();
        break;
      case 'fill':
        await required().fill(context.value ?? '');
        break;
      case 'select':
        if (context.value === undefined) throw new Error('VALUE_REQUIRED: select');
        await required().selectOption(context.value);
        break;
      case 'press':
        if (context.value === undefined) throw new Error('VALUE_REQUIRED: press');
        await required().press(context.value);
        break;
      case 'check':
        await required().check();
        break;
      case 'hover':
        await required().hover();
        break;
      case 'drag':
        if (context.target === undefined) throw new Error('DRAG_TARGET_REQUIRED');
        await required().dragTo(context.target);
        break;
      case 'scroll': {
        if (!isValidScroll(input.scroll)) throw new Error('SCROLL_INVALID');
        const { dx, dy } = scrollDeltas(input.scroll);
        if (locator === null) await page.mouse.wheel(dx, dy);
        else await locator.evaluate((element, delta) => element.scrollBy(delta.dx, delta.dy), { dx, dy });
        break;
      }
      case 'clickAt':
        if (input.at === undefined) throw new Error('POINT_TARGET_UNRESOLVED');
        await page.mouse.click(input.at.x, input.at.y);
        break;
      case 'hoverAt':
        if (input.at === undefined) throw new Error('POINT_TARGET_UNRESOLVED');
        await page.mouse.move(input.at.x, input.at.y);
        break;
      case 'upload':
        if (context.filePath === undefined) throw new Error('UPLOAD_FILE_NOT_FOUND');
        await required().setInputFiles(context.filePath);
        break;
    }
  }

  private async settle(page: Page): Promise<void> {
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined);
    await page.locator('body').waitFor({ state: 'visible', timeout: 5000 });
    // SPA отдаёт документ до данных: без ожидания сети снимок видел бы пустой экран.
    // Ноль отключает ожидание: Playwright трактует timeout 0 как бесконечный.
    const settleMs = this.config.limits.responseSettleMs;
    if (settleMs !== undefined && settleMs > 0) {
      await page.waitForLoadState('networkidle', { timeout: settleMs }).catch(() => undefined);
    }
    await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  }

  private async readState(session: Session): Promise<StateResult> {
    await this.settle(session.page);
    const collected = await collectElements(session.page);
    const elements = rankElements(collected, session.page.viewportSize() ?? defaultViewport);
    // Карта содержит весь снимок, а не только отданную страницу: действие по id
    // должно проходить и для элемента, который модель увидит на следующем курсоре.
    session.elements = new Map(elements.map((element) => [element.id, element]));
    const signals = await this.collectSignals(session);
    return {
      url: session.page.url(),
      title: await session.page.title(),
      elements,
      signals,
      stepsLeft: this.stepsLeft(session),
      totalVisible: elements.length,
      truncated: false,
      dialogs: session.dialogs.splice(0),
    };
  }

  /**
   * Снимок для модели: ранжированный список усекается лимитом и отдаётся страницами,
   * иначе экран на сотни элементов съедает весь контекст ещё до начала исследования.
   */
  private async presentState(session: Session, result: StateResult, options: StateOptions): Promise<StateResult> {
    const listed = options.full === true
      ? { elements: result.elements, totalVisible: result.elements.length, truncated: false, nextCursor: undefined }
      : paginateElements(result.elements, options.limit ?? this.snapshotLimit, options.cursor);
    const screen = options.screen === true ? await describeScreen(session.page, this.profile) : undefined;
    return {
      ...result,
      elements: listed.elements,
      totalVisible: listed.totalVisible,
      truncated: listed.truncated,
      ...(listed.nextCursor === undefined ? {} : { nextCursor: listed.nextCursor }),
      ...(screen === undefined ? {} : { screen }),
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
    if (step.responseHashes === undefined) {
      await session.network.flush();
      const hashes = session.network.takePending()
        .map((response) => response.hash)
        .filter((hash): hash is string => hash !== undefined);
      if (hashes.length > 0) step = { ...step, responseHashes: hashes };
    }
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

}
