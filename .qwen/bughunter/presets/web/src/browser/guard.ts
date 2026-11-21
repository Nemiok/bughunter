import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright-core';
import type { APIResponse } from 'playwright-core';

function allowed(target: URL, allowedOrigins: string[]): boolean {
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) return false;
  return allowedOrigins.some((origin) => {
    try {
      const allowedOrigin = new URL(origin);
      return !allowedOrigin.username && !allowedOrigin.password && allowedOrigin.origin === target.origin;
    } catch {
      return false;
    }
  });
}

/** Приземление страницы после редиректов: обход не описывает чужой DOM. */
export function allowedLanding(url: string, allowedOrigins: string[]): boolean {
  if (url === 'about:blank') return true;
  try {
    return allowed(new URL(url), allowedOrigins);
  } catch {
    return false;
  }
}

const maximumRedirectHops = 10;

function redirectTarget(response: APIResponse, currentUrl: string): URL | undefined {
  const status = response.status();
  if (status < 300 || status >= 400) return undefined;
  const location = response.headers()['location'];
  if (location === undefined) return undefined;
  try {
    return new URL(location, currentUrl);
  } catch {
    return undefined;
  }
}

/**
 * Guard детерминированного обхода. Continue-запросы Playwright не пере-перехватывает
 * на redirect-цепочке, поэтому:
 * — навигации проверяются на первом хопе (fetch без редиректов + проверка Location);
 * — субресурсы следуют редиректам вручную с проверкой каждого хопа;
 * — многозвенная навигационная цепочка, которую браузер следует вне routing, останавливается
 *   слушателем framenavigated, а sweep/crawl дополнительно проверяют приземление после goto.
 * Интерактивные сессии владеют своим более сложным guard'ом с учётом popup'ов.
 */
export async function installOriginGuard(context: BrowserContext, allowedOrigins: string[]): Promise<void> {
  await context.route('**/*', async (route) => {
    const request = route.request();
    let ok = false;
    try {
      ok = allowed(new URL(request.url()), allowedOrigins);
    } catch {
      ok = false;
    }
    if (!ok) {
      await route.abort('blockedbyclient').catch(() => undefined);
      return;
    }
    const first = await route.fetch({ maxRedirects: 0 }).catch(() => undefined);
    if (first === undefined) {
      // Origin уже проверен: настоящую сетевую ошибку обязан увидеть браузер, не маскировка.
      await route.continue().catch(() => undefined);
      return;
    }
    if (request.isNavigationRequest()) {
      const target = redirectTarget(first, request.url());
      if (target !== undefined && !allowed(target, allowedOrigins)) {
        await first.dispose().catch(() => undefined);
        await route.abort('blockedbyclient').catch(() => undefined);
        return;
      }
      await route.fulfill({ response: first }).catch(() => undefined);
      return;
    }
    let response = first;
    let currentUrl = request.url();
    for (let hop = 0; hop < maximumRedirectHops; hop += 1) {
      const target = redirectTarget(response, currentUrl);
      if (target === undefined) break;
      if (!allowed(target, allowedOrigins)) {
        await response.dispose().catch(() => undefined);
        await route.abort('blockedbyclient').catch(() => undefined);
        return;
      }
      await response.dispose().catch(() => undefined);
      currentUrl = target.href;
      const next = await route.fetch({ url: currentUrl, maxRedirects: 0 }).catch(() => undefined);
      if (next === undefined) {
        await route.continue().catch(() => undefined);
        return;
      }
      response = next;
    }
    await route.fulfill({ response }).catch(() => undefined);
  });
  context.on('page', (page) => {
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      if (!allowedLanding(frame.url(), allowedOrigins)) {
        void page.evaluate(() => window.stop()).catch(() => undefined);
      }
    });
  });
}

/** Auth-состояние интерактивных сессий доступно и обходу: за логином анонимный обход видит только логин. */
export async function readStorageStatePath(stateDir: string): Promise<string | undefined> {
  const path = join(stateDir, 'auth', 'storage-state.json');
  try {
    await access(path);
    return path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
