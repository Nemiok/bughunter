import { chromium } from 'playwright-core';
import type { Page } from 'playwright-core';
import { installOriginGuard, readStorageStatePath } from '../browser/guard.ts';
import { describeScreen } from '../browser/screen.ts';
import type { LaunchOptions } from '../browser/session.ts';
import type { Profile } from '../profile/types.ts';
import type { ScreenEntry } from '../types.ts';
import { defaultIdSegmentPattern, templatisedPathname, upsertScreens } from './screens-store.ts';

export type CrawlOptions = {
  baseUrl: string;
  allowedOrigins: string[];
  stateDir: string;
  profile: Profile | null;
  maxScreens: number;
  maxDepth: number;
  startPaths: string[];
  launch?: LaunchOptions;
  timeoutMs?: number;
  /**
   * Сколько ждать успокоения сети после загрузки документа. Одностраничное приложение отдаёт
   * документ до рендера, поэтому без ожидания обход видит пустой DOM и теряет весь инвентарь.
   */
  settleMs?: number;
};

export type CrawlResult = {
  added: number;
  updated: number;
  total: number;
  visited: number;
  stoppedEarly: boolean;
  reason?: string;
  /** Переходы, которые обход не выполнил: чужой origin, не-http схема или ошибка загрузки. */
  blocked: string[];
};

export const defaultMaxScreens = 200;
export const defaultMaxDepth = 3;
export const defaultCrawlSettleMs = 2_500;

/** Playwright считает сеть спокойной только после 500 мс тишины, поэтому меньший порог бесполезен. */
const minSettleMs = 500;

type QueueItem = { url: string; depth: number; via: string };

async function collectLinks(page: Page): Promise<string[]> {
  return page.evaluate(() => Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href], [role="link"][href]'))
    .map((link) => link.getAttribute('href') ?? '')
    .filter((href) => href.length > 0 && !href.startsWith('#') && !href.toLowerCase().startsWith('javascript:')));
}

function isAllowedOrigin(url: URL, allowedOrigins: Set<string>): boolean {
  return ['http:', 'https:'].includes(url.protocol)
    && !url.username
    && !url.password
    && allowedOrigins.has(url.origin);
}

/**
 * Обход в ширину по разрешённым origin с шаблонизацией динамических сегментов: инвентарь растёт
 * по числу экранов, а не по числу URL. Чужие переходы не выполняются, но записываются —
 * молча пропущенная ссылка неотличима от отсутствующей.
 */
export async function crawlScreens(options: CrawlOptions): Promise<CrawlResult> {
  const pattern = options.profile?.navigation?.idSegmentPattern ?? defaultIdSegmentPattern;
  const allowedOrigins = new Set(options.allowedOrigins.map((origin) => new URL(origin).origin));
  const timeout = options.timeoutMs ?? 30_000;
  const settle = Math.max(options.settleMs ?? defaultCrawlSettleMs, minSettleMs);
  const launch = options.launch ?? { args: [], ignoreHTTPSErrors: false };

  const browser = await chromium.launch({
    channel: 'chrome',
    ...(launch.args.length > 0 ? { args: launch.args } : {}),
    ...(launch.proxy === undefined ? {} : { proxy: launch.proxy }),
  });
  const entries: ScreenEntry[] = [];
  const blocked: string[] = [];
  const queued = new Set<string>();
  const queue: QueueItem[] = [];
  let stoppedEarly = false;
  let reason: string | undefined;

  const push = (href: string, depth: number, via: string, base: string): void => {
    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      return;
    }
    url.hash = '';
    const key = isAllowedOrigin(url, allowedOrigins)
      ? `${url.origin}${templatisedPathname(url.pathname, pattern)}`
      : url.href;
    if (queued.has(key)) return;
    queued.add(key);
    queue.push({ url: url.href, depth, via });
  };

  const storageState = await readStorageStatePath(options.stateDir);
  const context = await browser.newContext({
    ...(storageState === undefined ? {} : { storageState }),
    ...(launch.ignoreHTTPSErrors ? { ignoreHTTPSErrors: true } : {}),
  });
  await installOriginGuard(context, options.allowedOrigins);
  try {
    const page = await context.newPage();
    for (const path of options.startPaths) push(path, 0, 'start', options.baseUrl);

    while (queue.length > 0) {
      const next = queue.shift()!;
      const url = new URL(next.url);
      if (!isAllowedOrigin(url, allowedOrigins)) {
        blocked.push(next.url);
        continue;
      }
      if (entries.length >= options.maxScreens) {
        stoppedEarly = true;
        reason = 'CRAWL_LIMIT_REACHED';
        break;
      }
      try {
        await page.goto(next.url, { waitUntil: 'domcontentloaded', timeout });
      } catch {
        blocked.push(next.url);
        continue;
      }
      // Таймаут ожидания здесь не ошибка перехода: экран описывается в том состоянии, до которого
      // дошёл. Зато без ожидания обход собирает ссылки из ещё не отрисованного документа.
      await page.waitForLoadState('networkidle', { timeout: settle }).catch(() => undefined);
      const template = templatisedPathname(url.pathname, pattern);
      const screen = await describeScreen(page, options.profile);
      entries.push({
        template,
        sampleUrl: next.url,
        discoveredVia: [next.via],
        widgets: screen.widgets.map((widget) => widget.widget),
        lastCheckedAt: new Date().toISOString(),
      });
      if (next.depth < options.maxDepth) {
        for (const href of await collectLinks(page)) push(href, next.depth + 1, template, next.url);
      }
    }
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }

  const stored = await upsertScreens(options.stateDir, entries);
  return {
    ...stored,
    visited: entries.length,
    stoppedEarly,
    ...(reason === undefined ? {} : { reason }),
    blocked,
  };
}
