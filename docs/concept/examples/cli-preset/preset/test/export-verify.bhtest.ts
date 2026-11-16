import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { reportCandidate, reproduceCandidate, triageCandidate } from '@bughunter/core';

import { createCliReplay } from '../src/replay.ts';
import { exportCliTest } from '../src/export-cli.ts';
import { openCliSession, reportCliCandidate } from '../src/session.ts';
import { verifyCliRed } from '../src/test-runner.ts';
import { createRun } from '../src/runs.ts';
import { fixtureDir, presetRoot, stateFor } from './harness.ts';

async function temporaryApp(root: string): Promise<string> {
  const appDir = await mkdtemp(join(root, '.test-app-'));
  await mkdir(join(appDir, 'src'), { recursive: true });
  await copyFile(join(fixtureDir, 'src', 'cli.js'), join(appDir, 'src', 'cli.js'));
  await writeFile(
    join(appDir, 'package.json'),
    `${JSON.stringify({ name: 'bh-cli-export-test', private: true, type: 'module', bughunter: { target: 'cli' } }, null, 2)}\n`,
    'utf8',
  );
  return appDir;
}

test('confirmed candidate exports a project test and verify_red reports it red', async () => {
  const appDir = await temporaryApp(presetRoot);
  const state = await stateFor((config) => { config.appDir = appDir; });
  const previousTmp = process.env.TMPDIR;
  const tmp = await mkdtemp(join(presetRoot, '.test-tmp-'));
  process.env.TMPDIR = tmp;
  try {
    const run = await createRun('target', 'add <name> <qty>', {
      config: state.config,
      projectRoot: appDir,
      stateDir: state.stateDir,
    });
    const session = await openCliSession({
      runId: run.id,
      target: 'add <name> <qty>',
      persona: 'ревизор',
      stateDir: state.stateDir,
    });
    const { execution, signals } = await session.act({ argv: ['add', 'x', 'abc'] });
    assert.equal(execution.exitCode, 0);
    assert.ok(signals.some((signal) => signal.kind === 'anomaly'));
    const reported = await reportCliCandidate(session, {
      title: 'Нечисловое количество принимается',
      expected: 'add x abc завершается кодом 2',
      actual: `add x abc завершается кодом ${execution.exitCode} и печатает ${execution.stdout.trim()}`,
      signalIds: [],
      check: { kind: 'exitCode', target: 'add <name> <qty>', expected: 2 },
    });
    await session.close();

    const reproduced = await reproduceCandidate({
      runId: run.id,
      candidateId: reported.candidateId,
      attempts: 2,
      stateDir: state.stateDir,
      replay: createCliReplay(),
    });
    assert.match(reproduced.reproduced, /^2\/2$/);

    const confirmed = await triageCandidate({
      runId: run.id,
      candidateId: reported.candidateId,
      verdict: 'confirmed',
      reason: 'контракт требован код 2',
      stateDir: state.stateDir,
    });
    assert.equal(confirmed.status, 'confirmed');

    const exported = await exportCliTest({ runId: run.id, bugId: reported.candidateId, stateDir: state.stateDir });
    assert.equal(exported.placedInProject, true);
    assert.ok(exported.file.startsWith(appDir), exported.file);
    const source = await readFile(exported.file, 'utf8');
    assert.match(source, /assert\.equal\(last\.exitCode, 2/);
    assert.ok((await stat(exported.file)).isFile());

    const verdict = await verifyCliRed(exported.file, { kind: 'cli' });
    assert.equal(verdict.status, 'red', verdict.message);
    assert.match(verdict.message, /Нечисловое количество принимается/);
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
