import {
  createRun as createCoreRun,
  finishRun as finishCoreRun,
  leaseNextExploration as leaseNextCoreExploration,
  promoteFindingToCandidate as promoteCoreFinding,
} from '@bughunter/core';
import type { Candidate, ExploreNextResult, Run, Scope } from '@bughunter/core';
import type { WebConfig as Config } from './config.ts';

import { webExportTarget } from './export-playwright.ts';
import { webFindingKinds } from './finding-kinds.ts';
import { EXPLORER_PERSONAS } from './personas.ts';
import { webReportFormat } from './report-format.ts';

/**
 * Обёртки с веб-значениями по умолчанию: ростер персон и формат отчёта принадлежат пресету,
 * поэтому вызывающий код их не передаёт.
 */
export function createRun(
  scope: Scope,
  target: string | undefined,
  deps: { config: Config; projectRoot: string; stateDir: string },
): Promise<Run> {
  return createCoreRun(scope, target, { ...deps, personas: EXPLORER_PERSONAS, targets: deps.config.routes });
}

export function leaseNextExploration(
  runId: string,
  options: { target?: string; staleLeaseMs?: number; now?: () => number; keepLeaseIds?: ReadonlySet<string> },
  stateDir: string,
): Promise<ExploreNextResult> {
  return leaseNextCoreExploration(runId, { personas: EXPLORER_PERSONAS, ...options }, stateDir);
}

export function finishRun(runId: string, stateDir: string): Promise<{ report: string }> {
  return finishCoreRun(runId, stateDir, webReportFormat, webExportTarget.kind);
}

export function promoteFindingToCandidate(input: {
  runId: string;
  findingId: string;
  title: string;
  expected: string;
  actual: string;
  check: Candidate['check'];
  stateDir: string;
}): Promise<{ candidateId: string }> {
  return promoteCoreFinding({ ...input, findingKinds: webFindingKinds });
}
