import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import type { Signal } from '@bughunter/core';

import type { NodeConfig } from '../src/config.ts';
import { nodeDetectors } from '../src/detectors.ts';
import { nodeSession, performRequest } from '../src/session.ts';
import type { NodeSessionHandle } from '../src/session.ts';
import { nodeSnapshot } from '../src/snapshot.ts';
import type { NodeStep } from '../src/types.ts';
import { freePort, startFixture, stateForFixture } from './harness.ts';
import type { Fixture, FixtureState } from './harness.ts';

let fixture: Fixture;
let state: FixtureState;

before(async () => {
  fixture = await startFixture();
  state = await stateForFixture(fixture.baseUrl);
});

after(async () => {
  await state?.cleanup();
  await fixture?.stop();
});

async function openSession(target = 'GET /orders'): Promise<NodeSessionHandle> {
  return await nodeSession.open({
    runId: 'run-session',
    target,
    persona: 'интегратор',
    stateDir: state.stateDir,
  }) as NodeSessionHandle;
}

test('a request records the response and returns it in the journal step', async () => {
  const handle = await openSession('POST /orders');
  try {
    const { response, signals } = await performRequest(
      handle,
      { method: 'POST', path: '/orders', body: { qty: 3 } },
      state.config,
    );
    assert.equal(response.status, 200);
    assert.equal(response.method, 'POST');
    assert.equal(response.path, '/orders');
    assert.deepEqual((response.body as { totalCents: number }).totalCents, 3600);
    assert.ok(response.durationMs >= 0);
    assert.deepEqual(signals, [], 'успешный запрос без аномалий не даёт симптомов');

    const steps = handle.steps() as NodeStep[];
    assert.equal(steps.length, 1);
    assert.equal(steps[0]!.kind, 'act');
    assert.equal(steps[0]!.targetRef, 'POST /orders');
    assert.equal(steps[0]!.method, 'POST');
    assert.equal(steps[0]!.path, '/orders');
    assert.equal(steps[0]!.status, 200);
    assert.deepEqual(steps[0]!.body, { qty: 3 });
    assert.ok((steps[0]!.durationMs ?? -1) >= 0);
    assert.ok((steps[0]!.id ?? '').length > 0);

    const journalPath = join(state.stateDir, 'runs', 'run-session', 'journals', `${handle.id}.json`);
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
      target: string; persona: string; steps: NodeStep[];
    };
    assert.equal(journal.target, 'POST /orders');
    assert.equal(journal.persona, 'интегратор');
    assert.equal(journal.steps.length, 1);

    assert.equal(handle.responses.length, 1);
    const artifacts = handle.artifacts();
    assert.equal(artifacts.length, 1);
    assert.match(artifacts[0]!, /^runs\/run-session\/artifacts\//);
  } finally {
    await handle.close();
  }
});

test('a hung endpoint times out and becomes a signal', async () => {
  const handle = await openSession('GET /slow');
  try {
    const config: NodeConfig = { ...state.config, requestTimeoutMs: 300 };
    const started = Date.now();
    const { response, signals } = await performRequest(handle, { method: 'GET', path: '/slow?ms=3000' }, config);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1_300, `ждали ${elapsed} мс — таймаут не сработал`);
    assert.equal(response.status, 0, 'у прерванного запросом ответа нет статуса');
    assert.ok(
      signals.some((signal) => signal.kind === 'status' && signal.message === 'REQUEST_TIMEOUT'),
      JSON.stringify(signals),
    );
    assert.equal((handle.steps() as NodeStep[])[0]!.status, 0);
    // Буфер опустошается один раз: повторное сканирование того же симптома не даёт.
    assert.deepEqual(await nodeDetectors.scan(handle), signals);
    assert.deepEqual(await nodeDetectors.scan(handle), []);
  } finally {
    await handle.close();
  }
});

test('requests outside allowedHosts are blocked before they are sent', async () => {
  let hits = 0;
  let sameHostHits = 0;
  const spy = createServer((_request, response) => {
    hits += 1;
    response.end('{}');
  });
  const spyPort = await freePort('::1');
  await new Promise<void>((done) => spy.listen(spyPort, '::1', () => done()));
  const handle = await openSession();
  try {
    await assert.rejects(
      performRequest(handle, { method: 'GET', path: `http://[::1]:${spyPort}/x` }, state.config),
      /FORBIDDEN_ORIGIN/,
    );
    // Другой порт того же хоста — другой сервис, а не стенд: план требует блокировки.
    const sameHostSpy = createServer((_request, response) => {
      sameHostHits += 1;
      response.end('{}');
    });
    const sameHostPort = await freePort('127.0.0.1');
    await new Promise<void>((done) => sameHostSpy.listen(sameHostPort, '127.0.0.1', () => done()));
    try {
      await assert.rejects(
        performRequest(handle, { method: 'GET', path: `http://127.0.0.1:${sameHostPort}/x` }, state.config),
        /FORBIDDEN_ORIGIN/,
      );
    } finally {
      await new Promise<void>((done) => sameHostSpy.close(() => done()));
    }
    assert.equal(sameHostHits, 0, 'запрос на другой порт того же хоста не должен уйти');
    await assert.rejects(
      performRequest(handle, { method: 'GET', path: '/health', headers: { Host: 'evil.example' } }, state.config),
      /FORBIDDEN_ORIGIN/,
    );
    await assert.rejects(
      performRequest(handle, { method: 'GET', path: 'health' }, state.config),
      /TARGET_REQUIRED/,
    );
    assert.equal(hits, 0, 'заблокированный запрос не должен уйти в сеть');
    assert.deepEqual(handle.responses, [], 'заблокированный запрос не попадает в ответы сессии');
    assert.deepEqual(handle.steps(), [], 'заблокированный запрос не становится шагом журнала');
  } finally {
    await handle.close();
    await new Promise<void>((done) => spy.close(() => done()));
  }
});

