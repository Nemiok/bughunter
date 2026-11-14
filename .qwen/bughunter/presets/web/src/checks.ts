import type { Page } from 'playwright-core';

import type { Check, Checks, SessionHandle } from '@bughunter/core';

import type { WebSessionHandle } from './session-handle.ts';

/**
 * Словарь оракулов веб-пресета: нарушения инварианта, которые можно проверить в браузере.
 * Core знает только строковый `kind` и требует, чтобы он был в этом словаре.
 */
export const webCheckKinds = ['visibleText', 'notVisibleText', 'elementCount'] as const;

export type WebCheckKind = (typeof webCheckKinds)[number];

export type WebCheck = Check & { kind: WebCheckKind };

/**
 * Структурная проверка оракула — та её часть, которой не нужна страница. Синтаксис селектора
 * `elementCount` так не проверить: это делает сессия, у которой страница есть, и она же объясняет
 * модели разницу между селектором и текстом.
 */
export function validateWebCheck(check: Check): void {
  if (!(webCheckKinds as readonly string[]).includes(check.kind)) {
    throw new Error(`CHECK_INVALID: неизвестный вид check: ${check.kind}; словарь пресета: ${webCheckKinds.join(', ')}`);
  }
  if (typeof check.target !== 'string' || check.target.trim().length === 0) {
    throw new Error(`CHECK_INVALID: ${check.kind}.target обязателен и не может быть пустым`);
  }
  if (check.kind === 'elementCount' && check.expected !== undefined) {
    // `expected` приходит из схемы строкой или числом; NaN означал бы «нарушено всегда»,
    // то есть кандидата, который воспроизводится на любой странице.
    const expected = Number(check.expected);
    if (!Number.isInteger(expected) || expected < 0) {
      throw new Error(`CHECK_INVALID: elementCount.expected должен быть неотрицательным целым числом, получено: ${String(check.expected)}`);
    }
  }
}

/**
 * Текст считается присутствующим только если видимо хотя бы одно совпадение. `first()` для этого
 * не годится: одно и то же значение часто встречается и в скрытом узле (option фильтра, шаблон,
 * aria-live), и в видимой ячейке — по первому совпадению нарушение пропадало или возникало зря.
 */
async function hasVisibleText(page: Page, target: string): Promise<boolean> {
  const matches = page.getByText(target, { exact: true });
  const total = await matches.count();
  for (let index = 0; index < total; index += 1) {
    if (await matches.nth(index).isVisible()) return true;
  }
  return false;
}

/** Нарушен ли оракул на странице: `true` означает, что симптом кандидата на месте. */
export async function checkViolated(page: Page, check: Check): Promise<boolean> {
  switch ((check as WebCheck).kind) {
    case 'visibleText':
      return !await hasVisibleText(page, check.target);
    case 'notVisibleText':
      return await hasVisibleText(page, check.target);
    case 'elementCount':
      return await page.locator(check.target).count() !== Number(check.expected ?? 0);
  }
}

export async function webCheckViolated(handle: SessionHandle, check: Check): Promise<boolean> {
  return checkViolated((handle as WebSessionHandle).page, check);
}

export const webChecks: Checks = {
  kinds: [...webCheckKinds],
  validate: validateWebCheck,
  violated: webCheckViolated,
};
