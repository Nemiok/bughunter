import type { Preset } from '@bughunter/core';

import { nodeChecks } from './checks.ts';
import { nodeConfigSchema } from './config.ts';
import { nodeDetectors } from './detectors.ts';
import { nodeErrors } from './errors.ts';
import { nodeExportTarget, nodeTestGenerator } from './export-vitest.ts';
import { nodeFindingKinds } from './finding-kinds.ts';
import { nodeInventory } from './inventory.ts';
import { nodePersonas } from './personas.ts';
import { nodeProfile } from './profile.ts';
import { createNodeReplay } from './replay.ts';
import { nodeReportFormat } from './report-format.ts';
import { nodeReset } from './reset.ts';
import { nodeSession } from './session.ts';
import { nodeSnapshot } from './snapshot.ts';
import { nodeSweepVisit } from './sweep-visit.ts';
import { nodeTestRunner } from './test-runner.ts';

export const nodePreset: Preset = {
  name: 'node',
  configSchema: nodeConfigSchema,
  inventory: nodeInventory,
  session: nodeSession,
  snapshot: nodeSnapshot,
  detectors: nodeDetectors,
  checks: nodeChecks,
  // Экземпляр, а не модульная константа: `abort()` по дедлайну core закрывает сессию именно
  // этого воспроизведения и не задевает параллельное.
  replay: createNodeReplay(),
  generateTest: nodeTestGenerator,
  profile: nodeProfile,
  testRunner: nodeTestRunner,
  personas: nodePersonas,
  findingKinds: nodeFindingKinds,
  sweepVisit: nodeSweepVisit,
  reset: nodeReset,
  exportTarget: nodeExportTarget,
  errors: nodeErrors,
  report: nodeReportFormat,
};
