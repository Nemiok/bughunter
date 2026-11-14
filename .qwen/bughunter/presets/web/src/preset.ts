import type { Preset } from '@bughunter/core';

import { webChecks } from './checks.ts';
import { webConfigSchema } from './config.ts';
import { webDetectors } from './detectors/index.ts';
import { webErrors } from './errors.ts';
import { webExportTarget, webTestGenerator } from './export-playwright.ts';
import { webFindingKinds } from './finding-kinds.ts';
import { webPersonas } from './personas.ts';
import { webProfile } from './profile/load.ts';
import { webReportFormat } from './report-format.ts';
import { createWebReplay } from './reproduce.ts';
import { webReset } from './reset.ts';
import { webSession } from './session-handle.ts';
import { webSnapshot } from './snapshot.ts';
import { webInventory, webSweepVisit } from './sweep-visit.ts';
import { webTestRunner } from './test-runner.ts';

export const webPreset: Preset = {
  name: 'web',
  configSchema: webConfigSchema,
  inventory: webInventory,
  session: webSession,
  snapshot: webSnapshot,
  detectors: webDetectors,
  checks: webChecks,
  // Экземпляр, а не модульная константа: `abort()` по дедлайну core закрывает менеджер сессий
  // этого воспроизведения и не задевает параллельное.
  replay: createWebReplay(),
  generateTest: webTestGenerator,
  profile: webProfile,
  testRunner: webTestRunner,
  personas: webPersonas,
  findingKinds: webFindingKinds,
  sweepVisit: webSweepVisit,
  reset: webReset,
  exportTarget: webExportTarget,
  errors: webErrors,
  report: webReportFormat,
};
