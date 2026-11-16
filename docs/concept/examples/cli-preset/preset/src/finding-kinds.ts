import { randomUUID } from 'node:crypto';

import type { Finding, FindingKinds, SyntheticStep } from '@bughunter/core';

import { loadCliConfig } from './config.ts';
import type { CliScenario, CliStep } from './types.ts';

export const cliFindingKindsList = [
  'execution-failed',
  'exit-code-unexpected',
  'output-mismatch',
  'output-anomaly',
  'reset-unsupported',
] as const;

/** `widget` находки обхода — конкретная заявка сценария, а не шаблон цели. */
export function scenarioWidget(scenario: CliScenario): string {
  return `${scenario.name}: ${scenario.argv.join(' ')}`;
}

export const cliFindingKinds: FindingKinds = {
  kinds: [...cliFindingKindsList],
  /**
   * Шаг журнала для промоции находки — тот же запуск, который сделал обход. `argv` и подготовка
   * берутся из сценария в конфиге: источник правды один, поэтому находка повторяется дословно.
   */
  syntheticStep: async (finding: Finding, stateDir: string): Promise<SyntheticStep> => {
    const config = await loadCliConfig(stateDir);
    const scenario = config.scenarios.find((candidate) => scenarioWidget(candidate) === finding.widget);
    if (scenario === undefined) throw new Error(`SCENARIO_INVALID: ${finding.widget ?? '<без сценария>'}`);
    const step: CliStep = {
      id: randomUUID(),
      kind: 'command',
      timestamp: new Date().toISOString(),
      targetRef: finding.targetRef,
      argv: [...scenario.argv],
      ...(scenario.setup === undefined ? {} : { setup: scenario.setup.map((entry) => [...entry.argv]) }),
    };
    return { step, target: finding.targetRef };
  },
};
