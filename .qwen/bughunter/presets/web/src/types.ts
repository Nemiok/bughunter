import type { StepBase } from '@bughunter/core';

/** Экран приложения в инвентаре: шаблон маршрута, а не конкретный URL. */
export type ScreenEntry = {
  template: string;
  sampleUrl: string;
  discoveredVia: string[];
  widgets: string[];
  lastCheckedAt?: string;
  /** Позиция в инвентаре для прерванного обхода, чтобы не начинать заново. */
  cursorState?: number;
};

export type SemanticLocator =
  | { kind: 'testid'; value: string; index?: number }
  | { kind: 'role'; role: string; name: string; index?: number }
  | { kind: 'text'; value: string; index?: number }
  | { kind: 'css'; value: string; index?: number };

export type ElementBox = { x: number; y: number; width: number; height: number };

export type ElementSnapshot = {
  id: string;
  role: string;
  name: string;
  type: string;
  value?: string;
  disabled?: boolean;
  locator: SemanticLocator;
  /** Положение в координатах viewport на момент снимка: нужно ранжированию и координатным действиям. */
  box: ElementBox;
};

export type StepAction =
  | 'click' | 'dblclick' | 'fill' | 'select' | 'press' | 'check' | 'hover'
  | 'drag' | 'scroll' | 'clickAt' | 'hoverAt' | 'upload';

export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

export type ScrollInput = { direction: ScrollDirection; delta: number };

/**
 * Шаг журнала веб-пресета: конверт core плюс поля действия. Core хранит и повторяет шаг,
 * не зная, что такое клик или скролл, — форма на диске при этом остаётся плоской.
 */
export type Step = StepBase & {
  kind: 'act' | 'navigate' | 'probe';
  action?: StepAction;
  elementId?: string;
  value?: string;
  path?: string;
  probe?: 'reload' | 'back' | 'mobile_viewport';
  locator?: string;
  /** Цель drag: без неё шаг неоднозначен, а повтор невозможен. */
  to?: { locator: string };
  /** Точка в координатах viewport для clickAt/hoverAt. */
  at?: { x: number; y: number };
  /** Семантическая цель под точкой: доказательство того, что guard'ы видели реальный элемент. */
  resolvedLocator?: string;
  /** Путь файла загрузки относительно `profile.testData.dir` — абсолютный путь машины в журнал не попадает. */
  file?: string;
  scroll?: ScrollInput;
};
