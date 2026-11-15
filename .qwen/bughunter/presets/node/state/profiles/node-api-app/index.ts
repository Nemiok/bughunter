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
      description: 'Контрольный эндпоинт: всегда 200 и {status:"ok"}',
    },
    {
      method: 'GET',
      template: '/orders',
      samplePath: '/orders',
      description: 'Список заказов и итог в копейках',
    },
    {
      method: 'POST',
      template: '/orders',
      samplePath: '/orders',
      description: 'Создать заказ: тело {qty}, цена за штуку зависит от тарифа',
    },
    {
      method: 'GET',
      template: '/orders/:id',
      samplePath: '/orders/ord-1',
      description: 'Один заказ по идентификатору',
    },
    {
      method: 'POST',
      template: '/payments',
      samplePath: '/payments',
      description: 'Списать платёж: тело {orderId, amountCents, idempotencyKey}',
    },
  ],
};

export default profile;
