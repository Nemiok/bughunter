import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { SessionManager, resolveLaunchOptions } from '../src/browser/session.ts';
import type { Profile } from '../src/profile/types.ts';
import { loadConfig } from '../src/config.ts';
import { writeJsonAtomic } from '@bughunter/core';
import { createRun } from '../src/runs.ts';
import type { Config } from '@bughunter/core';

const temporaryDirectories: string[] = [];

after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function baseConfig(patch: Partial<Config> = {}): Config {
  return {
    baseUrl: 'http://127.0.0.1:1',
    allowedOrigins: ['http://127.0.0.1:1'],
    routes: ['/'],
    routeMap: {},
    baseBranch: 'main',
    limits: { stepsPerSession: 60, candidatesPerRun: 20 },
    safety: { forbiddenActionText: [], readOnly: false },
    testDataPrefix: 'bh_',
    detectors: {
      ignoreConsole: [],
      ignoreRequests: [],
      anomalyTexts: ['NaN'],
      errorBoundarySelector: '[data-error-boundary]',
    },
    tests: { unit: { command: null }, e2e: { dir: 'e2e/bughunter' } },
    ...patch,
  };
}

const profile: Profile = {
  name: 'probe-profile',
  extractors: [],
  oracles: [],
  browser: { launchArgs: ['--user-agent=ProfileAgent/2.0', '--lang=ru-RU'] },
};

test('resolveLaunchOptions merges profile args over config args and dedupes by flag', () => {
  const options = resolveLaunchOptions(
    baseConfig({ browser: { launchArgs: ['--user-agent=ConfigAgent/1.0', '--window-size=1280,800'] } }),
    profile,
  );
  const userAgentArgs = options.args.filter((argument) => argument.startsWith('--user-agent'));
  assert.deepEqual(userAgentArgs, ['--user-agent=ProfileAgent/2.0']);
  assert.ok(options.args.includes('--window-size=1280,800'));
  assert.ok(options.args.includes('--lang=ru-RU'));
  assert.ok(options.args.includes('--no-first-run'));
  assert.ok(options.args.includes('--no-default-browser-check'));
});

test('resolveLaunchOptions rejects security-disabling args', () => {
  for (const argument of ['--disable-web-security', '--allow-running-insecure-content', '--remote-debugging-port=9222']) {
    assert.throws(
      () => resolveLaunchOptions(baseConfig({ browser: { launchArgs: [argument] } }), null),
      new RegExp(`LAUNCH_ARG_FORBIDDEN: ${argument.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
  }
});

test('resolveLaunchOptions passes proxy and ignoreHTTPSErrors through', () => {
  const options = resolveLaunchOptions(
    baseConfig({ browser: { proxy: 'http://proxy.local:3128', ignoreHTTPSErrors: true } }),
    null,
  );
  assert.deepEqual(options.proxy, { server: 'http://proxy.local:3128' });
  assert.equal(options.ignoreHTTPSErrors, true);
  const plain = resolveLaunchOptions(baseConfig(), null);
  assert.equal(plain.proxy, undefined);
  assert.equal(plain.ignoreHTTPSErrors, false);
});

test('config accepts a browser section and rejects unknown browser fields', async () => {
  const stateDir = await temporaryDirectory('bh-browser-config-');
  await writeFile(
    join(stateDir, 'config.json'),
    JSON.stringify(baseConfig({ browser: { launchArgs: ['--lang=ru-RU'], ignoreHTTPSErrors: true } })),
    'utf8',
  );
  assert.deepEqual((await loadConfig(stateDir)).browser, { launchArgs: ['--lang=ru-RU'], ignoreHTTPSErrors: true });
  const invalidBrowserSection = { ...baseConfig(), browser: { unknownFlag: true } };
  await writeFile(join(stateDir, 'config.json'), JSON.stringify(invalidBrowserSection), 'utf8');
  await assert.rejects(() => loadConfig(stateDir));
});

test('launch args reach the launched Chrome', async () => {
  const stateDir = await temporaryDirectory('bh-browser-launch-');
  const seenUserAgents: string[] = [];
  let server: Server | undefined;
  try {
    server = createServer((request, response) => {
      seenUserAgents.push(String(request.headers['user-agent']));
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<main>ok</main>');
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const origin = `http://127.0.0.1:${address.port}`;
    const config = baseConfig({
      baseUrl: origin,
      allowedOrigins: [origin],
      browser: { launchArgs: ['--user-agent=BughunterProbe/1.0'] },
    });
    await writeJsonAtomic(join(stateDir, 'config.json'), config);
    const run = await createRun('route', '/', { config, projectRoot: stateDir, stateDir });
    const manager = new SessionManager(config, stateDir);
    try {
      const { sessionId } = await manager.open(run.id, '/', 'launch-args');
      assert.ok(
        seenUserAgents.some((userAgent) => userAgent.includes('BughunterProbe/1.0')),
        `Chrome не получил launch args, увидели: ${seenUserAgents.join(' | ')}`,
      );
      await manager.close(sessionId);
    } finally {
      await manager.closeAll();
    }
  } finally {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
    }
  }
});
