import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { readFindings } from '@bughunter/core';
import type { Candidate, Finding } from '@bughunter/core';

import { nodeErrors } from '../src/errors.ts';
import { nodeFindingKinds, scenarioWidget } from '../src/finding-kinds.ts';
import { targetOfRequest } from '../src/inventory.ts';
import { NODE_PERSONAS, nodePersonas } from '../src/personas.ts';
import { nodeProfile } from '../src/profile.ts';
import type { NodeProfile } from '../src/profile.ts';
import { nodeReportFormat } from '../src/report-format.ts';
import { createRun, promoteFindingToCandidate } from '../src/runs.ts';
import { nodeSweepSession, runSweep } from '../src/sweep-visit.ts';
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

async function newRun(
  source: { stateDir: string; config: FixtureState['config'] } = state,
): Promise<string> {
  const run = await createRun('sweep', undefined, {
    config: source.config,
    projectRoot: source.stateDir,
    stateDir: source.stateDir,
  });
  return run.id;
}

test('sweep runs every declared scenario per endpoint and records findings', async () => {
  const runId = await newRun();
  const result = await runSweep({ runId, stateDir: state.stateDir });
  assert.equal(result.targets, 5);
  assert.equal(result.done, true);
  assert.deepEqual([...result.visited].sort(), [
    'GET /health', 'GET /orders', 'GET /orders/:id', 'POST /orders', 'POST /payments',
  ]);
  // Каждый заявленный сценарий принадлежит пройденной цели, значит ни один не пропущен.
  const profile = await nodeProfile.load(state.stateDir, state.config.profile) as NodeProfile;
  for (const scenario of state.config.scenarios) {
    const belongs = targetOfRequest(profile.endpoints, scenario.request.method, scenario.request.path);
    assert.ok(belongs !== undefined, `сценарий вне инвентаря: ${scenarioWidget(scenario)}`);
    assert.ok(result.visited.includes(belongs), `цель сценария не пройдена: ${scenarioWidget(scenario)}`);
  }

  const findings = await readFindings(runId, state.stateDir);
  assert.ok(findings.length >= 6, `находок всего ${findings.length}`);
  for (const finding of findings) {
    assert.ok(nodeFindingKinds.kinds.includes(finding.kind), `вид вне словаря: ${finding.kind}`);
    assert.ok((finding.widget ?? '').length > 0, 'у находки обхода есть сценарий');
    assert.ok(finding.responseHashes.length === 1);
  }
  // N3: неизвестный идентификатор отдаётся как 200 вместо 404.
  assert.ok(findings.some((finding) => finding.kind === 'status-unexpected'
    && finding.widget === 'invalid GET /orders/ord-unknown'
    && finding.detail.includes('404')));
  // N1: нечисловое количество — 500 со стеком вместо 400.
  assert.ok(findings.some((finding) => finding.kind === 'status-unexpected'
    && finding.widget === 'invalid POST /orders'
    && finding.detail.includes('500')));
  assert.ok(findings.some((finding) => finding.kind === 'body-anomaly'
    && finding.widget === 'invalid POST /orders'
    && finding.detail.includes('unitPriceCents')));
  // N2: отрицательное количество принято (200 вместо 400).
  assert.ok(findings.some((finding) => finding.kind === 'status-unexpected'
    && finding.widget === 'boundary POST /orders'));
  // N6: внутренности шлюза в теле ответа.
  assert.ok(findings.some((finding) => finding.kind === 'body-anomaly'
    && finding.targetRef === 'POST /payments'
    && finding.detail.includes('ECONNREFUSED')));
  // Контроль: на /health находок нет.
  assert.deepEqual(findings.filter((finding) => finding.targetRef === 'GET /health'), []);
});

