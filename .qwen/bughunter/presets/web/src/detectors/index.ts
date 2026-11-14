import type { Detectors, SessionHandle, Signal } from '@bughunter/core';

import type { WebSessionHandle } from '../session-handle.ts';

export { findAnomalyTexts, scanSignals } from './signals.ts';

/** Виды симптомов веб-пресета: словарь открыт, core нормализует и подписывает любой из них. */
export const webDetectorKinds = [
  'console', 'pageerror', 'requestfailed', 'response', 'anomaly', 'errorBoundary',
] as const;

/**
 * Веб-детекторы работают внутри сессии: слушатели консоли и ошибок страницы, сетевой перехват и
 * скан аномальных текстов установлены при открытии. Поэтому `scan` не обследует страницу заново,
 * а отдаёт то, что сессия уже накопила с прошлого сканирования.
 */
export const webDetectors: Detectors = {
  kinds: [...webDetectorKinds],
  scan: async (handle: SessionHandle): Promise<Signal[]> => (handle as WebSessionHandle).drainSignals(),
};
