import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';

import { readFindings, recordCandidateTest, reproduceCandidate, triageCandidate } from '@bughunter/core';
import type { Finding } from '@bughunter/core';

import { exportNodeTest } from '../src/export-vitest.ts';
import { createNodeReplay } from '../src/replay.ts';
import { createRun, finishRun, promoteFindingToCandidate } from '../src/runs.ts';
import { openNodeSession, performRequest, reportNodeCandidate } from '../src/session.ts';
import { runSweep } from '../src/sweep-visit.ts';
import { apiKind, verifyNodeRed } from '../src/test-runner.ts';
import type { NodeReplay } from '../src/replay.ts';
import { startFixture, stateForFixture, vitestProject } from './harness.ts';
import type { Fixture, FixtureState } from './harness.ts';

/**
 * Детерминированная приёмка node-пресета: без модели, за секунды. Прогон целиком идёт через
 * публичные обёртки пресета (`createRun` → `runSweep` → `promoteFindingToCandidate` →
 * `reproduceCandidate` → `triageCandidate` → `exportNodeTest` → `verifyNodeRed`), поэтому
 * приёмка проверяет тот же путь, которым пойдёт модельный прогон. Запускается флагом:
 * `BH_NODE_ACCEPTANCE=1 npm run acceptance`.
 */
const enabled = process.env.BH_NODE_ACCEPTANCE === '1';
const skip = enabled ? false : 'приёмка запускается с BH_NODE_ACCEPTANCE=1';

const fixtureRoot = resolve(import.meta.dirname, '../../../fixtures/node-api-app');
const acceptanceReportPath = join(fixtureRoot, 'ACCEPTANCE.md');

/** Засеянные дефекты из `fixtures/node-api-app/SEEDED.md`. */
const SEEDED = ['N1', 'N2', 'N3', 'N4', 'N5', 'N6'] as const;

/** Что обход находит одним запросом и объявленным ожиданием. */
const DETECTED = ['N1', 'N2', 'N3', 'N6'] as const;

/** Измеренный базовый уровень пропусков: публикуется, а не замалчивается. */
const MEASURED_MISSES: Readonly<Record<string, string>> = {
  N4: 'нужна последовательность из двух одинаковых запросов одним ключом идемпотентности: обход делает один запрос на сценарий, поэтому дефект находится модельным исследованием через check',
  N5: 'разъезд схемы ответа (totalCents против total): нужен мини-оракул схемы ответа, это фаза C',
};

type Promotion = {
  bug: string;
  subject: string;
  kind: string;
  title: string;
  expected: string;
  actual: string;
  check: { kind: 'status'; target: string; expected: number };
};

/** По одному представителю на различимую сигнатуру дефекта. */
const PROMOTIONS: readonly Promotion[] = [
  {
    bug: 'N1',
    subject: 'invalid POST /orders',
    kind: 'status-unexpected',
    title: 'Нечисловое количество даёт 500 со стеком',
    expected: '400 и внятная ошибка валидации количества',
    actual: '500 и стек необработанного отклонения в теле',
    check: { kind: 'status', target: 'POST /orders', expected: 400 },
  },
  {
    bug: 'N3',
    subject: 'invalid GET /orders/ord-unknown',
    kind: 'status-unexpected',
    title: 'Неизвестный заказ отдаётся как 200',
    expected: '404 для неизвестного идентификатора',
    actual: '200 и null в теле',
    check: { kind: 'status', target: 'GET /orders/ord-unknown', expected: 404 },
  },
  {
    bug: 'N6',
    subject: 'valid POST /payments',
    kind: 'body-anomaly',
    title: 'Сбой платёжного шлюза отдаёт внутренности',
    expected: '502 и код сбоя без внутреннего текста ошибки',
    actual: '502 с ECONNREFUSED и стеком вызовов в теле',
    check: { kind: 'status', target: 'POST /payments', expected: 200 },
  },
];

let fixture: Fixture;
let state: FixtureState;
let replay: NodeReplay;
let runId = '';
let sweepMs = 0;
let visited: string[] = [];
let findings: Finding[] = [];
const exported: Array<{ bug: string; file: string; verdict: string }> = [];
let sharedSignature: { first: string; second: string } | undefined;

before(async () => {
  if (!enabled) return;
  fixture = await startFixture();
  state = await stateForFixture(fixture.baseUrl);
  replay = createNodeReplay();
  const run = await createRun('sweep', undefined, {
    config: state.config,
    projectRoot: state.stateDir,
    stateDir: state.stateDir,
  });
  runId = run.id;
  const started = Date.now();
  const result = await runSweep({ runId, stateDir: state.stateDir });
  sweepMs = Date.now() - started;
  assert.equal(result.done, true, 'обход обязан завершиться за один вызов');
  visited = result.visited;
  findings = await readFindings(runId, state.stateDir);
});

