import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { nodeCheckKinds, nodeChecks } from '../src/checks.ts';
import type { NodeCheck } from '../src/checks.ts';
import type { NodeConfig } from '../src/config.ts';
import { nodeSession, performRequest } from '../src/session.ts';
import type { NodeSessionHandle } from '../src/session.ts';
import { startFixture, stateForFixture } from './harness.ts';
import type { Fixture, FixtureState } from './harness.ts';

/** Литералы оракулов типизируются как NodeCheck: в базовом Check поля pointer нет. */
const violated = (handle: NodeSessionHandle, check: NodeCheck) => nodeChecks.violated(handle, check);
const validate = (check: NodeCheck) => nodeChecks.validate(check);

let fixture: Fixture;
let state: FixtureState;
let config: NodeConfig;

before(async () => {
  fixture = await startFixture();
  state = await stateForFixture(fixture.baseUrl);
  config = state.config;
});

after(async () => {
  await state?.cleanup();
  await fixture?.stop();
});

async function openSession(target: string): Promise<NodeSessionHandle> {
  return await nodeSession.open({
    runId: 'run-checks',
    target,
    persona: 'ревизор',
    stateDir: state.stateDir,
  }) as NodeSessionHandle;
}

test('a status check compares the expected code', async () => {
  const handle = await openSession('GET /orders/:id');
  try {
    // N3: неизвестный идентификатор отдаётся как 200 и null, хотя контракт ждёт 404.
    assert.equal(
      await violated(handle, { kind: 'status', target: 'GET /orders/ord-unknown', expected: 404 }),
      true,
    );
    assert.equal(
      await violated(handle, { kind: 'status', target: 'GET /health', expected: 200 }),
      false,
    );
  } finally {
    await handle.close();
  }
});

test('a jsonPath check reads the pointer and compares the value', async () => {
  const handle = await openSession('GET /orders/:id');
  try {
    const id = (check: NodeCheck) => violated(handle, check);
    assert.equal(await id({ kind: 'jsonPath', target: 'GET /orders/ord-1', pointer: '$.id', expected: 'ord-1' }), false);
    assert.equal(await id({ kind: 'jsonPath', target: 'GET /orders/ord-1', pointer: '$.id', expected: 'ord-2' }), true);
    assert.equal(await id({ kind: 'jsonPath', target: 'GET /orders/ord-1', pointer: '/id', expected: 'ord-1' }), false);
    assert.equal(await id({ kind: 'jsonPath', target: 'GET /orders/ord-1', pointer: '/qty', expected: 2 }), false);
  } finally {
    await handle.close();
  }
});

test('a check is judged by the last response of the session, not by a fresh request', async () => {
  const handle = await openSession('POST /orders');
  try {
    await performRequest(handle, { method: 'POST', path: '/orders', body: { qty: -5 } }, config);
    // N2: заказ с отрицательным количеством создан. Оракул смотрит на последний ответ сессии,
    // поэтому повторный запрос не нужен и журнал не растёт.
    assert.equal(await violated(handle, { kind: 'status', target: 'POST /orders', expected: 400 }), true);
    assert.equal(
      await violated(handle, { kind: 'jsonPath', target: 'POST /orders', pointer: '$.totalCents', expected: -6000 }),
      false,
    );
    assert.equal(handle.responses.length, 1, 'проверка оракулом не добавляет сессии ответов');
    assert.equal(handle.steps().length, 1, 'проверка оракулом не добавляет шагов журнала');
  } finally {
    await handle.close();
  }
});

test('a jsonPath check on a missing pointer reports the pointer, not a stack', async () => {
  const handle = await openSession('GET /health');
  try {
    await assert.rejects(
      violated(handle, { kind: 'jsonPath', target: 'GET /health', pointer: '$.absent', expected: 1 }),
      (error) => {
        assert.equal(String(error), 'Error: POINTER_NOT_FOUND: $.absent');
        return true;
      },
    );
  } finally {
    await handle.close();
  }
});

test('a headerContains check reads the header case-insensitively', async () => {
  const handle = await openSession('GET /health');
  try {
    assert.equal(
      await violated(handle, { kind: 'headerContains', target: 'GET /health', pointer: 'content-TYPE', expected: 'application/json' }),
      false,
    );
    assert.equal(
      await violated(handle, { kind: 'headerContains', target: 'GET /health', pointer: 'Content-Type', expected: 'text/html' }),
      true,
    );
  } finally {
    await handle.close();
  }
});

test('validate rejects a check without a request line', () => {
  assert.deepEqual(nodeChecks.kinds, [...nodeCheckKinds]);
  validate({ kind: 'status', target: 'GET /health', expected: 200 });
  validate({ kind: 'jsonPath', target: 'GET /health', pointer: '$.status', expected: 'ok' });
  validate({ kind: 'headerContains', target: 'GET /health', pointer: 'Content-Type', expected: 'json' });

  assert.throws(() => validate({ kind: 'status', target: '/orders', expected: 200 }), /CHECK_INVALID/);
  assert.throws(() => validate({ kind: 'status', target: 'GET', expected: 200 }), /CHECK_INVALID/);
  assert.throws(() => validate({ kind: 'status', target: '  ', expected: 200 }), /CHECK_INVALID/);
  assert.throws(
    () => validate({ kind: 'unknown', target: 'GET /health', expected: 200 } as unknown as NodeCheck),
    /CHECK_INVALID/,
  );
  assert.throws(() => validate({ kind: 'jsonPath', target: 'GET /health', expected: 200 }), /CHECK_INVALID/);
  assert.throws(() => validate({ kind: 'headerContains', target: 'GET /health', expected: 'json' }), /CHECK_INVALID/);
  assert.throws(() => validate({ kind: 'status', target: 'GET /health' }), /CHECK_INVALID/);
});
