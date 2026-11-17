import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import type { Candidate, ReplayContext } from '@bughunter/core';

import type { NodeCheck } from '../src/checks.ts';
import { createNodeReplay } from '../src/replay.ts';
import { nodeSession, performRequest } from '../src/session.ts';
import type { NodeSessionHandle } from '../src/session.ts';
import type { NodeStep } from '../src/types.ts';
import { startFixture, stateForFixture } from './harness.ts';
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

function step(input: { method: string; path: string; body?: unknown }): NodeStep {
  return {
    id: randomUUID(),
    kind: 'act',
    timestamp: new Date().toISOString(),
    targetRef: `${input.method} ${input.path.split('?')[0]}`,
    status: 200,
    durationMs: 1,
    ...input,
  };
}

function candidate(patch: Partial<Candidate> = {}): Candidate {
  return {
    id: 'candidate-node',
    runId: 'run-replay',
    sessionId: 'session-replay',
    target: 'POST /payments',
    title: 'Повторный платёж списывает дважды',
    expected: 'Одно списание на ключ идемпотентности',
    actual: 'Два списания',
    signalIds: [],
    signature: 'signature-node',
    steps: [],
    artifacts: [],
    status: 'confirmed',
    createdAt: '2026-11-15T00:00:00.000Z',
    reproduction: { status: 'reproduced', attempts: 1 },
    ...patch,
  };
}

function contextFor(value: Candidate, steps: NodeStep[]): ReplayContext {
  return {
    candidate: { ...value, steps },
    journal: {
      sessionId: 'session-replay',
      runId: 'run-replay',
      target: value.target,
      persona: 'ревизор',
      steps,
      createdAt: '2026-11-15T00:00:00.000Z',
    },
    stateDir: state.stateDir,
  };
}

test('replay reproduces a status violation in a clean session', async () => {
  const replay = createNodeReplay();
  try {
    const steps = [step({ method: 'GET', path: '/orders/ord-unknown' })];
    const outcome = await replay.replay(steps, contextFor(candidate({
      target: 'GET /orders/:id',
      check: { kind: 'status', target: 'GET /orders/ord-unknown', expected: 404 },
    }), steps));
    assert.equal(outcome.matched, true, 'N3: неизвестный id отдаётся как 200, оракул нарушен');
  } finally {
    await replay.close();
  }
});

test('replay applies the reset before the journal', async () => {
  const replay = createNodeReplay();
  const steps = [step({
    method: 'POST',
    path: '/payments',
    body: { orderId: 'ord-1', amountCents: 1000, idempotencyKey: 'bh_replay_reset' },
  })];
  // Оракул: после одного списания со свежего баланса 10 000 остаётся 9 000, а не 8 000.
  const value = candidate({
    check: { kind: 'jsonPath', target: 'POST /payments', pointer: '$.balanceCents', expected: 8000 } as NodeCheck,
  });
  try {
    const first = await replay.replay(steps, contextFor(value, steps));
    assert.equal(first.matched, true, 'на чистом стенде оракул нарушен');
    // Первый повтор оставил списание. Без сброса второй повтор начался бы с баланса 9 000,
    // списал ещё тысячу и попал бы ровно в ожидаемые 8 000 — оракул перестал бы нарушаться.
    const second = await replay.replay(steps, contextFor(value, steps));
    assert.equal(second.matched, true, 'повтор обязан начинаться со сброса стенда');
  } finally {
    await replay.close();
  }
});

test('replay of a signal-backed candidate matches by signature, not by check', async () => {
  const handle = await nodeSession.open({
    runId: 'run-replay', target: 'POST /orders', persona: 'ревизор', stateDir: state.stateDir,
  }) as NodeSessionHandle;
  let signature: string;
  try {
    const { signals } = await performRequest(handle, { method: 'POST', path: '/orders', body: { qty: 'abc' } }, state.config);
    const symptom = signals.find((signal) => signal.kind === 'status');
    assert.ok(symptom, 'N1 обязан дать симптом статуса');
    signature = symptom.signature;
  } finally {
    await handle.close();
  }

  const steps = [step({ method: 'POST', path: '/orders', body: { qty: 'abc' } })];
  const replay = createNodeReplay();
  try {
    const matched = await replay.replay(steps, contextFor(candidate({
      target: 'POST /orders',
      signalIds: ['signal-one'],
      // Композитная сигнатура кандидата включает оракул, поэтому повтор сверяется с сырой.
      signature: 'composite-with-oracle',
      signalSignature: signature,
      // Оракул не нарушен: статус и правда 500. Решает совпадение сигнатуры.
      check: { kind: 'status', target: 'POST /orders', expected: 500 },
    }), steps));
    assert.equal(matched.matched, true, 'сырая сигнатура симптома совпала');

    const missed = await replay.replay(steps, contextFor(candidate({
      target: 'POST /orders',
      signalIds: ['signal-one'],
      signature: 'a-different-signature',
      // Оракул нарушен, но у сигнального кандидата он не спрашивается.
      check: { kind: 'status', target: 'POST /orders', expected: 400 },
    }), steps));
    assert.equal(missed.matched, false, 'у сигнального кандидата оракул не решает');
  } finally {
    await replay.close();
  }
});

test('replay returns the saved response dumps as artifacts', async () => {
  const replay = createNodeReplay();
  try {
    const steps = [step({ method: 'GET', path: '/health' })];
    const outcome = await replay.replay(steps, contextFor(candidate({
      target: 'GET /health',
      check: { kind: 'status', target: 'GET /health', expected: 200 },
    }), steps));
    assert.equal(outcome.matched, false);
    assert.ok(outcome.artifacts.length >= 1, 'дампы ответов не сохранены');
    for (const artifact of outcome.artifacts) {
      assert.ok(!artifact.startsWith('/'), `путь обязан быть относительным: ${artifact}`);
      assert.ok(artifact.startsWith('runs/run-replay/artifacts/'), artifact);
      assert.ok((await stat(join(state.stateDir, artifact))).size > 0, `пустой артефакт: ${artifact}`);
    }
  } finally {
    await replay.close();
  }
});
