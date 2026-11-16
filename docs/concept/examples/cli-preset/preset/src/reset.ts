import type { Reset, SessionHandle } from '@bughunter/core';

import { deleteSessionDatabase, sessionView } from './session.ts';

/**
 * Сброс базы — аналог `mock-endpoint` в веб-пресете: удаление файла возвращает приложение
 * к пустому состоянию. Рецепт объявлен в конфиге; без него сброс невозможен, и это находка
 * обхода, а не молчаливое продолжение на грязных данных.
 */
export const cliReset: Reset = {
  // Наличие рецепта знает конфиг, а он читается в сессии: хук объявлен поддерживаемым,
  // отсутствие рецепта всплывает как RESET_UNSUPPORTED.
  supported: true,
  apply: async (handle: SessionHandle): Promise<void> => {
    const reset = sessionView(handle).config.reset;
    if (reset === null) throw new Error('RESET_UNSUPPORTED: в конфиге нет reset — база не возвращается в исходное состояние');
    try {
      await deleteSessionDatabase(handle);
    } catch (error) {
      throw new Error(`RESET_FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
};
