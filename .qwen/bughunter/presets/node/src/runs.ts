import {
  createRun as createCoreRun,
  finishRun as finishCoreRun,
  leaseNextExploration as leaseNextCoreExploration,
  promoteFindingToCandidate as promoteCoreFinding,
} from '@bughunter/core';
import type { Check, ExploreNextResult, Run, Scope } from '@bughunter/core';

import { nodeExportTarget } from './export-vitest.ts';
import { nodeFindingKinds } from './finding-kinds.ts';
import { nodeInventory } from './inventory.ts';
import { nodePersonas } from './personas.ts';
import { nodeReportFormat } from './report-format.ts';
import type { NodeConfig } from './config.ts';

/**
 * Обёртки с node-значениями по умолчанию: ростер персон, инвентарь целей и формат отчёта
 * принадлежат пресету, поэтому вызывающий код их не передаёт.
 */
export async function createRun(
  scope: Scope,
  target: string | undefined,
  deps: { config: NodeConfig; projectRoot: string; stateDir: string },
): Promise<Run> {
  return createCoreRun(scope, target, {
    ...deps,
    personas: nodePersonas.roster,
    targets: await nodeInventory.list(deps.stateDir),
  });
}

export function leaseNextExploration(
  runId: string,
  options: { target?: string; staleLeaseMs?: number; now?: () => number; keepLeaseIds?: ReadonlySet<string> },
  stateDir: string,
): Promise<ExploreNextResult> {
  return leaseNextCoreExploration(runId, { personas: nodePersonas.roster, ...options }, stateDir);
}

export function finishRun(runId: string, stateDir: string): Promise<{ report: string }> {
  return finishCoreRun(runId, stateDir, nodeReportFormat, nodeExportTarget.kind);
}

export function promoteFindingToCandidate(input: {
  runId: string;
  findingId: string;
  title: string;
  expected: string;
  actual: string;
  check?: Check;
  stateDir: string;
}): Promise<{ candidateId: string }> {
  return promoteCoreFinding({ ...input, findingKinds: nodeFindingKinds });
}
