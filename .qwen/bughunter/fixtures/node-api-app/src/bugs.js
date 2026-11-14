import { connect } from 'node:net';

import { db } from './db.js';

/**
 * Реестр засеянных дефектов: источник правды — этот массив, `SEEDED.md` — его человеческое зеркало.
 * `detectableBy` честная: «ожидаемый пропуск» означает, что сегодня Bughunter такой баг не находит.
 */
export const SEEDED = [
  {
    id: 'N1',
    endpoint: 'POST /orders',
    expected: '400 и внятная ошибка валидации количества',
    actual: '500 и стек необработанного отклонения в теле ответа',
    detectableBy: 'детектор: статус 5xx',
  },
  {
    id: 'N2',
    endpoint: 'POST /orders',
    expected: 'отрицательное количество отклоняется до создания заказа',
    actual: '200 и отрицательный итог заказа',
    detectableBy: 'check: jsonPath — totalCents созданного заказа',
  },
  {
    id: 'N3',
    endpoint: 'GET /orders/:id',
    expected: '404 для неизвестного id',
    actual: '200 и null в теле',
    detectableBy: 'check: status — 404 для несуществующего заказа',
  },
  {
    id: 'N4',
    endpoint: 'POST /payments',
    expected: 'один ключ идемпотентности — одно списание',
    actual: 'повторный запрос с тем же ключом списывает деньги второй раз',
    detectableBy: 'check: jsonPath — balanceCents после двух одинаковых запросов',
  },
  {
    id: 'N5',
    endpoint: 'GET /orders',
    expected: 'итог списка называется одинаково в каждом ответе',
    actual: 'ответы чередуют поля totalCents и total',
    detectableBy: 'ожидаемый пропуск: нужен мини-оракул схемы ответа (фаза C)',
  },
  {
    id: 'N6',
    endpoint: 'POST /payments',
    expected: '502 и код сбоя шлюза без внутренних подробностей',
    actual: 'в теле ECONNREFUSED и стек вызовов',
    detectableBy: 'детектор: аномальный токен в теле ответа',
  },
];

export const PRICE_TIERS = [
  { from: -Infinity, to: 9, unitPriceCents: 1200 },
  { from: 10, to: 99, unitPriceCents: 1000 },
  { from: 100, to: Infinity, unitPriceCents: 800 },
];

/**
 * N1: количество никак не проверяется, и нечисловое значение не попадает ни в один тариф —
 * `tier` остаётся `undefined`, чтение поля отклоняется, а маршрут отклонение не перехватывает.
 * N2: отрицательное количество попадает в первый тариф, поэтому заказ создаётся с отрицательным
 * итогом и статусом 200 — валидации нет и для осмысленных значений.
 */
export function unitPriceCents(qty) {
  const tier = PRICE_TIERS.find((candidate) => qty >= candidate.from && qty <= candidate.to);
  return tier.unitPriceCents;
}

/**
 * N5: итог списка заказов отдают два разных обработчика, и они не договорились о имени поля —
 * чётные ответы уходят с `total`, нечётные с `totalCents`. Чередование привязано к счётчику
 * ответов, поэтому воспроизводимо и не зависит от данных.
 */
export function ordersEnvelope(orders) {
  const totalCents = orders.reduce((sum, order) => sum + order.totalCents, 0);
  return db.countOrdersResponse() % 2 === 0
    ? { orders, total: totalCents }
    : { orders, totalCents };
}

/** N3: неизвестный id — не ошибка, а «пусто»: маршрут отдаёт 200 и null вместо 404. */
export function orderOrNull(id) {
  return db.orderById(id) ?? null;
}

/**
 * N4: ключ идемпотентности принимается, но ни с чем не сверяется — каждый вызов создаёт новое
 * списание. Повторный запрос тем же ключом списывает деньги второй раз.
 */
export function chargeIgnoringIdempotencyKey({ orderId, amountCents, idempotencyKey }) {
  return db.charge({ orderId, amountCents, idempotencyKey });
}

/** Платёжный шлюз учебного стенда: по умолчанию никто не слушает, поэтому сбой детерминирован. */
export const PAYMENT_GATEWAY = {
  host: '127.0.0.1',
  port: Number(process.env.PAYMENT_GATEWAY_PORT ?? 9411),
};

export function authorizeWithGateway(payment) {
  return new Promise((resolveAuthorized, rejectAuthorized) => {
    const socket = connect(PAYMENT_GATEWAY, () => {
      socket.end(`${JSON.stringify(payment)}\n`);
      resolveAuthorized({ status: 'authorized', chargeId: payment.id });
    });
    socket.setTimeout(1000, () => socket.destroy(new Error('gateway timeout')));
    socket.once('error', rejectAuthorized);
  });
}
