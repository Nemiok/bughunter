import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { upsertScreens } from '../src/discovery/screens-store.ts';
import {
  readCandidate, readFindings, readRun, triageCandidate, writeJsonAtomic,
} from '@bughunter/core';
import { createRun, finishRun } from '../src/runs.ts';
import { reproduceCandidate } from '../src/reproduce.ts';
import { applyReset } from '../src/reset.ts';
import { promoteFindingToCandidate } from '../src/runs.ts';
import { runSweep, webInventory } from '../src/sweep-visit.ts';
import type { WebConfig as Config } from '../src/config.ts';

const directories: string[] = [];
const resets: string[] = [];
const seeds: string[] = [];
let server: Server;
let origin: string;

function page(title: string, body: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title></head>
<body style="margin:0;position:relative;width:900px;height:600px">
<main>${body}</main>
<script>
  const seed = 'none';
  let stored = seed;
  try { stored = localStorage.getItem('bhScenario') ?? seed; } catch { /* закрытое хранилище */ }
  fetch('/api/rows?seed=' + encodeURIComponent(stored)).catch(() => undefined);
</script>
</body></html>`;
}

const orderTable = `<table data-testid="orders"><tbody>
<tr><td>1</td><td>10</td></tr>
<tr><td>2</td><td>20</td></tr>
</tbody></table>`;

before(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/__reset') {
      resets.push(`${request.method} ${url.pathname}`);
      response.writeHead(204).end();
      return;
    }
    if (url.pathname === '/api/rows') {
      seeds.push(url.searchParams.get('seed') ?? 'none');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ rows: [{ id: 1, total: 10 }, { id: 2, total: 20 }] }));
      return;
    }
    const body = url.pathname === '/profile'
      ? page('profile', `${orderTable}<button data-testid="save">Save</button>`)
      : page(url.pathname === '/' ? 'home' : 'order', `<h1>${url.pathname}</h1>`);
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(body);
  });
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server?.listening) {
    await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  }
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

function configTemplate(profileName?: string): Config {
  return {
    baseUrl: origin,
    allowedOrigins: [origin],
    routes: ['/'],
    targetMap: {},
    baseBranch: 'main',
    ...(profileName === undefined ? {} : { profile: profileName }),
    limits: { stepsPerSession: 60, candidatesPerRun: 20, responseSettleMs: 1500 },
    safety: { forbiddenActionText: ['delete'], readOnly: false },
    testDataPrefix: 'bh_',
    detectors: {
      ignoreConsole: [],
      ignoreRequests: [],
      anomalyTexts: ['undefined', 'NaN', '[object Object]', 'Invalid Date'],
      errorBoundarySelector: '[data-error-boundary]',
    },
    tests: { unit: { command: null }, generated: { dir: 'e2e/bughunter' } },
  };
}

async function setup(options: { profile?: string; screens?: Array<{ template: string; sampleUrl: string }> } = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'bh-sweep-'));
  directories.push(stateDir);
  const config = configTemplate(options.profile);
  await writeJsonAtomic(join(stateDir, 'config.json'), config);
  await writeJsonAtomic(join(stateDir, 'known-bugs.json'), []);
  await writeJsonAtomic(join(stateDir, 'suppressions.json'), []);
  await upsertScreens(stateDir, (options.screens ?? [
    { template: '/', sampleUrl: `${origin}/` },
    { template: '/profile', sampleUrl: `${origin}/profile` },
    { template: '/orders/:id', sampleUrl: `${origin}/orders/12` },
  ]).map((screen) => ({ ...screen, discoveredVia: ['test'], widgets: [] })));
  const run = await createRun('sweep', undefined, { config, projectRoot: stateDir, stateDir });
  return { stateDir, config, run };
}

test('sweep visits every inventoried screen without a model and records responses', async () => {
  const { stateDir, run } = await setup();

  const result = await runSweep({ runId: run.id, stateDir });

  assert.equal(result.targets, 3);
  assert.deepEqual([...result.visited].sort(), ['/', '/orders/:id', '/profile']);
  assert.equal(result.done, true);
  assert.equal(result.nextCursor, undefined);
  assert.ok(result.findings >= 3, JSON.stringify(result));

  const findings = await readFindings(run.id, stateDir);
  for (const template of result.visited) {
    const own = findings.filter((finding) => finding.targetRef === template);
    assert.ok(own.length > 0, `нет находок для ${template}`);
    assert.ok(own.every((finding) => finding.status === 'new'), template);
  }
  const captured = findings.find((finding) => finding.kind === 'response-captured');
  assert.match(captured?.detail ?? '', /Ответов: \d+, с телом: \d+/);

  const after = await readRun(run.id, stateDir);
  assert.equal(after.stages.sweep, 'done');
  assert.equal(after.stages.findings, 'done');
});

test('sweep applies the profile reset before each screen and reports a missing recipe', async () => {
  const withoutRecipe = await setup();
  seeds.length = 0;
  await runSweep({ runId: withoutRecipe.run.id, stateDir: withoutRecipe.stateDir });
  assert.equal(seeds.length, 3);
  assert.deepEqual([...new Set(seeds)], ['none'], 'без рецепта профиля приложение не видит флага сброса');

  const stateDir = await mkdtemp(join(tmpdir(), 'bh-sweep-'));
  directories.push(stateDir);
  const profileSource = `export default ${JSON.stringify({
    name: 'sweep',
    extractors: [],
    oracles: [],
    reset: { kind: 'storage-flag', key: 'bhScenario' },
  })};\n`;
  await mkdir(join(stateDir, 'profiles', 'sweep'), { recursive: true });
  await writeFile(join(stateDir, 'profiles', 'sweep', 'index.ts'), profileSource, 'utf8');
  const config = configTemplate('sweep');
  await writeJsonAtomic(join(stateDir, 'config.json'), config);
  await writeJsonAtomic(join(stateDir, 'known-bugs.json'), []);
  await writeJsonAtomic(join(stateDir, 'suppressions.json'), []);
  await upsertScreens(stateDir, [
    { template: '/', sampleUrl: `${origin}/`, discoveredVia: ['test'], widgets: [] },
    { template: '/profile', sampleUrl: `${origin}/profile`, discoveredVia: ['test'], widgets: [] },
  ]);
  const run = await createRun('sweep', undefined, { config, projectRoot: stateDir, stateDir });

  seeds.length = 0;
  await runSweep({ runId: run.id, stateDir });

  // Первый запрос уходит на baseUrl до записи флага (about:blank не имеет хранилища),
  // поэтому смотрим только на запросы самих экранов: каждый получает свежий флаг.
  const screenSeeds = seeds.filter((seed) => seed !== 'none');
  assert.equal(screenSeeds.length, 2);
  assert.equal(new Set(screenSeeds).size, 2, 'каждый экран получил свежий флаг сброса');

  const unsupported = await setup();
  const result = await runSweep({ runId: unsupported.run.id, stateDir: unsupported.stateDir });
  const findings = await readFindings(unsupported.run.id, unsupported.stateDir);
  assert.ok(result.findings >= 3);
  assert.equal(findings.filter((finding) => finding.kind === 'reset-unsupported').length, 1);
  assert.equal(findings.find((finding) => finding.kind === 'reset-unsupported')?.detail, 'RESET_UNSUPPORTED');
});

test('interrupted sweep resumes from its cursor and finishRun accepts sweep scope', async () => {
  const { stateDir, run } = await setup();

  await assert.rejects(() => finishRun(run.id, stateDir), /RUN_INCOMPLETE: sweep/);

  const first = await runSweep({ runId: run.id, stateDir, limit: 1 });
  assert.equal(first.visited.length, 1);
  assert.equal(first.done, false);
  assert.equal(first.nextCursor, 1);
  await assert.rejects(() => finishRun(run.id, stateDir), /RUN_INCOMPLETE: sweep/);

  const second = await runSweep({ runId: run.id, stateDir });
  assert.equal(second.visited.length, 2);
  assert.deepEqual(second.visited.filter((template) => first.visited.includes(template)), []);
  assert.equal(second.done, true);

  const { report } = await finishRun(run.id, stateDir);
  const contents = await readFile(report, 'utf8');
  assert.match(contents, /^- Scope: sweep$/m);
  assert.match(contents, /## Findings/);
  assert.equal((await readRun(run.id, stateDir)).status, 'finished');
});

test('sweep reports an unreachable screen as visited and keeps going', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'bh-sweep-'));
  directories.push(stateDir);
  const config = configTemplate();
  await writeJsonAtomic(join(stateDir, 'config.json'), config);
  await writeJsonAtomic(join(stateDir, 'known-bugs.json'), []);
  await writeJsonAtomic(join(stateDir, 'suppressions.json'), []);
  await upsertScreens(stateDir, [
    // Порт 1 заведомо недоступен: переход упадёт сразу, без ожидания таймаута.
    { template: '/dead', sampleUrl: 'http://127.0.0.1:1/dead', discoveredVia: ['test'], widgets: [] },
    { template: '/', sampleUrl: `${origin}/`, discoveredVia: ['test'], widgets: [] },
  ]);
  const run = await createRun('sweep', undefined, { config, projectRoot: stateDir, stateDir });

  const result = await runSweep({ runId: run.id, stateDir });

  // Курсор сдвинут, значит экран обработан: вызывающая сторона не должна думать, что его не прошли.
  assert.deepEqual(result.visited, ['/dead', '/']);
  assert.equal(result.done, true);
  const findings = await readFindings(run.id, stateDir);
  assert.equal(findings.filter((finding) => finding.kind === 'navigation-failed').length, 1);
  assert.ok(findings.some((finding) => finding.targetRef === '/' && finding.kind === 'response-captured'));
});

test('findings are not candidates until promoted', async () => {
  const { stateDir, run } = await setup();
  await runSweep({ runId: run.id, stateDir });
  const [finding] = await readFindings(run.id, stateDir);
  assert.ok(finding);

  await assert.rejects(
    () => triageCandidate({ runId: run.id, candidateId: finding!.id, verdict: 'rejected', reason: 'не баг', stateDir }),
    /FINDING_NOT_CANDIDATE/,
  );

  const { candidateId } = await promoteFindingToCandidate({
    runId: run.id,
    findingId: finding!.id,
    title: 'Экран не отдаёт данные',
    expected: 'Данные ответа видны на экране',
    actual: 'Ответ не доходит до экрана',
    // Проверка заведомо нарушена на любом экране: тест про продвижение находки в общий поток,
    // а не про качество оракула.
    check: { kind: 'visibleText', target: 'Отсутствующий текст' },
    stateDir,
  });

  const candidate = await readCandidate(run.id, candidateId, stateDir);
  assert.equal(candidate.status, 'unprocessed');
  assert.equal(candidate.reproduction?.status, 'unreproduced');
  assert.deepEqual(candidate.steps.map((step) => step.kind), ['navigate']);
  assert.equal(candidate.check?.kind, 'visibleText');

  const promoted = (await readFindings(run.id, stateDir)).find((entry) => entry.id === finding!.id);
  assert.equal(promoted?.status, 'promoted');
  assert.equal(promoted?.candidateId, candidateId);

  // Повторное продвижение той же находки не плодит кандидатов.
  assert.deepEqual(await promoteFindingToCandidate({
    runId: run.id, findingId: finding!.id, title: 'x', expected: 'y', actual: 'z', stateDir,
    check: { kind: 'visibleText', target: 'Отсутствующий текст' },
  }), { candidateId });

  const reproduced = await reproduceCandidate({ runId: run.id, candidateId, attempts: 1, stateDir });
  assert.equal(reproduced.reproduced, '1/1');
  assert.equal(reproduced.steps, 1);

  const triaged = await triageCandidate({
    runId: run.id, candidateId, verdict: 'rejected', reason: 'не воспроизводится без данных', stateDir,
  });
  assert.equal(triaged.status, 'rejected');

  await assert.rejects(
    () => promoteFindingToCandidate({
      runId: run.id, findingId: 'missing', title: 'x', expected: 'y', actual: 'z', stateDir,
      check: { kind: 'visibleText', target: 'Отсутствующий текст' },
    }),
    /FINDING_NOT_FOUND: missing/,
  );
});

test('screen scope restricts the run to one template', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'bh-sweep-'));
  directories.push(stateDir);
  const config = configTemplate();
  await writeJsonAtomic(join(stateDir, 'config.json'), config);
  await writeJsonAtomic(join(stateDir, 'known-bugs.json'), []);
  await writeJsonAtomic(join(stateDir, 'suppressions.json'), []);
  await upsertScreens(stateDir, [
    { template: '/', sampleUrl: `${origin}/`, discoveredVia: ['test'], widgets: [] },
    { template: '/orders/:id', sampleUrl: `${origin}/orders/12`, discoveredVia: ['test'], widgets: [] },
  ]);

  const run = await createRun('sweep', '/orders/:id', { config, projectRoot: stateDir, stateDir });
  assert.deepEqual(run.targets, ['/orders/:id']);
  assert.equal(run.exploreQueue, undefined);
  assert.equal(run.stages.sweep, 'pending');
  assert.equal(run.stages.explore, undefined);

  const result = await runSweep({ runId: run.id, stateDir });
  assert.deepEqual(result.visited, ['/orders/:id']);
  assert.equal(result.targets, 1);
  assert.equal(result.done, true);

  const after = await readRun(run.id, stateDir);
  assert.equal(after.targetStages['/orders/:id'], 'done');
  const { report } = await finishRun(run.id, stateDir);
  assert.match(await readFile(report, 'utf8'), /^- Scope: sweep$/m);

  const missing = await createRun('sweep', '/unknown/:id', { config, projectRoot: stateDir, stateDir });
  await assert.rejects(() => runSweep({ runId: missing.id, stateDir }), /SCREEN_NOT_FOUND: \/unknown\/:id/);
  await assert.rejects(() => createRun('target', undefined, { config, projectRoot: stateDir, stateDir }), /TARGET_REQUIRED/);
});

test('applyReset writes the storage flag, calls the mock endpoint and refuses without a recipe', async () => {
  const browser = await chromium.launch({ channel: 'chrome', args: ['--no-first-run', '--no-default-browser-check'] });
  const page = await (await browser.newContext()).newPage();
  try {
    await applyReset(page, { name: 'x', extractors: [], oracles: [], reset: { kind: 'storage-flag', key: 'bhScenario' } }, origin);
    assert.match(String(await page.evaluate(() => localStorage.getItem('bhScenario'))), /^\d{4}-\d{2}-\d{2}T/);

    resets.length = 0;
    await applyReset(page, { name: 'x', extractors: [], oracles: [], reset: { kind: 'mock-endpoint', url: '/__reset' } }, origin);
    assert.deepEqual(resets, ['POST /__reset']);

    await assert.rejects(() => applyReset(page, { name: 'x', extractors: [], oracles: [] }, origin), /RESET_UNSUPPORTED/);
    await assert.rejects(() => applyReset(page, null, origin), /RESET_UNSUPPORTED/);
    await assert.rejects(
      () => applyReset(page, { name: 'x', extractors: [], oracles: [], reset: { kind: 'storage-flag' } }, origin),
      /RESET_UNSUPPORTED/,
    );
  } finally {
    await browser.close();
  }
});

test('sweep refuses a run of a model-driven scope', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'bh-sweep-'));
  directories.push(stateDir);
  const config = { ...configTemplate(), routes: ['/'] };
  await writeJsonAtomic(join(stateDir, 'config.json'), config);
  const run = await createRun('target', '/', { config, projectRoot: stateDir, stateDir });

  await assert.rejects(() => runSweep({ runId: run.id, stateDir }), /SWEEP_SCOPE_REQUIRED: target/);
});

test('the inventory lists screen templates and folds identifier segments', async () => {
  const { stateDir } = await setup();

  assert.deepEqual(await webInventory.list(stateDir), ['/', '/profile', '/orders/:id']);
  assert.equal(webInventory.templateOf(`${origin}/orders/7f3ab4c9d2`), '/orders/:id');
  assert.equal(webInventory.templateOf('/orders/new?x=1'), '/orders/new');
});

test('an empty inventory tells the model to crawl first', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'bh-sweep-'));
  directories.push(stateDir);
  const config = configTemplate();
  await writeJsonAtomic(join(stateDir, 'config.json'), config);
  const run = await createRun('sweep', undefined, { config, projectRoot: stateDir, stateDir });

  await assert.rejects(
    () => runSweep({ runId: run.id, stateDir }),
    /SCREEN_NOT_FOUND: пустой инвентарь — сначала bh_crawl/,
  );
});
