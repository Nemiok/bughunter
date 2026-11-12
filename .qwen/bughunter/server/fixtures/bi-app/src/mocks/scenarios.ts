export const SCENARIOS = ['normal', 'latency', 'error500', 'empty', 'big'] as const;

export type ScenarioName = (typeof SCENARIOS)[number];

/** Флаг сценария в storage: переключение сценария — это флаг плюс перезагрузка (§5.4 дизайн-дока). */
export const SCENARIO_KEY = 'bhScenario';

/** Служебный эндпоинт сброса: возвращает приложение к seed-сценарию. */
export const RESET_ENDPOINT = '/__bh/reset';

export function isScenario(value: string | null): value is ScenarioName {
  return value !== null && (SCENARIOS as readonly string[]).includes(value);
}

/**
 * Значение флага, не совпадающее с именем сценария, означает «сброшено»: Bughunter пишет
 * в этот ключ метку времени, и приложение обязано вернуться к seed-данным, а не упасть.
 */
export function currentScenario(): ScenarioName {
  try {
    const value = window.localStorage.getItem(SCENARIO_KEY);
    return isScenario(value) ? value : 'normal';
  } catch {
    return 'normal';
  }
}
