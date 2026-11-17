import { randomUUID } from 'node:crypto';

import type { Finding, FindingKinds, SyntheticStep } from '@bughunter/core';

import { loadNodeConfig } from './config.ts';
import type { NodeScenario, NodeStep } from './types.ts';

export const nodeFindingKindsList = [
  'request-failed',
  'status-unexpected',
  'body-anomaly',
  'expectation-mismatch',
  'reset-unsupported',
] as const;

/** Ярлык находки обхода — заявка сценария: «<имя сценария> <МЕТОД> <путь>». */
export function scenarioLabel(scenario: NodeScenario): string {
  return `${scenario.name} ${scenario.request.method.toUpperCase()} ${scenario.request.path}`;
}

export const nodeFindingKinds: FindingKinds = {
  kinds: [...nodeFindingKindsList],
  /**
   * Шаг журнала для промоции находки — тот же запрос, который сделал обход. Тело и заголовки
   * берутся из сценария в конфиге: источник правды один, поэтому находка повторяется дословно.
   */
  syntheticStep: async (finding: Finding, stateDir: string): Promise<SyntheticStep> => {
    const config = await loadNodeConfig(stateDir);
    const scenario = config.scenarios.find((candidate) => scenarioLabel(candidate) === finding.subject);
    if (scenario === undefined) throw new Error(`SCENARIO_INVALID: ${finding.subject ?? '<без сценария>'}`);
    const step: NodeStep = {
      id: randomUUID(),
      kind: 'act',
      timestamp: new Date().toISOString(),
      targetRef: finding.targetRef,
      method: scenario.request.method.toUpperCase(),
      path: scenario.request.path,
      ...(scenario.request.body === undefined ? {} : { body: scenario.request.body }),
      ...(scenario.request.headers === undefined ? {} : { headers: scenario.request.headers }),
    };
    return { step, target: finding.targetRef };
  },
};
