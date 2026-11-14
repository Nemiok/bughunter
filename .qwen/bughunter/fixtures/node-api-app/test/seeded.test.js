import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SEEDED } from '../src/bugs.js';
import { createApp } from '../src/server.js';

let server;
let baseUrl;

beforeAll(async () => {
  server = createApp();
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolveClose) => server.close(resolveClose));
});

beforeEach(async () => {
  await call('POST', '/__reset');
});

async function call(method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text === '' ? null : JSON.parse(text);
  } catch {
    parsed = null;
  }
  return { status: response.status, contentType: response.headers.get('content-type'), text, body: parsed };
}

const payment = { orderId: 'ord-1', amountCents: 1000, idempotencyKey: 'key-1' };

describe('засеянные дефекты присутствуют', () => {
  it('N1: нечисловое количество отклоняется необработанной ошибкой и отдаёт стек', async () => {
    const created = await call('POST', '/orders', { qty: 'abc' });
    expect(created.status).toBe(500);
    expect(created.text).toMatch(/unitPriceCents/);
    expect(created.text).toMatch(/\\n\s+at /);
  });

  it('N2: отрицательное количество принимается и даёт бессмысленный итог', async () => {
    const created = await call('POST', '/orders', { qty: -5 });
    expect(created.status).toBe(200);
    expect(created.body.totalCents).toBe(-6000);
    expect(created.body.qty).toBe(-5);
  });

  it('N3: неизвестный заказ отдаётся как 200 с null вместо 404', async () => {
    const unknown = await call('GET', '/orders/ord-unknown');
    expect(unknown.status).toBe(200);
    expect(unknown.body).toBe(null);
  });

  it('N4: повторный платёж с тем же ключом идемпотентности списывает второй раз', async () => {
    const first = await call('POST', '/payments', payment);
    const second = await call('POST', '/payments', payment);
    expect(first.body.chargeId).not.toBe(second.body.chargeId);
    expect(second.body.balanceCents).toBe(first.body.balanceCents - payment.amountCents);
    expect(second.body.balanceCents).toBe(10000 - 2 * payment.amountCents);
  });

  it('N5: схема списка заказов разъезжается между запросами', async () => {
    const first = await call('GET', '/orders');
    const second = await call('GET', '/orders');
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(Object.keys(first.body).filter((key) => key.startsWith('total'))).toEqual(['totalCents']);
    expect(Object.keys(second.body).filter((key) => key.startsWith('total'))).toEqual(['total']);
    expect(first.body.totalCents).toBe(second.body.total);
  });

  it('N6: сбой платёжного шлюза отдаёт внутренний текст ошибки', async () => {
    const failed = await call('POST', '/payments', payment);
    expect(failed.status).toBe(502);
    expect(failed.text).toMatch(/ECONNREFUSED/);
    expect(failed.text).toMatch(/\\n\s+at /);
  });
});

describe('контрольный эндпоинт и реестр', () => {
  it('GET /health всегда отвечает 200 и {status:"ok"} как JSON', async () => {
    const health = await call('GET', '/health');
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ status: 'ok' });
    expect(health.contentType).toMatch(/application\/json/);
  });

  it('невалидный JSON тела отклоняется как 400 без стека', async () => {
    const response = await fetch(`${baseUrl}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ "qty": ',
    });
    const text = await response.text();
    expect(response.status).toBe(400);
    expect(text).not.toMatch(/\\n\s+at /);
  });

  it('сброс возвращает исходное состояние', async () => {
    await call('POST', '/orders', { qty: 3 });
    await call('POST', '/__reset');
    const orders = await call('GET', '/orders');
    expect(orders.body.orders).toHaveLength(3);
  });

  it('реестр SEEDED описывает шесть дефектов и зеркалится в SEEDED.md', async () => {
    assert.deepEqual(SEEDED.map((seeded) => seeded.id), ['N1', 'N2', 'N3', 'N4', 'N5', 'N6']);
    for (const seeded of SEEDED) {
      for (const field of ['endpoint', 'expected', 'actual', 'detectableBy']) {
        assert.ok(typeof seeded[field] === 'string' && seeded[field].length > 0, `${seeded.id}.${field}`);
      }
    }
    const mirror = await readFile(join(import.meta.dirname, '..', 'SEEDED.md'), 'utf8');
    for (const seeded of SEEDED) {
      assert.ok(mirror.includes(seeded.id), `в SEEDED.md нет ${seeded.id}`);
    }
    assert.match(mirror, /ожидаемый пропуск/i);
  });
});
