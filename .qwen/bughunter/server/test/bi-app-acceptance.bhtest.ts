import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import type { ViteDevServer } from '../fixtures/bi-app/node_modules/vite/dist/node/index.d.ts';
import { SCENARIO_KEY } from '../fixtures/bi-app/src/mocks/scenarios.ts';
import { writeJsonAtomic } from '../src/run-store.ts';
import { templatisedPathname } from '../src/discovery/screens-store.ts';
import { loadActiveProfile, loadProfile } from '../src/profile/load.ts';
import type { Config } from '../src/types.ts';

const fixtureRoot = resolve(import.meta.dirname, '../fixtures/bi-app');
const profileSource = join(fixtureRoot, 'bughunter-profile');

const temporaryDirectories: string[] = [];
const servers: ViteDevServer[] = [];

after(async () => {
  await Promise.all(servers.map((server) => server.close()));
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

export type BiAcceptanceContext = {
  baseUrl: string;
  stateDir: string;
  config: Config;
  close(): Promise<void>;
};

/**
 * Стенд приёмки: живой vite фикстуры плюс временный stateDir, в который профиль приложения
 * скопирован так же, как его кладёт пользователь настоящего проекта. Каталог `state/`
 * репозитория не затрагивается, поэтому прогоны приёмки не оставляют следов в доказательствах.
 */
export async function biAcceptanceContext(): Promise<BiAcceptanceContext> {
  const { createServer } = await import('../fixtures/bi-app/node_modules/vite/dist/node/index.js');
  const server: ViteDevServer = await createServer({
    root: fixtureRoot,
    configFile: resolve(fixtureRoot, 'vite.config.ts'),
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  servers.push(server);
  const address = server.httpServer?.address();
  assert.ok(address && typeof address === 'object', 'vite не отдал адрес порта');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const stateDir = await mkdtemp(join(tmpdir(), 'bh-bi-acceptance-'));
  temporaryDirectories.push(stateDir);

  // Профиль копируется только если он уже написан: первый тест задачи проверяет именно
  // отсутствие профиля и обязан получить PROFILE_NOT_FOUND, а не ошибку копирования.
  const entry = join(stateDir, 'profiles', 'bi');
  await mkdir(entry, { recursive: true });
  await cp(join(profileSource, 'index.ts'), join(entry, 'index.ts')).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });

  const config: Config = {
    baseUrl,
    allowedOrigins: [baseUrl],
    routes: ['/dashboards', '/dashboard/1', '/reports', '/report/r-001', '/wizard', '/settings', '/clean'],
    routeMap: {},
    baseBranch: 'main',
    profile: 'bi',
    limits: {
      stepsPerSession: 60,
      candidatesPerRun: 20,
      elementsPerSnapshot: 120,
      responseSettleMs: 400,
      screensPerSweep: 25,
    },
    safety: { forbiddenActionText: ['удалить', 'delete'], readOnly: false },
    testDataPrefix: 'bh_',
    detectors: {
      ignoreConsole: [],
      ignoreRequests: [],
      anomalyTexts: ['undefined', 'NaN', '[object Object]', 'Invalid Date'],
      errorBoundarySelector: '[data-error-boundary]',
    },
    tests: { unit: { command: null }, e2e: { dir: 'e2e/bughunter' } },
  };
  await writeJsonAtomic(join(stateDir, 'config.json'), config);

  return {
    baseUrl,
    stateDir,
    config,
    async close() {
      const index = servers.indexOf(server);
      if (index >= 0) servers.splice(index, 1);
      await server.close();
    },
  };
}

test('profile for the fixture loads and passes the schema', async () => {
  const context = await biAcceptanceContext();
  try {
    const profile = await loadProfile(context.stateDir, 'bi');
    assert.equal(profile.name, 'bi');
    assert.deepEqual(
      profile.extractors.map((extractor) => extractor.widget).sort(),
      ['bars', 'line', 'scene', 'table'],
    );
    assert.deepEqual(profile.reset, { kind: 'storage-flag', key: SCENARIO_KEY });
    // Решение спайка S1: основной источник эталона — контекстные слушатели Playwright,
    // страничный хук MSW остаётся запасным путём и профилем не включается.
    assert.equal(profile.responseSource, 'playwright');
    assert.equal(typeof profile.interactions?.resolvePoint, 'string');
    assert.ok(profile.oracles.some((oracle) => oracle.widget === 'table'), 'нужна привязка оракула к таблице');

    const pattern = profile.navigation?.idSegmentPattern;
    assert.ok(pattern, 'профиль обязан задавать navigation.idSegmentPattern');
    assert.equal(templatisedPathname('/dashboard/12', pattern), '/dashboard/:id');
    assert.equal(templatisedPathname('/dashboard/7f3ab4c9d2', pattern), '/dashboard/:id');
    // Слаг отчёта — не идентификатор: шаблонизация не должна сливать разные экраны отчётов.
    assert.equal(templatisedPathname('/report/r-001', pattern), '/report/r-001');

    assert.deepEqual(await loadActiveProfile(context.stateDir), profile);
  } finally {
    await context.close();
  }
});