test('sweep checkpoints the cursor after every target and resumes from it', async () => {
  const runId = await newRun();
  const first = await runSweep({ runId, stateDir: state.stateDir, limit: 2 });
  assert.equal(first.done, false);
  assert.equal(first.visited.length, 2);
  assert.equal(first.nextCursor, 2);

  const progress = JSON.parse(await readFile(
    join(state.stateDir, 'runs', runId, 'sweep.json'),
    'utf8',
  )) as { cursor: number; visited: string[] };
  assert.equal(progress.cursor, 2);
  assert.deepEqual(progress.visited, first.visited);

  const second = await runSweep({ runId, stateDir: state.stateDir });
  assert.equal(second.done, true);
  assert.equal(second.visited.length, 3);
  const all = [...first.visited, ...second.visited];
  assert.equal(new Set(all).size, 5, 'продолжение обхода не должно повторять цели');
});

test('sweep applies the reset before each endpoint and reports a missing recipe', async () => {
  // Ожидания баланса объявлены так, будто каждый сценарий стартует с чистых 10 000: `valid`
  // списывает 1 000 (остаётся 9 000), `boundary` — 1 копейку (остаётся 9 999). Без сброса перед
  // каждым сценарием второй из них стартовал бы с 9 000 и дал бы 8 999 — ожидание разъехалось бы.
  const withBalance = await stateForFixture(fixture.baseUrl, (config) => {
    const expectations: Record<string, number> = { valid: 9000, boundary: 9999 };
    for (const [name, balanceCents] of Object.entries(expectations)) {
      const scenario = config.scenarios.find((entry) => entry.name === name && entry.request.path === '/payments');
      assert.ok(scenario, `сценарий ${name} для /payments обязателен`);
      scenario.expect = { status: 200, jsonPath: [{ pointer: '/balanceCents', expected: balanceCents }] };
    }
  });
  try {
    for (const round of [1, 2]) {
      const runId = await newRun(withBalance);
      await runSweep({ runId, stateDir: withBalance.stateDir });
      const findings = await readFindings(runId, withBalance.stateDir);
      assert.deepEqual(
        findings.filter((finding) => finding.kind === 'expectation-mismatch' && finding.targetRef === 'POST /payments'),
        [],
        `обход ${round}: стенд не вернулся в исходное состояние`,
      );
    }
  } finally {
    await withBalance.cleanup();
  }

  const withoutReset = await stateForFixture(fixture.baseUrl, (config) => {
    config.reset = null;
  });
  try {
    const runId = await newRun(withoutReset);
    await runSweep({ runId, stateDir: withoutReset.stateDir });
    const findings = await readFindings(runId, withoutReset.stateDir);
    const unsupported = findings.filter((finding) => finding.kind === 'reset-unsupported');
    assert.equal(unsupported.length, 1, 'находка о сбросе одна на прогон, а не по одной на цель');
    assert.match(unsupported[0]!.detail, /RESET_UNSUPPORTED/);
  } finally {
    await withoutReset.cleanup();
  }
});

test('an expectation declared in the scenario becomes an expectation-mismatch finding', async () => {
  const strict = await stateForFixture(fixture.baseUrl, (config) => {
    const health = config.scenarios.find((entry) => entry.request.path === '/health' && entry.name === 'valid');
    assert.ok(health, 'сценарий valid для /health обязателен');
    health.expect = { status: 200, jsonPath: [{ pointer: '/status', expected: 'ready' }] };
  });
  try {
    const runId = await newRun(strict);
    await runSweep({ runId, stateDir: strict.stateDir });
    const mismatch = (await readFindings(runId, strict.stateDir))
      .filter((finding) => finding.kind === 'expectation-mismatch');
    assert.equal(mismatch.length, 1);
    assert.equal(mismatch[0]!.targetRef, 'GET /health');
    assert.match(mismatch[0]!.detail, /\/status = "ok"/);
  } finally {
    await strict.cleanup();
  }
});

