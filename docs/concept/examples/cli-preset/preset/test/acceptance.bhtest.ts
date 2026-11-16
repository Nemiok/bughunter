import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  readFindings, reproduceCandidate, triageCandidate,
} from '@bughunter/core';

import { exportCliTest } from '../src/export-cli.ts';
import { createCliReplay } from '../src/replay.ts';
import { createRun, promoteFindingToCandidate } from '../src/runs.ts';
import { runSweep } from '../src/sweep-visit.ts';
import { verifyCliRed } from '../src/test-runner.ts';
import { fixtureDir, presetRoot, stateFor } from './harness.ts';

async function temporaryApp(): Promise<string> {
  const appDir = await mkdtemp(join(presetRoot, '.test-acceptance-app-'));
  await mkdir(join(appDir, 'src'), { recursive: true });
  await copyFile(join(fixtureDir, 'src', 'cli.js'), join(appDir, 'src', 'cli.js'));
  await writeFile(
    join(appDir, 'package.json'),
    `${JSON.stringify({ name: 'bh-cli-acceptance', private: true, type: 'module', bughunter: { target: 'cli' } }, null, 2)}\n`,
    'utf8',
  );
  return appDir;
}

test('acceptance: sweep promotes C1 and exports a red project test', async () => {
  const appDir = await temporaryApp();
  const state = await stateFor((config) => { config.appDir = appDir; });
  const previousTmp = process.env.TMPDIR;
  const tmp = await mkdtemp(join(presetRoot, '.test-acceptance-tmp-'));
  process.env.TMPDIR = tmp;
  try {
    const run = await createRun('sweep', undefined, {
      config: state.config,
      projectRoot: appDir,
      stateDir: state.stateDir,
    });
    const swept = await runSweep({ runId: run.id, stateDir: state.stateDir });
    assert.equal(swept.done, true);
    assert.equal(swept.visited.length, 3, 'обход должен пройти add, show и list');
    assert.ok(swept.findings >= 7, `обход нашёл слишком мало: ${swept.findings}`);

    const findings = await readFindings(run.id, state.stateDir);
    const c1 = findings.find((finding) =>
      finding.targetRef === 'show <name>'
      && finding.kind === 'exit-code-unexpected'
      && finding.detail.includes('show missing'));
    assert.ok(c1, 'обход не нашёл C1: show missing завершился не тем кодом');

    const promoted = await promoteFindingToCandidate({
      runId: run.id,
      findingId: c1.id,
      title: 'Неизвестный заказ печатает стек вместо кода 2',
      expected: 'show missing завершается кодом 2 с понятной ошибкой',
      actual: 'show missing завершается кодом 1 и печатает TypeError со стеком',
      check: { kind: 'exitCode', target: 'show <name>', expected: 2 },
      stateDir: state.stateDir,
    });

    const replay = createCliReplay();
    const reproduced = await reproduceCandidate({
      runId: run.id,
      candidateId: promoted.candidateId,
      attempts: 2,
      stateDir: state.stateDir,
      replay,
    });
    assert.match(reproduced.reproduced, /^2\/2$/);
    await replay.close();

    const confirmed = await triageCandidate({
      runId: run.id,
      candidateId: promoted.candidateId,
      verdict: 'confirmed',
      reason: 'сценарий объявляет код 2, наблюдается 1 и стек',
      stateDir: state.stateDir,
    });
    assert.equal(confirmed.status, 'confirmed');

    const exported = await exportCliTest({
      runId: run.id,
      bugId: promoted.candidateId,
      stateDir: state.stateDir,
    });
    assert.equal(exported.placedInProject, true);
    assert.ok(exported.file.startsWith(appDir), exported.file);
    const source = await readFile(exported.file, 'utf8');
    assert.match(source, /assert\.equal\(last\.exitCode, 2/);

    const verdict = await verifyCliRed(exported.file, { kind: 'cli' });
    assert.equal(verdict.status, 'red', verdict.message);
    assert.match(verdict.message, /Неизвестный заказ/);
  } finally {
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
    await Promise.all([
      rm(appDir, { recursive: true, force: true }),
      rm(tmp, { recursive: true, force: true }),
      state.cleanup(),
    ]);
  }
});
