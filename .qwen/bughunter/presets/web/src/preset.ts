import type { Preset } from '@bughunter/core';

import { webCheckKinds } from './checks.ts';
import { webConfigSchema } from './config.ts';

import { webFindingKinds } from './finding-kinds.ts';
import { webErrors } from './errors.ts';
import { webExportTarget, webTestGenerator } from './export-playwright.ts';
import { EXPLORER_PERSONAS } from './personas.ts';
import { webReportFormat } from './report-format.ts';
import { webReset } from './reset.ts';
import { webSnapshot } from './snapshot.ts';
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
  configSchema: webConfigSchema,
  inventory: webInventory,
  session: { open: pending('session.open') },
  snapshot: webSnapshot,
  detectors: {
    kinds: ['console', 'pageerror', 'requestfailed', 'response', 'anomaly', 'errorBoundary'],
    scan: pending('detectors.scan'),
  },
  checks: {
    kinds: [...webCheckKinds],
    validate: pending('checks.validate'),
    violated: pending('checks.violated'),
  },
  replay: { replay: pending('replay.replay') },
  generateTest: webTestGenerator,
  profile: { load: pending('profile.load'), testDataFile: pending('profile.testDataFile') },
  testRunner: webTestRunner,
  personas: { roster: EXPLORER_PERSONAS, brief: pending('personas.brief') },
  findingKinds: webFindingKinds,
  sweepVisit: webSweepVisit,
  reset: webReset,
  exportTarget: webExportTarget,
  errors: webErrors,
  report: webReportFormat,
};