test('a binary or oversized body does not break the snapshot', async () => {
  const handle = await openSession('GET /blob');
  try {
    const { response, signals } = await performRequest(handle, { method: 'GET', path: '/blob' }, state.config);
    assert.equal(response.status, 200);
    assert.equal(response.body, null, 'не-JSON тело не парсится');
    assert.ok(response.raw.length <= 65_536, `тело не усечено: ${response.raw.length}`);
    assert.ok(Array.isArray(signals));

    const compacted = nodeSnapshot.compact(await handle.snapshot()) as {
      target: string;
      endpoints: unknown[];
      responses: Array<{ raw: string; truncated?: boolean }>;
      signals: Signal[];
    };
    assert.equal(compacted.target, 'GET /blob');
    assert.equal(compacted.endpoints.length, 5, 'снимок показывает инвентарь профиля');
    assert.equal(compacted.responses.length, 1);
    assert.ok(compacted.responses[0]!.raw.length <= 2_048, `в снимке тело не усечено: ${compacted.responses[0]!.raw.length}`);
    assert.equal(compacted.responses[0]!.truncated, true);
    assert.ok(Array.isArray(compacted.signals));
  } finally {
    await handle.close();
  }
});

test('a JSON string body is sent as the value the model meant', async () => {
  const handle = await openSession('POST /orders');
  try {
    // Аргументы MCP приходят JSON'ом, и модель передаёт тело строкой: без разбора строка
    // кодировалась второй раз, приложение отвечало 400, и модель заявляла ложного кандидата.
    const { response } = await performRequest(handle, { method: 'POST', path: '/orders', body: '{"qty": 2}' }, state.config);
    assert.equal(response.status, 200, `приложение отклонило тело: ${response.raw.slice(0, 160)}`);
    assert.equal((response.body as { totalCents: number }).totalCents, 2400);
    assert.deepEqual((handle.steps() as NodeStep[])[0]!.body, { qty: 2 }, 'в журнал попадает отправленное значение');

    // Сырой текст остаётся телом как есть: не всякая строка — ошибка модели.
    const raw = await performRequest(handle, { method: 'POST', path: '/orders', body: 'plain text' }, state.config);
    assert.equal(raw.response.status, 400);
    assert.equal((handle.steps() as NodeStep[])[1]!.body, 'plain text');
  } finally {
    await handle.close();
  }
});

test('the snapshot shows the declared contract of the endpoint', async () => {
  const handle = await openSession('POST /orders');
  try {
    const snapshot = await handle.snapshot() as {
      scenarios: Array<{ name: string; request: { method: string; path: string }; expect?: unknown }>;
    };
    assert.deepEqual(
      snapshot.scenarios.map((scenario) => scenario.name).sort(),
      ['boundary', 'empty', 'invalid', 'valid'],
      'снимок обязан показывать четыре объявленных сценария своей цели',
    );
    assert.deepEqual(
      snapshot.scenarios.find((scenario) => scenario.name === 'valid')!.expect,
      { status: 200, jsonPath: [{ pointer: '/totalCents', expected: 3600 }] },
    );
    assert.ok(snapshot.scenarios.every((scenario) => scenario.request.path.startsWith('/orders')));
  } finally {
    await handle.close();
  }
});

test('read-only config and forbidden action text are enforced before the request', async () => {
  const handle = await openSession('POST /orders');
  try {
    const forbidden: NodeConfig = {
      ...state.config,
      safety: { ...state.config.safety, forbiddenActionText: ['__reset'] },
    };
    await assert.rejects(
      performRequest(handle, { method: 'POST', path: '/__reset' }, forbidden),
      /FORBIDDEN_ACTION/,
    );

    const readOnly: NodeConfig = { ...state.config, safety: { ...state.config.safety, readOnly: true } };
    await assert.rejects(
      performRequest(handle, { method: 'POST', path: '/orders', body: { qty: 1 } }, readOnly),
      /FORBIDDEN_ACTION/,
    );
    const allowed = await performRequest(handle, { method: 'GET', path: '/health' }, readOnly);
    assert.equal(allowed.response.status, 200);
    assert.equal(handle.steps().length, 1, 'заблокированный запрос не становится шагом журнала');
  } finally {
    await handle.close();
  }
});

test('the step limit is enforced by the session before the request is sent', async () => {
  const limited = await stateForFixture(fixture.baseUrl, (config) => {
    config.limits.stepsPerSession = 1;
  });
  const handle = await nodeSession.open({
    runId: 'run-limit',
    target: 'GET /health',
    persona: 'нетерпеливый',
    stateDir: limited.stateDir,
  }) as NodeSessionHandle;
  try {
    await performRequest(handle, { method: 'GET', path: '/health' }, limited.config);
    await assert.rejects(
      performRequest(handle, { method: 'GET', path: '/health' }, limited.config),
      /LIMIT_REACHED/,
    );
    assert.equal(handle.steps().length, 1);
  } finally {
    await handle.close();
    await limited.cleanup();
  }
});
