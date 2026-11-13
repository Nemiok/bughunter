import { randomUUID } from 'node:crypto';

import type { Finding, FindingKinds, Step } from '@bughunter/core';

import { readScreens } from './discovery/screens-store.ts';

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
  syntheticStep: async (finding: Finding, stateDir: string): Promise<Step> => {
    const screen = (await readScreens(stateDir)).find((entry) => entry.template === finding.screenTemplate);
    const sample = screen?.sampleUrl ?? new URL(finding.screenTemplate.replaceAll(':id', '1'), 'https://screen.invalid').href;
    const target = new URL(sample);
    return {
      id: randomUUID(),
      kind: 'navigate',
      timestamp: new Date().toISOString(),
      routeTemplate: finding.screenTemplate,
      path: `${target.pathname}${target.search}`,
      signalIds: [],
    };
  },
};