test('promoting a finding creates a one-step journal and a candidate', async () => {
  const runId = await newRun();
  await runSweep({ runId, stateDir: state.stateDir });
  const findings = await readFindings(runId, state.stateDir);
  const finding = findings.find((entry) => entry.widget === 'invalid GET /orders/ord-unknown');
  assert.ok(finding, 'находка N3 не записана');

  const { candidateId } = await promoteFindingToCandidate({
    runId,
    findingId: finding.id,
    title: 'Неизвестный заказ отдаётся как 200',
    expected: '404 для неизвестного идентификатора',
    actual: '200 и null в теле',
    check: { kind: 'status', target: 'GET /orders/ord-unknown', expected: 404 },
    stateDir: state.stateDir,
  });

  const candidate = JSON.parse(await readFile(
    join(state.stateDir, 'runs', runId, 'candidates', `${candidateId}.json`),
    'utf8',
  )) as Candidate & { steps: NodeStep[] };
  assert.equal(candidate.steps.length, 1);
  assert.equal(candidate.target, 'GET /orders/:id');
  assert.equal(candidate.steps[0]!.method, 'GET');
  assert.equal(candidate.steps[0]!.path, '/orders/ord-unknown');
  assert.equal(candidate.steps[0]!.kind, 'act');

  const journal = JSON.parse(await readFile(
    join(state.stateDir, 'runs', runId, 'journals', `${candidate.sessionId}.json`),
    'utf8',
  )) as { persona: string; steps: NodeStep[] };
  assert.equal(journal.persona, 'sweep');
  assert.equal(journal.steps.length, 1);

  const promoted = (await readFindings(runId, state.stateDir)).find((entry) => entry.id === finding.id);
  assert.equal(promoted?.status, 'promoted');
  assert.equal(promoted?.candidateId, candidateId);
});

test('the sweep session refuses interactive actions', async () => {
  const runId = await newRun();
  const handle = await nodeSweepSession.open({
    runId,
    target: 'GET /health',
    persona: 'sweep',
    stateDir: state.stateDir,
  });
  try {
    await assert.rejects(handle.act({ method: 'GET', path: '/health' }), /SWEEP_SESSION_READ_ONLY/);
    assert.deepEqual(handle.steps(), [], 'сессия обхода не ведёт журнал');
    assert.deepEqual(handle.artifacts(), [], 'запросов не было — артефактов нет');
  } finally {
    await handle.close();
  }
});

test('personas, report format and error dictionary are wired', () => {
  assert.deepEqual([...NODE_PERSONAS], ['интегратор', 'ревизор', 'нетерпеливый']);
  assert.deepEqual([...nodePersonas.roster], [...NODE_PERSONAS]);
  for (const persona of NODE_PERSONAS) {
    assert.ok(nodePersonas.brief(persona).length > 20, `нет брифа персоны: ${persona}`);
  }
  assert.throws(() => nodePersonas.brief('кто угодно'), /PERSONA_UNKNOWN/);

  assert.equal(nodeErrors.codes.INVENTORY_EMPTY, 'ENDPOINT_NOT_FOUND');
  assert.equal(nodeErrors.codes.TARGETS_EMPTY, 'ENDPOINT_NOT_FOUND');

  const finding: Finding = {
    id: 'finding-1',
    runId: 'run-report',
    targetRef: 'GET /orders/:id',
    widget: 'invalid GET /orders/ord-unknown',
    kind: 'status-unexpected',
    detail: 'ожидался статус 404, получен 200',
    responseHashes: ['hash-1'],
    status: 'new',
    createdAt: '2026-11-15T00:00:00.000Z',
  };
  const findingLines = nodeReportFormat.finding(finding);
  assert.equal(findingLines[0], '### status-unexpected: GET /orders/:id');
  assert.ok(findingLines.some((line) => line.includes('Сценарий: invalid GET /orders/ord-unknown')));
  assert.ok(findingLines.some((line) => line.includes('- Responses: 1')));

  const candidateLines = nodeReportFormat.candidate({
    steps: [{ kind: 'act', method: 'GET', path: '/orders/ord-unknown', status: 200 }],
  } as unknown as Candidate);
  assert.deepEqual(candidateLines, ['1. GET /orders/ord-unknown → 200']);
});
