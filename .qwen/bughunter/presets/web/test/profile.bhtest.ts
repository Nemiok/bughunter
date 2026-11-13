import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { loadActiveProfile, loadProfile } from '../src/profile/load.ts';
import type { WebConfig as Config } from '../src/config.ts';

const temporaryDirectories: string[] = [];

after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function baseConfig(): Config {
  return {
    baseUrl: 'https://dev-stand.example.local',
    allowedOrigins: ['https://dev-stand.example.local'],
    routes: ['/', '/orders'],
    targetMap: {},
    baseBranch: 'main',
    limits: { stepsPerSession: 60, candidatesPerRun: 20 },
    safety: { forbiddenActionText: ['delete'], readOnly: false },
    testDataPrefix: 'bh_',
    detectors: {
      ignoreConsole: [],
      ignoreRequests: [],
      anomalyTexts: ['NaN'],
      errorBoundarySelector: '[data-error-boundary]',
    },
    tests: { unit: { command: null }, generated: { dir: 'e2e/bughunter' } },
  };
}

const validProfileSource = `export default {
  name: 'demo',
  extractors: [
    { name: 'orders-table', widget: 'orders', kind: 'table', script: '() => ({ rows: 1 })' },
  ],
  oracles: [{ urlPattern: '/api/widgets', widget: 'orders', fields: ['rows[].value'] }],
  contract: [{ path: 'rows[].value', format: 'number', rounding: 2 }],
  reset: { kind: 'storage-flag', key: 'bhScenario' },
};
`;

async function writeProfile(stateDir: string, name: string, source: string): Promise<void> {
  const directory = join(stateDir, 'profiles', name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'index.ts'), source, 'utf8');
}

test('loads a valid profile module from state/profiles/<name>/index.ts', async () => {
  const stateDir = await temporaryDirectory('bh-profile-');
  await writeProfile(stateDir, 'demo', validProfileSource);
  const profile = await loadProfile(stateDir, 'demo');
  assert.equal(profile.name, 'demo');
  assert.equal(profile.extractors.length, 1);
  assert.equal(profile.extractors[0]!.kind, 'table');
  assert.equal(profile.oracles[0]!.urlPattern, '/api/widgets');
  assert.equal(profile.contract?.[0]!.rounding, 2);
  assert.deepEqual(profile.reset, { kind: 'storage-flag', key: 'bhScenario' });
});

test('rejects a missing profile with PROFILE_NOT_FOUND', async () => {
  const stateDir = await temporaryDirectory('bh-profile-');
  await assert.rejects(() => loadProfile(stateDir, 'absent'), /PROFILE_NOT_FOUND: absent/);
});

test('rejects a profile name escaping the profiles directory', async () => {
  const stateDir = await temporaryDirectory('bh-profile-');
  await assert.rejects(() => loadProfile(stateDir, '../escape'), /PROFILE_NOT_FOUND: \.\.\/escape/);
  await assert.rejects(() => loadProfile(stateDir, '.'), /PROFILE_NOT_FOUND/);
});

test('rejects an invalid profile with PROFILE_INVALID naming the field', async () => {
  const stateDir = await temporaryDirectory('bh-profile-');
  await writeProfile(stateDir, 'broken', 'export default { name: "broken", oracles: [] };\n');
  await assert.rejects(() => loadProfile(stateDir, 'broken'), /PROFILE_INVALID[\s\S]*extractors/);
});

test('loadActiveProfile follows config.profile and returns null when it is absent', async () => {
  const stateDir = await temporaryDirectory('bh-profile-');
  await writeFile(join(stateDir, 'config.json'), `${JSON.stringify(baseConfig(), null, 2)}\n`, 'utf8');
  assert.equal(await loadActiveProfile(stateDir), null);
  await writeFile(join(stateDir, 'config.json'), `${JSON.stringify({ ...baseConfig(), profile: 'demo' }, null, 2)}\n`, 'utf8');
  await writeProfile(stateDir, 'demo', validProfileSource);
  const profile = await loadActiveProfile(stateDir);
  assert.equal(profile?.name, 'demo');
});

test('config accepts an optional profile field and still rejects unknown fields', async () => {
  const stateDir = await temporaryDirectory('bh-profile-');
  await writeFile(join(stateDir, 'config.json'), JSON.stringify({ ...baseConfig(), profile: 'demo' }), 'utf8');
  assert.equal((await loadConfig(stateDir)).profile, 'demo');
  await writeFile(join(stateDir, 'config.json'), JSON.stringify({ ...baseConfig(), unknownField: 1 }), 'utf8');
  await assert.rejects(() => loadConfig(stateDir));
});

test('core sources do not mention BI-specific libraries', async () => {
  const sourceDirectory = resolve(import.meta.dirname, '../src');
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.ts')) files.push(path);
    }
  };
  await walk(sourceDirectory);
  assert.ok(files.length > 10, `ожидалось больше исходников ядра, найдено ${files.length}`);
  const forbidden = /['"](konva|react-konva|three|msw)['"]|\bKonva\b|\bTHREE\b|navigator-bi/;
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    assert.ok(!forbidden.test(source), `BI-специфика в ядре: ${file}`);
  }
});
