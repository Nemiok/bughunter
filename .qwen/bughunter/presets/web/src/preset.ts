import type { Preset } from '@bughunter/core';

import { webFindingKinds } from './finding-kinds.ts';
import { EXPLORER_PERSONAS } from './personas.ts';
import { webReportFormat } from './report-format.ts';
import { webReset } from './reset.ts';
import { webInventory, webSweepVisit } from './sweep-visit.ts';
import { webTestRunner } from './test-runner.ts';

/**
 * Хук объявлен, но ещё не вынесен из кода пресета: вызов падает явно, а не молча.
 * Задачи 3–8 заменяют заглушки настоящими реализациями по одной.
 */
const pending = (hook: string) => (): never => {
  throw new Error(`PRESET_HOOK_NOT_WIRED: ${hook}`);
};

export const webPreset: Preset = {
  name: 'web',
  configSchema: {},
  inventory: webInventory,
  session: { open: pending('session.open') },
  snapshot: { compact: pending('snapshot.compact') },
  detectors: {
    kinds: ['console', 'pageerror', 'requestfailed', 'response', 'anomaly', 'errorBoundary'],
    scan: pending('detectors.scan'),
  },
  checks: {
    kinds: ['visibleText', 'notVisibleText', 'elementCount'],
    validate: pending('checks.validate'),
    violated: pending('checks.violated'),
  },
  replay: { replay: pending('replay.replay') },
  generateTest: { generate: pending('generateTest.generate') },
  profile: { load: pending('profile.load'), testDataFile: pending('profile.testDataFile') },
  testRunner: webTestRunner,
  personas: { roster: EXPLORER_PERSONAS, brief: pending('personas.brief') },
  findingKinds: webFindingKinds,
  sweepVisit: webSweepVisit,
  reset: webReset,
  exportTarget: { dir: pending('exportTarget.dir'), kind: 'e2e', fileName: pending('exportTarget.fileName') },
  errors: { codes: {} },
  report: webReportFormat,
};
