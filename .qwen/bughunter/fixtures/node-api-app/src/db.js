/**
 * In-memory хранилище учебного API. `reset()` возвращает исходное состояние — его дёргает
 * `POST /__reset`, поэтому каждый прогон начинает с одних и тех же данных.
 */
const initialState = () => ({
  orders: [
    { id: 'ord-1', qty: 2, totalCents: 2400, createdAt: '2026-11-01T10:00:00.000Z' },
    { id: 'ord-2', qty: 5, totalCents: 6000, createdAt: '2026-11-02T11:00:00.000Z' },
    { id: 'ord-3', qty: 12, totalCents: 12000, createdAt: '2026-11-03T12:00:00.000Z' },
  ],
  payments: [
    {
      id: 'pay-1', orderId: 'ord-1', amountCents: 2400, idempotencyKey: 'key-initial',
      status: 'charged', chargedAt: '2026-11-03T12:05:00.000Z',
    },
  ],
  balanceCents: 10_000,
  /** Сколько раз отдан список заказов: из этого счётчика растёт чередование схемы (см. bugs.js). */
  ordersResponses: 0,
});

export const db = {
  state: initialState(),

  reset() {
    db.state = initialState();
  },

  listOrders() {
    return db.state.orders;
  },

  orderById(id) {
    return db.state.orders.find((order) => order.id === id);
  },

  createOrder({ qty, totalCents }) {
    const order = {
      id: `ord-${db.state.orders.length + 1}`,
      qty,
      totalCents,
      createdAt: new Date().toISOString(),
    };
    db.state.orders.push(order);
    return order;
  },

  charge({ orderId, amountCents, idempotencyKey }) {
    const payment = {
      id: `pay-${db.state.payments.length + 1}`,
      orderId,
      amountCents,
      idempotencyKey,
      status: 'charged',
      chargedAt: new Date().toISOString(),
    };
    db.state.payments.push(payment);
    db.state.balanceCents -= amountCents;
    return payment;
  },

  countOrdersResponse() {
    db.state.ordersResponses += 1;
    return db.state.ordersResponses;
  },
};
