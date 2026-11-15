import type { Reset, SessionHandle } from '@bughunter/core';

import { performRequest, sessionView } from './session.ts';
import type { NodeActInput, NodeSessionHandle } from './session.ts';

/**
 * Сброс стенда — аналог `mock-endpoint` в веб-пресете: объявленный в конфиге запрос возвращает
 * приложение в исходное состояние. Без рецепта сброс невозможен, и это видно в находках:
 * «состояние не сброшено» и «сброшено» — разные утверждения о цели. В журнал сброс не пишется:
 * это не действие исследователя.
 */
export const nodeReset: Reset = {
  // Наличие рецепта знает только конфиг, а он читается в сессии: хук объявлен поддерживаемым,
  // а отсутствие рецепта всплывает как RESET_UNSUPPORTED и становится находкой обхода.
  supported: true,
  apply: async (handle: SessionHandle): Promise<void> => {
    const view = sessionView(handle);
    const reset = view.config.reset;
    if (reset === null) throw new Error('RESET_UNSUPPORTED: в конфиге нет reset — стенд не возвращается в исходное состояние');
    const { response } = await performRequest(
      handle as NodeSessionHandle,
      { method: reset.method.toUpperCase() as NodeActInput['method'], path: reset.path },
      view.config,
      { journal: false },
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`RESET_FAILED: ${reset.method.toUpperCase()} ${reset.path} → ${response.status}`);
    }
  },
};
