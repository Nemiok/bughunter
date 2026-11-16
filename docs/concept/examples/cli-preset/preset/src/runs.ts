import {
  createRun as createCoreRun,
  finishRun as finishCoreRun,
  leaseNextExploration as leaseNextCoreExploration,
  promoteFindingToCandidate as promoteCoreFinding,
} from '@bughunter/core';
import type { Check, ExploreNextResult, Run, Scope } from '@bughunter/core';

import type { CliConfig } from './config.ts';
import { cliExportTarget } from './export-cli.ts';
import { cliFindingKinds } from './finding-kinds.ts';
import { cliInventory } from './inventory.ts';
import { cliPersonas } from './personas.ts';
import { cliReportFormat } from './report-format.ts';

/** Обёртки с CLI-значениями по умолчанию: ростер, инвентарь и формат отчёта — знание пресета. */
export async function createRun(
  scope: Scope,
  target: string | undefined,
  deps: { config: CliConfig; projectRoot: string; stateDir: string },
): Promise<Run> {
  return createCoreRun(scope, target, {
    ...deps,
    personas: cliPersonas.roster,
    targets: await cliInventory.list(deps.stateDir),
  });
}

export function leaseNextExploration(
  runId: string,
  options: { target?: string; staleLeaseMs?: number; now?: () => number; keepLeaseIds?: ReadonlySet<string> },
  stateDir: string,
): Promise<ExploreNextResult> {
  return leaseNextCoreExploration(runId, { personas: cliPersonas.roster, ...options }, stateDir);
}

export function finishRun(runId: string, stateDir: string): Promise<{ report: string }> {
  return finishCoreRun(runId, stateDir, cliReportFormat, cliExportTarget.kind);
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
  return promoteCoreFinding({ ...input, findingKinds: cliFindingKinds });
}
