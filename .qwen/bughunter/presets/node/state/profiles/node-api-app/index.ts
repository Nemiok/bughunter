import type { NodeProfile } from '../../../src/profile.ts';

/**
 * Профиль учебного стенда `fixtures/node-api-app`. Инвентарь эндпоинтов — источник целей для
 * исследования и обхода; засевка дефектов описана в `fixtures/node-api-app/SEEDED.md`.
 */
const profile: NodeProfile = {
  endpoints: [
    {
      method: 'GET',
      template: '/health',
      samplePath: '/health',
      description: 'Контрольный эндпоинт: 200 и {"status":"ok"}',
    },
    {
      method: 'GET',
      template: '/orders',
      samplePath: '/orders',
      description: 'Список заказов: 200 и {"orders":[…],"totalCents":N} — итог в копейках объявлен полем totalCents',
    },
    {
      method: 'POST',
      template: '/orders',
      samplePath: '/orders',
      description: 'Создать заказ: тело {"qty":<число>}; успех — 200 и объект заказа {"id","qty","totalCents","createdAt"}; невалидное или отрицательное количество — 400',
    },
    {
      method: 'GET',
      template: '/orders/:id',
      samplePath: '/orders/ord-1',
      description: 'Один заказ по идентификатору: 200 и объект заказа; неизвестный идентификатор — 404',
    },
    {
      method: 'POST',
      template: '/payments',
      samplePath: '/payments',
      description: 'Списать платёж: тело {"orderId","amountCents","idempotencyKey"}; успех — 200 и {"status":"authorized","balanceCents"}; один ключ идемпотентности — одно списание',
    },
  ],
};

export default profile;
