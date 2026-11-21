import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright-core';
import { normalizeMessage, signalSignature } from '@bughunter/core';
import type { Signal, SignatureInput } from '@bughunter/core';
import type { WebConfig as Config } from '../config.ts';

type PageState = {
  signals: Signal[];
  activeAnomalies: Set<string>;
  activeBoundaries: Set<string>;
  listenersInstalled: boolean;
};

const pageStates = new WeakMap<Page, PageState>();

export function findAnomalyTexts(text: string, anomalies: string[]): string[] {
  return anomalies.filter((anomaly) => {
    if (anomaly.length === 0) return false;
    const escaped = anomaly.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'u').test(text);
  });
}

function currentRoute(page: Page): string {
  try {
    return new URL(page.url()).pathname;
  } catch {
    return page.url();
  }
}

type DetectedSignal = Omit<SignatureInput, 'target'> & { url?: string; status?: number; blockedBy?: string };

function addSignal(page: Page, config: Config, input: DetectedSignal): Signal {
  const target = currentRoute(page);
  const details = {
    ...(input.url === undefined ? {} : { url: input.url }),
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.blockedBy === undefined ? {} : { blockedBy: input.blockedBy }),
  };
  const signal: Signal = {
    id: randomUUID(),
    kind: input.kind,
    message: input.message,
    signature: signalSignature({ ...input, target }),
    target,
    timestamp: new Date().toISOString(),
    ...(input.stack === undefined ? {} : { stack: input.stack }),
    ...(Object.keys(details).length === 0 ? {} : { details }),
  };
  pageStates.get(page)!.signals.push(signal);
  return signal;
}

function ignored(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => value.includes(pattern));
}

async function installListeners(page: Page, config: Config, state: PageState): Promise<void> {
  if (state.listenersInstalled) return;
  state.listenersInstalled = true;

  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (!ignored(text, config.detectors.ignoreConsole)) {
      addSignal(page, config, { kind: 'console', message: text });
    }
  });
  page.on('pageerror', (error) => {
    addSignal(page, config, { kind: 'pageerror', message: error.message, stack: error.stack });
  });
  page.on('requestfailed', (request) => {
    const url = request.url();
    if (ignored(url, config.detectors.ignoreRequests)) return;
    const reason = request.failure()?.errorText ?? 'Request failed';
    // В controlled-браузере пресета нет расширений: blockedbyclient порождает только origin-guard.
    const blockedBy = /blocked_by_client/i.test(reason) ? 'origin-guard' : undefined;
    addSignal(page, config, {
      kind: 'requestfailed',
      message: `${request.method()} ${url}: ${reason}`,
      url,
      ...(blockedBy === undefined ? {} : { blockedBy }),
    });
  });
  page.on('response', (response) => {
    if (response.status() < 400 || ignored(response.url(), config.detectors.ignoreRequests)) return;
    addSignal(page, config, {
      kind: 'response',
      message: `${response.request().method()} ${response.url()}: HTTP ${response.status()}`,
      url: response.url(),
      status: response.status(),
    });
  });

  await page.exposeFunction('__bughunterReportBoundary', (texts: string[]) => {
    reconcileErrorBoundaries(page, config, state, new Set(texts));
  });
  await observeErrorBoundary(page, config.detectors.errorBoundarySelector);
  await observeAnomalies(page, config, state);
}

function reconcileErrorBoundaries(page: Page, config: Config, state: PageState, visibleTexts: Set<string>): void {
  for (const text of visibleTexts) {
    if (!state.activeBoundaries.has(text)) {
      addSignal(page, config, { kind: 'errorBoundary', message: text || config.detectors.errorBoundarySelector });
    }
  }
  state.activeBoundaries = visibleTexts;
}

async function observeErrorBoundary(page: Page, selector: string): Promise<void> {
  await page.evaluate((boundarySelector) => {
    const target = window as unknown as Window & {
      __bughunterBoundaryObserver?: MutationObserver;
      __bughunterReportBoundary: (texts: string[]) => void;
    };
    if (target.__bughunterBoundaryObserver) return;
    const report = () => {
      const visibleTexts: string[] = [];
      for (const element of document.querySelectorAll(boundarySelector)) {
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        if (style.display !== 'none' && style.visibility !== 'hidden' && bounds.width > 0 && bounds.height > 0) {
          visibleTexts.push(element.textContent?.trim() ?? '');
        }
      }
      target.__bughunterReportBoundary(visibleTexts);
    };
    target.__bughunterBoundaryObserver = new MutationObserver(report);
    target.__bughunterBoundaryObserver.observe(document.documentElement, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    report();
  }, selector);
}

function reconcileAnomalies(page: Page, config: Config, state: PageState, found: Set<string>): void {
  for (const anomaly of found) {
    if (!state.activeAnomalies.has(anomaly)) {
      addSignal(page, config, { kind: 'anomaly', message: anomaly });
    }
  }
  state.activeAnomalies = found;
}

async function observeAnomalies(page: Page, config: Config, state: PageState): Promise<void> {
  await page.exposeFunction('__bughunterReportAnomalies', (texts: string[]) => {
    reconcileAnomalies(page, config, state, new Set(texts));
  });
  const install = (anomalyTexts: string[]): void => {
    const target = window as unknown as Window & {
      __bughunterAnomalyObserver?: MutationObserver;
      __bughunterReportAnomalies: (texts: string[]) => void;
    };
    if (target.__bughunterAnomalyObserver) return;
    const report = (): void => {
      if (!document.body) return;
      const text = document.body.innerText;
      const found = anomalyTexts.filter((anomaly) => {
        if (anomaly.length === 0) return false;
        const escaped = anomaly.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'u').test(text);
      });
      target.__bughunterReportAnomalies(found);
    };
    target.__bughunterAnomalyObserver = new MutationObserver(report);
    target.__bughunterAnomalyObserver.observe(document, {
      characterData: true,
      childList: true,
      subtree: true,
    });
    report();
  };
  await page.addInitScript(install, config.detectors.anomalyTexts);
  await page.evaluate(install, config.detectors.anomalyTexts);
}

async function scanBodyText(page: Page, config: Config, state: PageState): Promise<void> {
  const bodyText = await page.locator('body').innerText();
  reconcileAnomalies(page, config, state, new Set(findAnomalyTexts(bodyText, config.detectors.anomalyTexts)));
}

async function scanErrorBoundaries(page: Page, config: Config, state: PageState): Promise<void> {
  const boundaries = page.locator(config.detectors.errorBoundarySelector);
  const visibleTexts = new Set<string>();
  for (let index = 0; index < await boundaries.count(); index++) {
    const boundary = boundaries.nth(index);
    if (await boundary.isVisible()) visibleTexts.add((await boundary.innerText()).trim());
  }
  reconcileErrorBoundaries(page, config, state, visibleTexts);
}

/** Диалог — симптом приложения: модель обязана его видеть, а не получать молчаливую отмену. */
export function reportDialogSignal(page: Page, config: Config, message: string): void {
  addSignal(page, config, { kind: 'dialog', message });
}

export async function scanSignals(page: Page, config: Config): Promise<Signal[]> {
  let state = pageStates.get(page);
  if (!state) {
    state = { signals: [], activeAnomalies: new Set(), activeBoundaries: new Set(), listenersInstalled: false };
    pageStates.set(page, state);
  }
  await installListeners(page, config, state);
  await observeErrorBoundary(page, config.detectors.errorBoundarySelector);
  await scanBodyText(page, config, state);
  await scanErrorBoundaries(page, config, state);
  return state.signals.splice(0);
}
