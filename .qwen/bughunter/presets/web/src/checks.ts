import type { Check } from '@bughunter/core';

/**
 * Словарь оракулов веб-пресета: нарушения инварианта, которые можно проверить в браузере.
 * Core знает только строковый `kind` и требует, чтобы он был в этом словаре.
 */
export const webCheckKinds = ['visibleText', 'notVisibleText', 'elementCount'] as const;

export type WebCheckKind = (typeof webCheckKinds)[number];

export type WebCheck = Check & { kind: WebCheckKind };
