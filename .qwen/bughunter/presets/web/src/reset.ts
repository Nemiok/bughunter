import type { Page } from 'playwright-core';

import type { Reset } from '@bughunter/core';

import type { Profile } from './profile/types.ts';

/** Что нужно рецепту сброса от живой сессии обхода. */
export type Resettable = {
  page: Page;
  profile: Profile | null;
  baseUrl?: string;
};

/**
 * Возврат приложения к исходным данным перед экраном. Без рецепта профиля сброс невозможен,
 * и это видно в находках: «состояние не сброшено» и «сброшено» — разные утверждения об экране.
 */
export async function applyReset(page: Page, profile: Profile | null, baseUrl?: string): Promise<void> {
  const reset = profile?.reset;
  if (reset === undefined) throw new Error('RESET_UNSUPPORTED');
  if (reset.kind === 'storage-flag') {
    if (reset.key === undefined) throw new Error('RESET_UNSUPPORTED');
    // Флаг пишется в хранилище приложения, поэтому на about:blank сначала нужен переход на origin.
    if (page.url() === 'about:blank' && baseUrl !== undefined) {
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    }
    await page.evaluate((key) => {
      const marker = new Date().toISOString();
      try {
        localStorage.setItem(key, marker);
      } catch { /* приватный режим или закрытое хранилище */ }
      try {
        sessionStorage.setItem(key, marker);
      } catch { /* приватный режим или закрытое хранилище */ }
    }, reset.key);
    return;
  }
  if (reset.url === undefined) throw new Error('RESET_UNSUPPORTED');
  // Reset — действие со стендом: чужой origin запрещён, а отказ endpoint'а обязан быть виден,
  // иначе «состояние сброшено» заявляется молча на неотвеченный запрос.
  const target = new URL(reset.url, baseUrl ?? 'http://localhost');
  if (baseUrl !== undefined && target.origin !== new URL(baseUrl).origin) {
    throw new Error(`RESET_FAILED: foreign origin ${target.origin}`);
  }
  await page.evaluate(async (url) => {
    const response = await fetch(url, { method: 'POST' });
    if (!response.ok) throw new Error(`RESET_FAILED: HTTP ${response.status}`);
  }, target.href);
}

export const webReset: Reset = {
  // Наличие рецепта знает только профиль, а он загружается в сессии: хук объявлен
  // поддерживаемым, а отсутствие рецепта всплывает как RESET_UNSUPPORTED в находках.
  supported: true,
  apply: async (handle) => {
    const { page, profile, baseUrl } = handle as unknown as Resettable;
    await applyReset(page, profile, baseUrl);
  },
};