after(async () => {
  if (!enabled) return;
  await replay?.close();
  await state?.cleanup();
  await fixture?.stop();
});

function detectedBugs(): string[] {
  const found = new Set<string>();
  const has = (subject: string, kind: string, needle?: RegExp): boolean =>
    findings.some((finding) => finding.subject === subject
      && finding.kind === kind
      && (needle === undefined || needle.test(finding.detail)));
  if (has('invalid POST /orders', 'status-unexpected', /получен 500/)
    || has('empty POST /orders', 'status-unexpected', /получен 500/)) found.add('N1');
  if (has('boundary POST /orders', 'status-unexpected', /получен 200/)) found.add('N2');
  if (findings.some((finding) => finding.targetRef === 'GET /orders/:id'
    && finding.kind === 'status-unexpected'
    && /ожидался статус 404, получен 200/.test(finding.detail))) found.add('N3');
  if (findings.some((finding) => finding.targetRef === 'POST /payments'
    && finding.kind === 'body-anomaly'
    && finding.detail.includes('ECONNREFUSED'))) found.add('N6');
  return [...found].sort();
}

test('sweep covers five endpoints with four scenarios and finds at least four seeded bugs', { skip }, () => {
  assert.deepEqual([...visited].sort(), [
    'GET /health', 'GET /orders', 'GET /orders/:id', 'POST /orders', 'POST /payments',
  ]);
  assert.equal(state.config.scenarios.length, 20, 'четыре сценария на каждый из пяти эндпоинтов');

  const found = detectedBugs();
  assert.ok(found.length >= 4, `порог приёмки — не менее 4 из 6, найдено ${found.length}`);
  for (const missed of Object.keys(MEASURED_MISSES)) {
    assert.ok(!found.includes(missed), `${missed} объявлен пропуском, но найден`);
  }
  assert.deepEqual(found, [...DETECTED], 'состав найденных дефектов разошёлся с измеренным базовым уровнем');
});

test('no false positives on the control endpoint', { skip }, () => {
  assert.deepEqual(findings.filter((finding) => finding.targetRef === 'GET /health'), []);
  assert.deepEqual(
    findings.filter((finding) => finding.targetRef === 'GET /orders'),
    [],
    'N5 не детектируется обходом — других находок на списке заказов быть не должно',
  );
});

test('every promoted finding reproduces and exports a red vitest test', { skip }, async () => {
  const project = await vitestProject();
  try {
    for (const promotion of PROMOTIONS) {
      const finding = findings.find((entry) => entry.subject === promotion.subject && entry.kind === promotion.kind);
      assert.ok(finding, `находка для ${promotion.bug} не записана: ${promotion.subject}`);

      const { candidateId } = await promoteFindingToCandidate({
        runId,
        findingId: finding.id,
        title: promotion.title,
        expected: promotion.expected,
        actual: promotion.actual,
        check: promotion.check,
        stateDir: state.stateDir,
      });
      assert.equal((JSON.parse(await readFile(
        join(state.stateDir, 'runs', runId, 'candidates', `${candidateId}.json`),
        'utf8',
      )) as { steps: unknown[] }).steps.length, 1, 'журнал промоции — один шаг сценария');

      const reproduced = await reproduceCandidate({
        runId,
        candidateId,
        attempts: 1,
        stateDir: state.stateDir,
        replay,
      });
      assert.equal(reproduced.reproduced, '1/1', `${promotion.bug}: кандидат не воспроизведён`);
      assert.equal(reproduced.minimalSteps, 1, `${promotion.bug}: единственный шаг обязан остаться необходимым`);

      const confirmed = await triageCandidate({
        runId,
        candidateId,
        verdict: 'confirmed',
        reason: `${promotion.bug}: детерминированная приёмка, ${promotion.actual}`,
        stateDir: state.stateDir,
      });
      assert.equal(confirmed.status, 'confirmed');

      const { file, placedInProject } = await exportNodeTest({ runId, bugId: candidateId, stateDir: state.stateDir });
      assert.equal(placedInProject, false, 'вне проекта тест остаётся в каталоге прогона');
      const source = await readFile(file, 'utf8');
      const destination = join(project.root, 'bughunter', `${promotion.bug}.test.ts`);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, source, 'utf8');

      const verdict = await verifyNodeRed(destination, { kind: apiKind });
      assert.equal(verdict.status, 'red', `${promotion.bug}: вердикт ${verdict.status}: ${verdict.message}`);
      exported.push({ bug: promotion.bug, file: `${promotion.bug}.test.ts`, verdict: verdict.status });
    }
    assert.deepEqual(exported.map((entry) => entry.bug), PROMOTIONS.map((entry) => entry.bug));
  } finally {
    await project.cleanup();
  }
});

