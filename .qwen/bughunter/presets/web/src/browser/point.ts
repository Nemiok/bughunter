import type { Page } from 'playwright-core';
import type { Profile } from '../profile/types.ts';
import type { ElementSnapshot, ScrollInput, StepAction } from '../types.ts';
import { elementAtPoint, toPlaywrightLocator } from './elements.ts';

export type Point = { x: number; y: number };

export type PointTarget = {
  locator: string;
  text: string;
  role?: string;
  /**
   * Элемент под точкой. Guard'ы и локатор действия строятся по нему, а не по строке локатора:
   * цель обязана быть реальным элементом, иначе запретный текст и readOnly обходились бы координатой.
   */
  snapshot: ElementSnapshot;
};

export const coordinateActions: StepAction[] = ['clickAt', 'hoverAt'];

export async function resolvePointTarget(page: Page, at: Point, profile?: Profile | null): Promise<PointTarget> {
  const snapshot = await elementAtPoint(page, at);
  if (snapshot === null) throw new Error(`POINT_TARGET_UNRESOLVED: ${at.x},${at.y}`);
  const hook = profile?.interactions?.resolvePoint;
  if (hook === undefined) {
    return {
      locator: toPlaywrightLocator(snapshot.locator),
      text: snapshot.name,
      ...(snapshot.role === 'generic' ? {} : { role: snapshot.role }),
      snapshot,
    };
  }
  // Хук профиля нужен там, где семантическая цель не совпадает с DOM-элементом (canvas-сцена
  // приложения): под точкой остаётся canvas, а приложение знает, какой объект сцены там нарисован.
  const evaluateHook = new Function('point', `return (${hook})(point);`) as
    (point: Point) => { locator?: unknown; text?: unknown; role?: unknown } | null;
  const resolved = await page.evaluate(evaluateHook, at);
  if (resolved === null || typeof resolved?.locator !== 'string' || resolved.locator.length === 0) {
    throw new Error(`POINT_TARGET_UNRESOLVED: ${at.x},${at.y}`);
  }
  return {
    locator: resolved.locator,
    text: typeof resolved.text === 'string' ? resolved.text : snapshot.name,
    ...(typeof resolved.role === 'string' ? { role: resolved.role } : {}),
    snapshot,
  };
}

export function scrollDeltas(scroll: ScrollInput): { dx: number; dy: number } {
  switch (scroll.direction) {
    case 'down':
      return { dx: 0, dy: scroll.delta };
    case 'up':
      return { dx: 0, dy: -scroll.delta };
    case 'right':
      return { dx: scroll.delta, dy: 0 };
    case 'left':
      return { dx: -scroll.delta, dy: 0 };
  }
}

export function isValidScroll(scroll: ScrollInput | undefined): scroll is ScrollInput {
  return scroll !== undefined
    && ['up', 'down', 'left', 'right'].includes(scroll.direction)
    && Number.isFinite(scroll.delta)
    && scroll.delta > 0;
}
