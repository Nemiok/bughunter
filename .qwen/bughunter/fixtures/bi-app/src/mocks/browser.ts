import { setupWorker } from 'msw/browser';
import { buildHandlers } from './handlers.ts';
import { currentScenario, RESET_ENDPOINT, SCENARIO_KEY, type ScenarioName } from './scenarios.ts';

export type RecordedResponse = { url: string; status: number; body: unknown; at: string };

declare global {
  interface Window {
    /** Запасной источник эталона (§5.4): всё, что MSW отдал приложению. */
    __bhResponses: RecordedResponse[];
    __BHScenario: { current(): ScenarioName; set(name: ScenarioName): void };
    __bhMockError?: string;
  }
}

export const worker = setupWorker(...buildHandlers(currentScenario()));

export async function startMocks(): Promise<void> {
  window.__bhResponses = [];
  // В MSW 3 событие называется response:mocked (в MSW 2 было response:mock).
  // Хук регистрируется до start(), иначе первый же ответ приложения окажется неучтённым.
  worker.events.on('response:mocked', ({ request, response }) => {
    const entry: RecordedResponse = {
      url: request.url,
      status: response.status,
      body: undefined,
      at: new Date().toISOString(),
    };
    window.__bhResponses.push(entry);
    void response.clone().text().then((text) => {
      try {
        entry.body = JSON.parse(text) as unknown;
      } catch {
        entry.body = text;
      }
    });
    if (new URL(request.url).pathname === RESET_ENDPOINT) {
      window.localStorage.removeItem(SCENARIO_KEY);
      worker.use(...buildHandlers('normal'));
    }
  });

  await worker.start({ quiet: true });

  window.__BHScenario = {
    current: currentScenario,
    set: (name: ScenarioName) => {
      window.localStorage.setItem(SCENARIO_KEY, name);
      worker.use(...buildHandlers(name));
    },
  };
}
