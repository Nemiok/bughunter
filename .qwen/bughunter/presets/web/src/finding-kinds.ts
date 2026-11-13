import { randomUUID } from 'node:crypto';

import type { Finding, FindingKinds, SyntheticStep } from '@bughunter/core';

import { readScreens } from './discovery/screens-store.ts';
import type { Step } from './types.ts';

/** Словарь находок детерминированного обхода экрана. */
export const webFindingKindList = [
  'response-captured', 'response-missing', 'extract-failed', 'navigation-failed', 'reset-unsupported',
] as const;

export const webFindingKinds: FindingKinds = {
  kinds: [...webFindingKindList],
  /**
   * Синтетический шаг журнала для промоции находки: переход на экран из инвентаря.
   * Без примера URL шаблон раскрывается единицей — шаг остаётся воспроизводимым.
   */
  syntheticStep: async (finding: Finding, stateDir: string): Promise<SyntheticStep> => {
    const screen = (await readScreens(stateDir)).find((entry) => entry.template === finding.targetRef);
    const sample = screen?.sampleUrl ?? new URL(finding.targetRef.replaceAll(':id', '1'), 'https://screen.invalid').href;
    const url = new URL(sample);
    const target = `${url.pathname}${url.search}`;
    const step: Step = {
      id: randomUUID(),
      kind: 'navigate',
      timestamp: new Date().toISOString(),
      targetRef: finding.targetRef,
      path: target,
      signalIds: [],
    };
    return { step, target };
  },
};
