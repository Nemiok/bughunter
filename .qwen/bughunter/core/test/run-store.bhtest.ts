import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { ReportFormat } from '../src/preset.ts';
import {
  createRun, finishRun, recordCandidateTest, recordTargetExploration,
} from '../src/run-store.ts';
import type { Candidate, Config, Finding } from '../src/types.ts';

const config = { targetMap: {}, baseBranch: 'main' } as unknown as Config;
const createdAt = '2026-11-13T00:00:00.000Z';

async function withStateDir(run: (stateDir: string) => Promise<void>): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), 'bh-core-run-store-'));
  try {
    await run(stateDir);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

async function writeConfirmedCandidate(runId: string, stateDir: string, id = 'cand-1'): Promise<void> {
  const candidate: Candidate = {
    id,
    runId,
    sessionId: 'sess-1',
    target: '/a',
    title: 'Заголовок кандидата',
    expected: 'ожидалось одно',
    actual: 'получилось другое',
    signalIds: [],
    signature: 'signature-1',
    steps: [],
    artifacts: [],
    status: 'confirmed',
    createdAt,
    reproduction: { status: 'reproduced', attempts: 3 },
    review: { status: 'confirmed', reason: 'воспроизведено 3/3' },
    tests: { e2e: `runs/${runId}/e2e/${id}.spec.ts` },
  };
  const directory = join(stateDir, 'runs', runId, 'candidates');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${id}.json`), `${JSON.stringify(candidate, null, 2)}\n`, 'utf8');
}

test('the persona roster comes from the caller, not from the store', () => withStateDir(async (stateDir) => {
  const run = await createRun('full', undefined, {
    config,
    projectRoot: stateDir,
    stateDir,
    personas: ['персона А', 'персона Б'],
    targets: ['/a'],
  });
  assert.deepEqual(run.exploreQueue?.map((item) => item.persona), ['персона А', 'персона Б']);
  assert.deepEqual(run.exploreQueue?.map((item) => item.target), ['/a', '/a']);
}));

test('the report renders candidates and findings through the preset format', () => withStateDir(async (stateDir) => {
  const format: ReportFormat = {
    candidate: () => ['SENTINEL_STEPS'],
    finding: () => ['SENTINEL_FINDING'],
  };
  const run = await createRun('full', undefined, { config, projectRoot: stateDir, stateDir, personas: ['p'], targets: ['/a'] });
  await writeConfirmedCandidate(run.id, stateDir);
  const finding: Finding = {
    id: 'find-1',
    runId: run.id,
    targetRef: '/a',
    kind: 'response-captured',
    detail: 'детали находки',
    responseHashes: [],
    status: 'new',
    createdAt,
  };
  const findings = join(stateDir, 'runs', run.id, 'findings');
  await mkdir(findings, { recursive: true });
  await writeFile(join(findings, `${finding.id}.json`), `${JSON.stringify(finding, null, 2)}\n`, 'utf8');
  await recordTargetExploration(run.id, '/a', 'done', stateDir);

  const { report } = await finishRun(run.id, stateDir, format);
  const contents = await readFile(report, 'utf8');
  assert.match(contents, /SENTINEL_STEPS/);
  assert.match(contents, /SENTINEL_FINDING/);
  assert.match(contents, /## Confirmed/);
  assert.match(contents, /## Pending\n\nNone\./);
}));

test('a test kind is an arbitrary preset string', () => withStateDir(async (stateDir) => {
  const run = await createRun('full', undefined, { config, projectRoot: stateDir, stateDir, personas: ['p'], targets: ['/a'] });
  await writeConfirmedCandidate(run.id, stateDir);
  await recordCandidateTest(run.id, 'cand-1', 'api', join(stateDir, 'runs', run.id, 'api', 'x.test.ts'), stateDir);
  const raw = JSON.parse(await readFile(
    join(stateDir, 'runs', run.id, 'candidates', 'cand-1.json'),
    'utf8',
  )) as { tests: Record<string, string> };
  assert.equal(raw.tests.api, 'api/x.test.ts');
  assert.ok(raw.tests.e2e !== undefined, 'прежний вид теста сохраняется');
}));
