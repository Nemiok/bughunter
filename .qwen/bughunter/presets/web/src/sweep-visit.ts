import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext } from 'playwright-core';

import { runSweep as runCoreSweep } from '@bughunter/core';
import type {
  FindingDraft, Session, SessionHandle, SweepResult, SweepVisit, TargetInventory,
} from '@bughunter/core';

import { attachNetworkCapture } from './browser/network.ts';
import type { NetworkCapture } from './browser/network.ts';
import { describeScreen } from './browser/screen.ts';
import type { ScreenStructure } from './browser/screen.ts';
import { resolveLaunchOptions } from './browser/session.ts';
import { loadConfig } from './config.ts';
import { readScreens, templatisedPathname } from './discovery/screens-store.ts';
import { webFindingKinds } from './finding-kinds.ts';
import { loadProfile } from './profile/load.ts';
import { webReset } from './reset.ts';
import type { Resettable } from './reset.ts';

export const defaultScreensPerSweep = 25;
export const defaultResponseSettleMs = 2_500;

/** Инвентарь веб-приложения: шаблоны экранов из `screens.json`. */
export const webInventory: TargetInventory = {
  list: async (stateDir) => (await readScreens(stateDir)).map((screen) => screen.template),
  templateOf: (value) => templatisedPathname(value.startsWith('/') ? value.split('?')[0]! : new URL(value).pathname),
};

export type WebSweepHandle = SessionHandle & Resettable & {
  network: NetworkCapture;
  /** Сколько миллисекунд обход ждёт ответов приложения на экране. */
  settleMs: number;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const webSweepSession: Session = {
  /**
   * Одна сессия на вызов обхода: браузер запускается один раз на срез инвентаря, а не на
   * каждую цель. Журнал шагов не ведётся — находка становится журналом только при промоции.
   */
  open: async ({ runId, stateDir }): Promise<SessionHandle> => {
    const config = await loadConfig(stateDir);
    const profile = config.profile === undefined ? null : await loadProfile(stateDir, config.profile);
    const launch = resolveLaunchOptions(config, profile);
    const browser: Browser = await chromium.launch({
      channel: 'chrome',
      ...(launch.args.length > 0 ? { args: launch.args } : {}),
      ...(launch.proxy === undefined ? {} : { proxy: launch.proxy }),
    });
    let context: BrowserContext | undefined;
    let network: NetworkCapture | undefined;
    try {
      context = await browser.newContext({
        ...(launch.ignoreHTTPSErrors ? { ignoreHTTPSErrors: true } : {}),
      });
      const page = await context.newPage();
      network = await attachNetworkCapture(page, {
        stateDir,
        runId,
        allowedOrigins: config.allowedOrigins,
        ...(profile?.responseSource === undefined ? {} : { responseSource: profile.responseSource }),
      });
      const capture = network;
      const handle: WebSweepHandle = {
        id: `sweep-${runId}`,
        page,
        profile,
        baseUrl: config.baseUrl,
        network: capture,
        settleMs: config.limits.responseSettleMs ?? defaultResponseSettleMs,
        snapshot: async () => describeScreen(page, profile),
        act: async () => {
          throw new Error('SWEEP_SESSION_READ_ONLY: детерминированный обход не совершает действий');
        },
        steps: () => [],
        artifacts: () => [],
        close: async () => {
          await capture.dispose().catch(() => undefined);
          await context?.close().catch(() => undefined);
          await browser.close().catch(() => undefined);
        },
      };
      return handle;
    } catch (error) {
      await network?.dispose().catch(() => undefined);
      await context?.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
      throw error;
    }
  },
};

export const webSweepVisit: SweepVisit = {
  /** Обход экрана: переход → ожидание привязанных ответов → структура экрана → находки. */
  visit: async ({ target, handle, stateDir }): Promise<FindingDraft[]> => {
    const sweep = handle as WebSweepHandle;
    const screen = (await readScreens(stateDir)).find((entry) => entry.template === target);
    if (screen === undefined) {
      return [{
        screenTemplate: target,
        kind: 'navigation-failed',
        detail: `SCREEN_NOT_FOUND: ${target}`,
        responseHashes: [],
      }];
    }
    try {
      await sweep.page.goto(screen.sampleUrl, { waitUntil: 'domcontentloaded', timeout: sweep.settleMs * 10 });
    } catch (error) {
      return [{ screenTemplate: target, kind: 'navigation-failed', detail: messageOf(error), responseHashes: [] }];
    }
    await sweep.page.waitForLoadState('networkidle', { timeout: sweep.settleMs }).catch(() => undefined);
    await sweep.network.flush();
    const responses = sweep.network.takePending();
    const structure = await sweep.snapshot() as ScreenStructure;

    const drafts: FindingDraft[] = [];
    for (const widget of structure.widgets) {
      if (widget.error === undefined) continue;
      drafts.push({
        screenTemplate: target,
        ...(widget.widget === undefined ? {} : { widget: widget.widget }),
        kind: 'extract-failed',
        detail: widget.error,
        responseHashes: [],
      });
    }
    const hashes = responses.map((response) => response.hash).filter((hash): hash is string => hash !== undefined);
    drafts.push(hashes.length === 0 && responses.length === 0
      ? {
        screenTemplate: target,
        kind: 'response-missing',
        detail: 'Экран не вернул ни одного ответа; сверка данных невозможна',
        responseHashes: [],
      }
      : {
        screenTemplate: target,
        kind: 'response-captured',
        detail: `Ответов: ${responses.length}, с телом: ${hashes.length}`,
        responseHashes: hashes,
      });
    return drafts;
  },
};

/**
 * Нейтральные коды обхода из core переводятся в словарь веб-пресета: модель видит экраны,
 * а не «цели», и подсказку про `bh_crawl`, который существует только здесь.
 */
function webSweepError(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('INVENTORY_EMPTY')) {
    return new Error('SCREEN_NOT_FOUND: пустой инвентарь — сначала bh_crawl');
  }
  if (message.startsWith('TARGETS_EMPTY:')) {
    return new Error(message.replace('TARGETS_EMPTY:', 'SCREEN_NOT_FOUND:'));
  }
  return error;
}

/**
 * Обход с веб-значениями по умолчанию: хуки пресета и лимит из конфига приложения.
 * Курсор, чекпоинты и хранилище находок принадлежат core.
 */
export async function runSweep(options: {
  runId: string;
  stateDir: string;
  limit?: number;
  cursor?: number;
}): Promise<SweepResult> {
  const config = await loadConfig(resolve(options.stateDir));
  try {
    return await runCoreSweep({
      runId: options.runId,
      stateDir: options.stateDir,
      limit: options.limit ?? config.limits.screensPerSweep ?? defaultScreensPerSweep,
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      inventory: webInventory,
      session: webSweepSession,
      visit: webSweepVisit,
      reset: webReset,
      findingKinds: webFindingKinds,
    });
  } catch (error) {
    throw webSweepError(error);
  }
}
