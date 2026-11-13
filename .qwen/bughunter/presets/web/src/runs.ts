import {
  createRun as createCoreRun,
  finishRun as finishCoreRun,
  leaseNextExploration as leaseNextCoreExploration,
} from '@bughunter/core';
import type { Config, ExploreNextResult, Run, Scope } from '@bughunter/core';

import { EXPLORER_PERSONAS } from './personas.ts';
import { webReportFormat } from './report-format.ts';

/**
 * Обёртки с веб-значениями по умолчанию: ростер персон и формат отчёта принадлежат пресету,
 * поэтому вызывающий код их не передаёт.
 */
export function createRun(
  scope: Scope,
  route: string | undefined,
  deps: { config: Config; projectRoot: string; stateDir: string },
): Promise<Run> {
  return createCoreRun(scope, route, { ...deps, personas: EXPLORER_PERSONAS });
}

export function leaseNextExploration(
  runId: string,
  options: { route?: string; staleLeaseMs?: number; now?: () => number; keepLeaseIds?: ReadonlySet<string> },
  stateDir: string,
): Promise<ExploreNextResult> {
  return leaseNextCoreExploration(runId, { personas: EXPLORER_PERSONAS, ...options }, stateDir);
}

export function finishRun(runId: string, stateDir: string): Promise<{ report: string }> {
  return finishCoreRun(runId, stateDir, webReportFormat);
}
