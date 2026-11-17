import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import type { Candidate, Config, Finding, SessionHandle } from '@bughunter/core';
import { webCheckKinds, webChecks } from '../src/checks.ts';
import { webDetectorKinds, webDetectors } from '../src/detectors/index.ts';
import { EXPLORER_PERSONAS, personaBrief, webPersonas } from '../src/personas.ts';
import { webPreset } from '../src/preset.ts';
import { webProfile } from '../src/profile/load.ts';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Хук подключён, если он отвечает или падает доменной ошибкой пресета: заглушка узнаётся
 * по `PRESET_HOOK_NOT_WIRED`. Хуки, которым нужен живой браузер (`checks.violated`,
 * `reset.apply`, `replay.replay`, `session.open` на настоящем приложении), здесь не исполняются —
 * их покрывают `session.bhtest.ts`, `sweep.bhtest.ts` и `reproduce.bhtest.ts` на реальном Chrome.
 */
async function wired(label: string, call: () => unknown): Promise<unknown> {
  try {
    return await call();
  } catch (error) {
    assert.ok(!messageOf(error).includes('PRESET_HOOK_NOT_WIRED'), `${label}: хук не подключён`);
    return undefined;
  }
}

function findingFixture(): Finding {
  return {
    id: 'finding-1',
    runId: 'run-contract',
    targetRef: '/profile',
    kind: webPreset.findingKinds.kinds[0]!,
    detail: 'Ответ экрана изменился',
    evidenceHashes: [],
    status: 'new',
    createdAt: '2026-11-14T00:00:00.000Z',
  };
}

let stateDir: string;

before(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'bh-preset-contract-'));
});

after(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

test('the web preset answers all five questions without stubs', async () => {
  // Что существует в приложении и как это шаблонизируется.
  assert.deepEqual(await webPreset.inventory.list(stateDir), []);
  assert.equal(webPreset.inventory.templateOf('/profile'), '/profile');

  // Как выглядит экран и какие симптомы на нём видно.
  const compacted = webPreset.snapshot.compact({
    url: '/profile',
    elements: [{ id: 'e1', locator: { kind: 'testid', value: 'profile-save' } }],
  }) as { elements: unknown[] };
  assert.deepEqual(compacted.elements, [{ id: 'e1' }]);

  assert.equal(webPreset.detectors, webDetectors);
  assert.deepEqual(webPreset.detectors.kinds, [...webDetectorKinds]);
  const symptom = {
    id: 'signal-1', kind: 'console', message: 'TypeError', signature: 'sig', target: '/profile',
    timestamp: '2026-11-14T00:00:00.000Z',
  };
  let scans = 0;
  const handle = {
    id: 'session-contract',
    drainSignals: () => {
      scans += 1;
      return scans === 1 ? [symptom] : [];
    },
  } as unknown as SessionHandle;
  assert.deepEqual(await webPreset.detectors.scan(handle), [symptom]);
  assert.deepEqual(await webPreset.detectors.scan(handle), [], 'сканирование отдаёт каждый симптом один раз');

  // Чем нарушен инвариант приложения.
  assert.equal(webPreset.checks, webChecks);
  assert.deepEqual(webPreset.checks.kinds, [...webCheckKinds]);
  webPreset.checks.validate({ kind: 'visibleText', target: 'Итого' });
  webPreset.checks.validate({ kind: 'elementCount', target: '[data-testid="order-row"]', expected: 2 });
  webPreset.checks.validate({ kind: 'elementCount', target: '[data-testid="order-row"]', expected: '2' });
  assert.throws(() => webPreset.checks.validate({ kind: 'innerText', target: 'Итого' }), /CHECK_INVALID/);
  assert.throws(() => webPreset.checks.validate({ kind: 'visibleText', target: '   ' }), /CHECK_INVALID/);
  assert.throws(() => webPreset.checks.validate({ kind: 'elementCount', target: 'li', expected: 'много' }), /CHECK_INVALID/);
  assert.throws(() => webPreset.checks.validate({ kind: 'elementCount', target: 'li', expected: -1 }), /CHECK_INVALID/);

  // Как повторить кандидата и как доказать баг тестом.
  assert.equal(typeof webPreset.replay.replay, 'function');
  assert.equal(typeof webPreset.replay.abort, 'function');
  assert.deepEqual(webPreset.testRunner.kinds, ['e2e', 'unit']);
  assert.equal(webPreset.testRunner.ownsProject({}), false);
  assert.equal(webPreset.exportTarget.kind, 'e2e');
  assert.equal(webPreset.exportTarget.fileName('bug-1'), 'bug-1.spec.ts');
  assert.equal(
    webPreset.exportTarget.dir({ tests: { generated: { dir: 'e2e/bughunter' } } } as unknown as Config),
    'e2e/bughunter',
  );

  // Кто исследует приложение и какой профиль ему нужен.
  assert.equal(webPreset.personas, webPersonas);
  assert.deepEqual([...webPreset.personas.roster], [...EXPLORER_PERSONAS]);
  for (const persona of webPreset.personas.roster) {
    assert.ok(webPreset.personas.brief(persona).length > 20, `нет брифа персоны: ${persona}`);
  }
  assert.equal(personaBrief('новичок'), webPreset.personas.brief('новичок'));
  assert.throws(() => webPreset.personas.brief('несуществующая персона'), /PERSONA_UNKNOWN/);

  assert.equal(webPreset.profile, webProfile);
  await assert.rejects(() => webPreset.profile.load(stateDir, 'нет-такого-профиля'), /PROFILE_NOT_FOUND/);
  assert.throws(() => webPreset.profile.testDataFile(null, 'orders.csv'), /UPLOAD_FILE_NOT_FOUND/);

  // Обход, находки, отчёт и коды ошибок.
  assert.equal(typeof webPreset.reset.supported, 'boolean');
  assert.ok(webPreset.findingKinds.kinds.length > 0);
  await wired('findingKinds.syntheticStep', () => webPreset.findingKinds.syntheticStep(findingFixture(), stateDir));
  assert.deepEqual(
    webPreset.report.candidate({ steps: [{ kind: 'navigate', path: '/profile' }] } as unknown as Candidate),
    ['1. navigate /profile'],
  );
  assert.ok(webPreset.report.finding(findingFixture()).join('\n').includes('### '));
  assert.ok(Object.values(webPreset.errors.codes).every((code) => code.length > 0));

  // Сессия исследования: без конфига приложения открытие падает доменной ошибкой, а не заглушкой.
  await wired('session.open', () => webPreset.session.open({
    runId: 'run-contract', target: '/profile', persona: 'новичок', stateDir,
  }));
});
