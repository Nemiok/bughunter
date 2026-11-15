import type { Reset, SessionHandle } from '@bughunter/core';

import { performRequest, sessionView } from './session.ts';
import type { NodeActInput, NodeSessionHandle } from './session.ts';

/**
 * Сброс стенда — аналог `mock-endpoint` в веб-пресете: объявленный в конфиге запрос возвращает
 * приложение в исходное состояние. Без него повтор кандидата и обход начинались бы на грязи,
 * оставленной прошлым прогоном. В журнал не пишется: это не действие исследователя.
 */
export const nodeReset: Reset = {
  supported: true,
  apply: async (handle: SessionHandle): Promise<void> => {
    const view = sessionView(handle);
    const reset = view.config.reset;
    if (reset === null) return;
    await performRequest(
      handle as NodeSessionHandle,
      { method: reset.method.toUpperCase() as NodeActInput['method'], path: reset.path },
      view.config,
      { journal: false },
    );
  },
};
