import { createServer as createHttpServer } from 'node:http';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  PAYMENT_GATEWAY,
  authorizeWithGateway,
  chargeIgnoringIdempotencyKey,
  orderOrNull,
  ordersEnvelope,
  unitPriceCents,
} from './bugs.js';

let bigDestroyedEarly = false;
import { db } from './db.js';

/** Ошибка входных данных: отдаётся как 400 с коротким сообщением, без стека. */
class BadRequest extends Error {}

function send(response, status, body) {
  if (response.headersSent) {
    response.end();
    return;
  }
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('не объект');
    return parsed;
  } catch {
    throw new BadRequest('тело запроса должно быть JSON-объектом');
  }
}

async function route(request, response) {
  const url = new URL(request.url, 'http://localhost');
  const path = url.pathname;
  const { method } = request;

  if (method === 'GET' && path === '/health') {
    return send(response, 200, { status: 'ok' });
  }

  // Служебный эндпоинт тестов: поток больше cap тела; ранний обрыв виден в /big-status.
  if (method === 'GET' && path === '/big') {
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    let written = 0;
    const timer = setInterval(() => {
      if (response.destroyed || response.writableEnded) {
        clearInterval(timer);
        return;
      }
      if (written >= 200) {
        clearInterval(timer);
        response.end();
        return;
      }
      response.write('x'.repeat(1024));
      written += 1;
    }, 5);
    response.on('close', () => {
      if (written < 200) bigDestroyedEarly = true;
      clearInterval(timer);
    });
    return undefined;
  }
  if (method === 'GET' && path === '/big-status') {
    return send(response, 200, { destroyedEarly: bigDestroyedEarly });
  }

  // Служебный эндпоинт тестов: держит ответ, чтобы проверить таймаут запроса пресета.
  if (method === 'GET' && path === '/slow') {
    const requested = Number(url.searchParams.get('ms') ?? '0');
    const delay = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 30_000) : 0;
    await new Promise((done) => setTimeout(done, delay));
    if (request.destroyed || response.writableEnded) return undefined;
    return send(response, 200, { sleptMs: delay });
  }

  // Служебный эндпоинт тестов: два мегабайта не-UTF8 байтов — проверка усечения тела.
  if (method === 'GET' && path === '/blob') {
    const size = 2 * 1024 * 1024;
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': size });
    response.end(Buffer.alloc(size, 0xff));
    return undefined;
  }

  if (method === 'GET' && path === '/orders') {
    return send(response, 200, ordersEnvelope(db.listOrders()));
  }

  if (method === 'POST' && path === '/orders') {
    const body = await readJson(request);
    const qty = body.qty;
    // Количество не проверяется: нечисловое значение отклоняется внутри тарифов (N1),
    // отрицательное — принимается и даёт отрицательный итог (N2).
    const order = db.createOrder({ qty, totalCents: qty * unitPriceCents(qty) });
    return send(response, 200, order);
  }

  const orderMatch = /^\/orders\/([^/]+)$/.exec(path);
  if (method === 'GET' && orderMatch) {
    return send(response, 200, orderOrNull(orderMatch[1]));
  }

  if (method === 'POST' && path === '/payments') {
    const { orderId, amountCents, idempotencyKey } = await readJson(request);
    if (typeof orderId !== 'string' || orderId.length === 0) throw new BadRequest('orderId обязателен');
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
      throw new BadRequest('idempotencyKey обязателен');
    }
    if (typeof amountCents !== 'number' || !Number.isFinite(amountCents) || amountCents <= 0) {
      throw new BadRequest('amountCents должно быть положительным числом');
    }
    const payment = chargeIgnoringIdempotencyKey({ orderId, amountCents, idempotencyKey });
    try {
      const authorized = await authorizeWithGateway(payment);
      return send(response, 200, { ...authorized, balanceCents: db.state.balanceCents, payment });
    } catch (error) {
      // N6: сбой шлюза отдаёт наружу внутренний текст ошибки — ECONNREFUSED и стек вместо кода.
      return send(response, 502, {
        status: 'gateway_unavailable',
        gateway: `${PAYMENT_GATEWAY.host}:${PAYMENT_GATEWAY.port}`,
        chargeId: payment.id,
        balanceCents: db.state.balanceCents,
        error: error.stack ?? String(error),
      });
    }
  }

  if (method === 'POST' && path === '/__reset') {
    db.reset();
    return send(response, 200, { ok: true });
  }

  return send(response, 404, { error: `нет маршрута: ${method} ${path}` });
}

export function createApp() {
  return createHttpServer((request, response) => {
    // Клиент вправе оборвать запрос (таймаут пресета): запись в закрытый сокет не должна ронять стенд.
    response.on('error', () => undefined);
    route(request, response).catch((error) => {
      if (error instanceof BadRequest) {
        send(response, 400, { error: error.message });
        return;
      }
      // N1: отклонение обработчика не перехвачено маршрутом — наружу уходит 500 со стеком.
      send(response, 500, { error: error.stack ?? String(error) });
    });
  });
}

// `import.meta.url` Node приводит к настоящему пути, а `process.argv[1]` может прийти через
// симлинк (на macOS `/var` → `/private/var`): без realpath прямой запуск не распознаётся.
const invokedDirectly = process.argv[1] === undefined
  ? undefined
  : pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly === import.meta.url) {
  createApp().listen(Number(process.env.PORT ?? 3000), '127.0.0.1', function announceReady() {
    process.stdout.write(`listening ${this.address().port}\n`);
  });
}
