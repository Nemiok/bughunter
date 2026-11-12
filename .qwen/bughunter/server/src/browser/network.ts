import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page, Response as PlaywrightResponse } from 'playwright-core';

export const maxResponseBodyBytes = 262_144;

export type CapturedResponse = {
  url: string;
  method: string;
  status: number;
  route: string;
  timestamp: string;
  hash?: string;
  bytes: number;
  truncated: boolean;
  contentType?: string;
  json?: unknown;
  bodyPath?: string;
  bodyError?: string;
  fromServiceWorker?: boolean;
};

export type NetworkCapture = {
  responses(): CapturedResponse[];
  takePending(): CapturedResponse[];
  /** Дожидается завершения всех незакрытых чтений тел, чтобы снимок очереди был детерминированным. */
  flush(): Promise<void>;
  waitFor(urlPattern: string, timeoutMs: number): Promise<CapturedResponse>;
  sourceUnavailable(): string | null;
  dispose(): Promise<void>;
};

export type NetworkCaptureOptions = {
  stateDir: string;
  runId: string;
  allowedOrigins: string[];
  maxBodyBytes?: number;
  responseSource?: 'playwright' | 'page-hook';
};

type PushedResponse = {
  url: string;
  method: string;
  status: number;
  body?: string | null;
  contentType?: string;
};

function isAllowedOrigin(url: string, allowedOrigins: string[]): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  return allowedOrigins.some((origin) => {
    try {
      return new URL(origin).origin === target.origin;
    } catch {
      return false;
    }
  });
}

function normalizeContentType(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const type = value.split(';')[0]?.trim().toLowerCase();
  return type === undefined || type === '' ? undefined : type;
}

function parseBody(contentType: string | undefined, body: string): unknown {
  if (contentType !== undefined && !contentType.includes('json')) return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

const bodyContentTypes = ['json', 'text/plain', 'text/csv', 'text/xml', 'application/xml'];

/** Тела читаются только у «данных»: JS/CSS/шрифты/картинки дев-сервера дали бы сотни бесполезных чтений. */
function shouldReadBody(contentType: string | undefined): boolean {
  if (contentType === undefined) return false;
  return bodyContentTypes.some((token) => contentType.includes(token));
}

export async function attachNetworkCapture(page: Page, options: NetworkCaptureOptions): Promise<NetworkCapture> {
  const limit = options.maxBodyBytes ?? maxResponseBodyBytes;
  const source = options.responseSource ?? 'playwright';
  const all: CapturedResponse[] = [];
  const pending: CapturedResponse[] = [];
  let unavailable: string | null = null;
  let pushedCount = 0;
  let disposed = false;
  const inFlight = new Set<Promise<void>>();

  function track(task: Promise<void>): void {
    inFlight.add(task);
    task.catch(() => undefined).then(() => { inFlight.delete(task); });
  }

  const currentRoute = (): string => {
    try {
      return new URL(page.url()).pathname;
    } catch {
      return page.url();
    }
  };

  async function record(entry: CapturedResponse, body: string | null): Promise<void> {
    if (body !== null) {
      const bytes = Buffer.byteLength(body);
      entry.bytes = bytes;
      entry.hash = createHash('sha256').update(body).digest('hex');
      if (bytes > limit) {
        const relative = join('runs', options.runId, 'responses', `${entry.hash}.body`);
        await mkdir(join(options.stateDir, 'runs', options.runId, 'responses'), { recursive: true });
        await writeFile(join(options.stateDir, relative), body, 'utf8');
        entry.truncated = true;
        entry.bodyPath = relative;
      } else {
        entry.json = parseBody(entry.contentType, body);
      }
    }
    all.push(entry);
    pending.push(entry);
  }

  const onResponse = (response: PlaywrightResponse): void => {
    if (disposed || !isAllowedOrigin(response.url(), options.allowedOrigins)) return;
    const entry: CapturedResponse = {
      url: response.url(),
      method: response.request().method(),
      status: response.status(),
      route: currentRoute(),
      timestamp: new Date().toISOString(),
      bytes: 0,
      truncated: false,
      contentType: normalizeContentType(response.headers()['content-type']),
      ...(typeof response.fromServiceWorker === 'function' ? { fromServiceWorker: response.fromServiceWorker() } : {}),
    };
    track((async () => {
      let body: string | null = null;
      if (shouldReadBody(entry.contentType)) {
        try {
          body = (await response.body()).toString('utf8');
        } catch (error) {
          entry.bodyError = error instanceof Error ? error.message.split('\n')[0] : String(error);
        }
      }
      await record(entry, body);
    })());
  };

  if (source === 'playwright') {
    page.on('response', onResponse);
  } else {
    await page.exposeFunction('__bhReportResponse', (pushed: PushedResponse) => {
      pushedCount += 1;
      if (disposed || !isAllowedOrigin(pushed.url, options.allowedOrigins)) return;
      track(record({
        url: pushed.url,
        method: pushed.method,
        status: pushed.status,
        route: currentRoute(),
        timestamp: new Date().toISOString(),
        bytes: 0,
        truncated: false,
        contentType: normalizeContentType(pushed.contentType),
      }, pushed.body ?? null));
    });
  }

  return {
    responses: () => [...all],
    takePending: () => pending.splice(0),
    async flush(): Promise<void> {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
    async waitFor(urlPattern: string, timeoutMs: number): Promise<CapturedResponse> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = all.find((entry) => entry.url.includes(urlPattern));
        if (found !== undefined) return found;
        if (Date.now() >= deadline) {
          if (source === 'page-hook' && pushedCount === 0) {
            unavailable = 'RESPONSE_SOURCE_UNAVAILABLE';
            throw new Error(`RESPONSE_SOURCE_UNAVAILABLE: ${urlPattern}`);
          }
          throw new Error(`RESPONSE_TIMEOUT: ${urlPattern}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    sourceUnavailable: () => unavailable,
    async dispose(): Promise<void> {
      disposed = true;
      if (source === 'playwright') page.off('response', onResponse);
    },
  };
}
