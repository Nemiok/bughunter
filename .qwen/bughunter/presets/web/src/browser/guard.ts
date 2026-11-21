import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright-core';

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

/**
 * Guard детерминированного обхода: чужие запросы обрываются, поэтому редирект (например,
 * на SSO-логин) не уводит sweep/crawl за разрешённые origins. Continue-запросы Playwright
 * не пере-перехватывает на redirect-цепочке, поэтому навигации проверяются вручную:
 * fetch без следования редиректам, проверка Location, только потом fulfill.
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
    if (!request.isNavigationRequest()) {
      await route.continue().catch(() => undefined);
      return;
    }
    const response = await route.fetch({ maxRedirects: 0 }).catch(() => undefined);
    if (response === undefined) {
      await route.abort('blockedbyclient').catch(() => undefined);
      return;
    }
    const location = response.headers()['location'];
    if (location !== undefined) {
      let target: URL | undefined;
      try {
        target = new URL(location, request.url());
      } catch {
        target = undefined;
      }
      if (target === undefined || !allowed(target, allowedOrigins)) {
        await response.dispose().catch(() => undefined);
        await route.abort('blockedbyclient').catch(() => undefined);
        return;
      }
    }
    await route.fulfill({ response }).catch(() => undefined);
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
