import type { Preset } from '@bughunter/core';

import { cliChecks } from './checks.ts';
import { cliConfigSchema } from './config.ts';
import { cliDetectors } from './detectors.ts';
import { cliErrors } from './errors.ts';
import { cliExportTarget, cliTestGenerator } from './export-cli.ts';
import { cliFindingKinds } from './finding-kinds.ts';
import { cliInventory } from './inventory.ts';
import { cliPersonas } from './personas.ts';
import { cliProfile } from './profile.ts';
import { createCliReplay } from './replay.ts';
import { cliReportFormat } from './report-format.ts';
import { cliReset } from './reset.ts';
import { cliSession } from './session.ts';
import { cliSnapshot } from './snapshot.ts';
import { cliSweepVisit } from './sweep-visit.ts';
import { cliTestRunner } from './test-runner.ts';

export const cliPreset: Preset = {
  name: 'cli',
  configSchema: cliConfigSchema,
  inventory: cliInventory,
  session: cliSession,
  snapshot: cliSnapshot,
  detectors: cliDetectors,
  checks: cliChecks,
  // Экземпляр, а не модульная константа: `abort()` по дедлайну core закрывает сессию именно
  // этого воспроизведения и не задевает параллельное.
  replay: createCliReplay(),
  generateTest: cliTestGenerator,
  profile: cliProfile,
  testRunner: cliTestRunner,
  personas: cliPersonas,
  findingKinds: cliFindingKinds,
  sweepVisit: cliSweepVisit,
  reset: cliReset,
  exportTarget: cliExportTarget,
  errors: cliErrors,
  report: cliReportFormat,
};