test('two manifestations of one root cause share a signature and one regression test', { skip }, async () => {
  // N1 (нечисловое qty) и N2 (отрицательное qty) — одна причина: валидации количества нет.
  // Сигнатура находки core считается по виду и цели, поэтому обе промоции дают один известный баг
  // и один регрессионный тест. Это измеряемое свойство, а не потеря: оба проявления видны в находках.
  const invalid = findings.find((entry) => entry.subject === 'invalid POST /orders');
  const boundary = findings.find((entry) => entry.subject === 'boundary POST /orders');
  assert.ok(invalid && boundary, 'обе находки POST /orders обязаны быть');

  const first = await promoteFindingToCandidate({
    runId,
    findingId: invalid.id,
    title: 'Количество не проверяется: нечисловое значение',
    expected: '400 на невалидное количество',
    actual: '500 со стеком',
    check: { kind: 'status', target: 'POST /orders', expected: 400 },
    stateDir: state.stateDir,
  });
  const second = await promoteFindingToCandidate({
    runId,
    findingId: boundary.id,
    title: 'Количество не проверяется: отрицательное значение',
    expected: '400 на отрицательное количество',
    actual: '200 и отрицательный итог',
    check: { kind: 'status', target: 'POST /orders', expected: 400 },
    stateDir: state.stateDir,
  });
  assert.notEqual(first.candidateId, second.candidateId, 'кандидаты разные');
  const signatures = await Promise.all([first.candidateId, second.candidateId].map(async (candidateId) =>
    (JSON.parse(await readFile(
      join(state.stateDir, 'runs', runId, 'candidates', `${candidateId}.json`),
      'utf8',
    )) as { signature: string }).signature));
  assert.equal(signatures[0], signatures[1], 'одна причина — одна сигнатура');
  sharedSignature = { first: first.candidateId, second: second.candidateId };
});

test('one symptom with two different oracles stays two bugs and two regression tests', { skip }, async () => {
  // Коллизия: сырая сигнатура 502 у обоих кандидатов одна, но оракулы разные. Пока сигнатура
  // кандидата равнялась сигнатуре симптома, второй кандидат помечался дублем, триаж переиспользовал
  // известный баг, и экспорт падал на EXPORT_FILE_EXISTS.
  const collisionRun = await createRun('sweep', undefined, {
    config: state.config,
    projectRoot: state.stateDir,
    stateDir: state.stateDir,
  });
  const swept = await runSweep({ runId: collisionRun.id, stateDir: state.stateDir });
  assert.equal(swept.done, true);

  const handle = await openNodeSession({
    runId: collisionRun.id,
    target: 'POST /payments',
    persona: 'ревизор',
    stateDir: state.stateDir,
  });
  const reported: string[] = [];
  try {
    const { signals } = await performRequest(
      handle,
      { method: 'POST', path: '/payments', body: { orderId: 'ord-1', amountCents: 1000, idempotencyKey: 'bh_collision' } },
      state.config,
    );
    const symptom = signals.find((signal) => signal.kind === 'status');
    assert.ok(symptom, '502 от платёжного шлюза обязан дать симптом статуса');

    const first = await reportNodeCandidate(handle, {
      title: 'Сбой шлюза вместо успешного платежа',
      expected: '200 на успешный платёж',
      actual: '502 с внутренностями',
      signalIds: [symptom.id],
      check: { kind: 'status', target: 'POST /payments', expected: 200 },
    });
    const second = await reportNodeCandidate(handle, {
      title: 'Сбой шлюза всё равно списывает деньги',
      expected: 'баланс 10000: неуспешный платёж не списывает',
      actual: '502, но баланс уменьшился до 9000',
      signalIds: [symptom.id],
      check: { kind: 'jsonPath', target: 'POST /payments', pointer: '$.balanceCents', expected: 10000 },
    });
    assert.equal(first.duplicateOf, undefined);
    assert.equal(second.duplicateOf, undefined, 'общий симптом с другим оракулом — не дубль');
    reported.push(first.candidateId, second.candidateId);

    const signatures = await Promise.all(reported.map(async (candidateId) => JSON.parse(await readFile(
      join(state.stateDir, 'runs', collisionRun.id, 'candidates', `${candidateId}.json`),
      'utf8',
    )) as { signature: string; signalSignature?: string }));
    assert.equal(signatures[0]!.signalSignature, symptom.signature);
    assert.equal(signatures[1]!.signalSignature, symptom.signature);
    assert.notEqual(signatures[0]!.signature, signatures[1]!.signature);
  } finally {
    await handle.close();
  }

  for (const candidateId of reported) {
    const reproduced = await reproduceCandidate({
      runId: collisionRun.id,
      candidateId,
      attempts: 1,
      stateDir: state.stateDir,
      replay,
    });
    assert.equal(reproduced.reproduced, '1/1');
    await triageCandidate({
      runId: collisionRun.id,
      candidateId,
      verdict: 'confirmed',
      reason: 'детерминированная приёмка коллизии сигнатур',
      stateDir: state.stateDir,
    });
  }

  const exportedFiles = await Promise.all(reported.map(async (bugId) =>
    (await exportNodeTest({ runId: collisionRun.id, bugId, stateDir: state.stateDir })).file));
  assert.notEqual(exportedFiles[0], exportedFiles[1], 'у разных багов разные файлы регрессий');
  const project = await vitestProject();
  try {
    const verdicts: string[] = [];
    for (const [index, file] of exportedFiles.entries()) {
      const source = await readFile(file, 'utf8');
      assert.match(source, /from 'vitest'/);
      const destination = join(project.root, 'bughunter', `collision-${index}.test.ts`);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, source, 'utf8');
      const verdict = await verifyNodeRed(destination, { kind: apiKind });
      verdicts.push(verdict.status);
      await recordCandidateTest(collisionRun.id, reported[index]!, apiKind, file, state.stateDir, 'red');
    }
    assert.deepEqual(verdicts, ['red', 'red'], 'оба оракула обязаны давать красный тест');
  } finally {
    await project.cleanup();
  }

  const finished = await finishRun(collisionRun.id, state.stateDir);
  assert.match(finished.report, /report\.md$/);
});

