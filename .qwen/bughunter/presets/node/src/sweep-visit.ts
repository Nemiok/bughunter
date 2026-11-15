import { runSweep as runCoreSweep } from '@bughunter/core';
import type { FindingDraft, Session, Signal, SweepResult, SweepVisit } from '@bughunter/core';

import { sameValue } from './checks.ts';
import { nodeFindingKinds, scenarioWidget } from './finding-kinds.ts';
import { nodeInventory, targetOfRequest } from './inventory.ts';
import { readPointer } from './json-pointer.ts';
import { loadNodeProfile } from './profile.ts';
import { nodeReset } from './reset.ts';
import { nodeSession, performRequest, responseHash, sessionView } from './session.ts';
import type { CapturedResponse, NodeActInput, NodeSessionHandle } from './session.ts';
import type { NodeScenario } from './types.ts';

/**
 * Сессия обхода: те же запросы, но без журнала — находка становится журналом только при промоции.
 * Интерактивные действия запрещены: обход детерминирован и умеет ровно заявленные сценарии.
 */
export const nodeSweepSession: Session = {
  open: async (input) => {
    const handle = await nodeSession.open(input);
    return {
      ...handle,
      act: async (): Promise<never> => {
        throw new Error('SWEEP_SESSION_READ_ONLY: детерминированный обход не совершает действий вне сценариев');
      },
    };
  },
};

function requestOf(scenario: NodeScenario): NodeActInput {
  return {
    method: scenario.request.method.toUpperCase() as NodeActInput['method'],
    path: scenario.request.path,
    ...(scenario.request.body === undefined ? {} : { body: scenario.request.body }),
    ...(scenario.request.headers === undefined ? {} : { headers: scenario.request.headers }),
  };
}

/**
 * Визит одной цели: прогнать её сценарии и сравнить ответ с объявленным ожиданием. Ожидание
 * в конфиге — это контракт приложения, поэтому обход находит нарушение без модели. Принадлежность
 * сценария цели определяется по объявленным шаблонам профиля, а не угадывается по виду пути.
 */
export const nodeSweepVisit: SweepVisit = {
  visit: async ({ target, handle, stateDir }): Promise<FindingDraft[]> => {
    const view = sessionView(handle);
    const profile = await loadNodeProfile(stateDir, view.config.profile);
    const drafts: FindingDraft[] = [];
    for (const scenario of view.config.scenarios) {
      const belongs = targetOfRequest(profile.endpoints, scenario.request.method, scenario.request.path);
      if (belongs === undefined) {
        throw new Error(`SCENARIO_INVALID: ${scenarioWidget(scenario)} не подходит ни к одному эндпоинту профиля`);
      }
      if (belongs !== target) continue;
      // Сброс перед каждым сценарием: наблюдения не должны зависеть друг от друга. Отказ сброса
      // здесь не находка — core уже отметил его один раз на прогон.
      await nodeReset.apply(handle).catch(() => undefined);
      const { response, signals } = await performRequest(
        handle as NodeSessionHandle,
        requestOf(scenario),
        view.config,
        { journal: false },
      );
      drafts.push(...findingsFor(target, scenario, response, signals));
    }
    return drafts;
  },
};

function findingsFor(
  target: string,
  scenario: NodeScenario,
  response: CapturedResponse,
  signals: Signal[],
): FindingDraft[] {
  const widget = scenarioWidget(scenario);
  const responseHashes = [responseHash(response)];
  const drafts: FindingDraft[] = [];
  const add = (kind: string, detail: string): void => {
    drafts.push({ targetRef: target, widget, kind, detail, responseHashes });
  };
  const expected = scenario.expect;

  if (response.error !== undefined) {
    add('request-failed', `${widget}: ${response.error}`);
  } else {
    if (expected?.status !== undefined && response.status !== expected.status) {
      add('status-unexpected', `${widget}: ожидался статус ${expected.status}, получен ${response.status}`);
    } else if (expected?.status === undefined && response.status >= 500) {
      add('status-unexpected', `${widget}: статус ${response.status} при отсутствии объявленного ожидания`);
    }
    for (const assertion of expected?.jsonPath ?? []) {
      let actual: unknown;
      try {
        actual = readPointer(response.body, assertion.pointer);
      } catch {
        add('expectation-mismatch', `${widget}: ${assertion.pointer} отсутствует в ответе`);
        continue;
      }
      if (!sameValue(actual, assertion.expected)) {
        add('expectation-mismatch',
          `${widget}: ${assertion.pointer} = ${JSON.stringify(actual)}, ожидалось ${JSON.stringify(assertion.expected)}`);
      }
    }
  }

  const body = signals.filter((signal) => signal.kind === 'anomaly' || signal.kind === 'stack');
  if (body.length > 0) {
    add('body-anomaly', `${widget}: ${body.map((signal) => signal.message).join('; ')}`);
  }
  return drafts;
}

export async function runSweep(input: {
  runId: string;
  stateDir: string;
  limit?: number;
  cursor?: number;
}): Promise<SweepResult> {
  return runCoreSweep({
    ...input,
    inventory: nodeInventory,
    session: nodeSweepSession,
    visit: nodeSweepVisit,
    reset: nodeReset,
    findingKinds: nodeFindingKinds,
  });
}