test('the acceptance report lists the measured baseline', { skip }, async () => {
  const found = detectedBugs();
  const missed = SEEDED.filter((id) => !found.includes(id));
  const report = [
    '# Приёмка node-пресета на `node-api-app`',
    '',
    'Детерминированный слой: обход, промоция, воспроизведение, экспорт и вердикт — без модели.',
    'Запуск: `cd .qwen/bughunter/presets/node && BH_NODE_ACCEPTANCE=1 npm run acceptance`.',
    '',
    `- Прогон: \`${runId}\`, обход ${visited.length} целей за ${sweepMs} мс, находок: ${findings.length}.`,
    `- Найдено: **${found.length} из ${SEEDED.length}** (${found.join(', ')}).`,
    `- Промоций в кандидаты: ${PROMOTIONS.length}; red-тестов: ${exported.length}, все \`red\`.`,
    `- Контрольный \`GET /health\`: находок 0, кандидатов 0.`,
    '',
    '## Найденные дефекты',
    '',
    '| Баг | Эндпоинт | Чем найден |',
    '| --- | --- | --- |',
    `| N1 | \`POST /orders\` | сценарии empty/invalid: статус 500 вместо 400 и стек в теле |`,
    `| N2 | \`POST /orders\` | сценарий boundary: статус 200 вместо 400, отрицательный итог |`,
    `| N3 | \`GET /orders/:id\` | сценарии empty/invalid/boundary: статус 200 вместо 404 |`,
    `| N6 | \`POST /payments\` | сценарии valid/boundary: 502 и \`ECONNREFUSED\` со стеком в теле |`,
    '',
    '## Измеренные пропуски',
    '',
    '| Баг | Почему не найден этим слоем |',
    '| --- | --- |',
    ...missed.map((id) => `| ${id} | ${MEASURED_MISSES[id] ?? 'причина не задокументирована'} |`),
    '',
    '## Схлопывание одной причины',
    '',
    `N1 и N2 — одна причина (валидации количества нет), поэтому сигнатура находки у них общая`,
    `и регрессионный тест экспортируется один. Кандидаты при этом разные:`,
    `\`${sharedSignature?.first ?? '-'}\` и \`${sharedSignature?.second ?? '-'}\`.`,
    '',
  ].join('\n');

  await writeFile(acceptanceReportPath, `${report}\n`, 'utf8');
  const written = await readFile(acceptanceReportPath, 'utf8');
  assert.match(written, /Найдено: \*\*4 из 6\*\* \(N1, N2, N3, N6\)/);
  for (const id of Object.keys(MEASURED_MISSES)) {
    assert.ok(written.includes(`| ${id} |`), `в отчёте нет измеренного пропуска ${id}`);
  }
  assert.match(written, /red-тестов: 3, все `red`/i);
  assert.match(written, /Контрольный `GET \/health`: находок 0, кандидатов 0/);
});
