import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

const COMMIT = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/i;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const REQUIRED_SENTINELS = ['auth', 'config', 'profiles', 'runs'];

function fail(code, detail) {
  return new Error(detail === undefined ? code : `${code}: ${detail}`);
}

async function snapshot(path) {
  let info;
  try {
    info = await lstat(path);
  } catch {
    throw new Error('MISSING');
  }
  if (info.isSymbolicLink()) throw new Error('SYMLINK');
  if (info.isFile()) {
    return new Map([['.', createHash('sha256').update(await readFile(path)).digest('hex')]]);
  }
  if (!info.isDirectory()) throw new Error('TYPE');
  const files = new Map();
  async function walk(directory, prefix) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = join(directory, entry.name);
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error('SYMLINK');
      if (entry.isDirectory()) {
        await walk(full, rel);
      } else if (entry.isFile()) {
        files.set(rel, createHash('sha256').update(await readFile(full)).digest('hex'));
      } else {
        throw new Error('TYPE');
      }
    }
  }
  await walk(path, '');
  return files;
}

function catalogPlugin(catalog) {
  if (!catalog || !Array.isArray(catalog.plugins) || catalog.plugins.length === 0) {
    throw fail('PUBLIC_INSTALL_CATALOG_INVALID', 'plugins');
  }
  const plugin = catalog.plugins.find((item) => item?.name === 'bughunter') ?? catalog.plugins[0];
  if (!plugin || typeof plugin !== 'object') throw fail('PUBLIC_INSTALL_CATALOG_INVALID', 'plugin');
  return plugin;
}

function validateCatalog(plugin, expectedVersion, sourceCommit) {
  if (plugin.version !== expectedVersion) throw fail('PUBLIC_INSTALL_VERSION_MISMATCH');
  if (plugin.metadata?.payloadCommit !== sourceCommit) throw fail('PUBLIC_INSTALL_SOURCE_MISMATCH');
  const source = plugin.source;
  if (!source || source.source !== 'archive'
    || typeof source.url !== 'string' || !SHA256.test(source.sha256 ?? '')) {
    throw fail('PUBLIC_INSTALL_CATALOG_INVALID', 'source');
  }
  let url;
  try {
    url = new URL(source.url);
  } catch {
    throw fail('PUBLIC_INSTALL_CATALOG_INVALID', 'url');
  }
  const segments = url.pathname.split('/').filter(Boolean);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || segments.length !== 6
    || segments[2] !== 'releases' || segments[3] !== 'download'
    || segments[4] !== expectedVersion || segments[5] !== 'bughunter-qwen.zip') {
    throw fail('PUBLIC_INSTALL_CATALOG_INVALID', 'url');
  }
  return source;
}

function installedPlugin(installList) {
  const list = Array.isArray(installList) ? installList : installList?.plugins;
  if (!Array.isArray(list)) throw fail('PUBLIC_INSTALL_LIST_INVALID');
  const installed = list.find((item) =>
    item?.id === 'bughunter@bughunter-market' && item.enabled === true);
  if (installed === undefined) throw fail('PUBLIC_INSTALL_PLUGIN_MISSING');
  return installed;
}

function clientVersionFrom(spawn) {
  let result;
  try {
    result = spawn('qwen', ['--version'], { encoding: 'utf8', shell: false, timeout: 10_000 });
  } catch {
    throw fail('PUBLIC_INSTALL_CLIENT_VERSION_MISSING');
  }
  const stdout = typeof result?.stdout === 'string' ? result.stdout.trim() : '';
  if (result?.status !== 0 || stdout === '') throw fail('PUBLIC_INSTALL_CLIENT_VERSION_MISSING');
  return stdout;
}

async function checkSentinels(sentinelPairs) {
  if (!Array.isArray(sentinelPairs) || sentinelPairs.length === 0) {
    throw fail('PUBLIC_INSTALL_SENTINELS_REQUIRED');
  }
  const seen = new Set();
  for (const pair of sentinelPairs) {
    if (typeof pair?.name !== 'string' || pair.name === ''
      || typeof pair.beforePath !== 'string' || typeof pair.afterPath !== 'string'
      || !REQUIRED_SENTINELS.includes(pair.name) || seen.has(pair.name)
      || resolve(pair.beforePath) === resolve(pair.afterPath)) {
      throw fail('PUBLIC_INSTALL_SENTINEL_INVALID');
    }
    seen.add(pair.name);
    let before;
    let after;
    try {
      before = await snapshot(pair.beforePath);
      after = await snapshot(pair.afterPath);
    } catch {
      throw fail('PUBLIC_INSTALL_SENTINEL_MISSING', pair.name);
    }
    const beforeKeys = [...before.keys()].sort();
    const afterKeys = [...after.keys()].sort();
    if (beforeKeys.length !== afterKeys.length
      || beforeKeys.some((key, index) => key !== afterKeys[index])) {
      throw fail('PUBLIC_INSTALL_SENTINEL_MISMATCH', pair.name);
    }
    for (const key of beforeKeys) {
      if (before.get(key) !== after.get(key)) throw fail('PUBLIC_INSTALL_SENTINEL_MISMATCH', pair.name);
    }
  }
  if (REQUIRED_SENTINELS.some((name) => !seen.has(name))) {
    throw fail('PUBLIC_INSTALL_SENTINELS_REQUIRED');
  }
  return [...seen].sort();
}

export async function recordPublicInstallEvidence({
  sourceCommit,
  expectedVersion,
  installedFrom,
  catalog,
  archivePath,
  installList,
  configDir,
  sentinelPairs,
  evidenceDir,
  spawn = spawnSync,
}) {
  if (!COMMIT.test(sourceCommit ?? '')) throw fail('PUBLIC_INSTALL_SOURCE_COMMIT_INVALID');
  if (!SEMVER.test(expectedVersion ?? '')) throw fail('PUBLIC_INSTALL_VERSION_INVALID');
  if (typeof installedFrom !== 'string' || installedFrom.trim() === '') {
    throw fail('PUBLIC_INSTALL_INSTALLED_FROM_REQUIRED');
  }
  if (installedFrom === expectedVersion) throw fail('PUBLIC_INSTALL_UPDATE_REQUIRED');

  const plugin = catalogPlugin(catalog);
  const source = validateCatalog(plugin, expectedVersion, sourceCommit);
  const clientVersion = clientVersionFrom(spawn);

  let archive;
  try {
    archive = await readFile(archivePath);
  } catch {
    throw fail('PUBLIC_INSTALL_ARCHIVE_MISSING');
  }
  const archiveSha256 = createHash('sha256').update(archive).digest('hex');
  if (archiveSha256 !== source.sha256.toLowerCase()) throw fail('PUBLIC_INSTALL_SHA256_MISMATCH');

  const installed = installedPlugin(installList);
  if (installed.version !== expectedVersion) throw fail('PUBLIC_INSTALL_VERSION_MISMATCH');
  if (typeof configDir !== 'string' || typeof installed.installPath !== 'string') {
    throw fail('PUBLIC_INSTALL_PATH_INVALID');
  }
  const configRoot = resolve(configDir);
  const installRoot = resolve(installed.installPath);
  const relativePath = relative(configRoot, installRoot);
  if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw fail('PUBLIC_INSTALL_PATH_INVALID');
  }
  try {
    await access(installRoot);
  } catch {
    throw fail('PUBLIC_INSTALL_PATH_INVALID');
  }

  const sentinels = await checkSentinels(sentinelPairs);
  const evidence = {
    host: 'qwen',
    surface: 'cli',
    gate: 'public-install',
    status: 'passed',
    source: 'github-marketplace',
    public: true,
    sha256Verified: true,
    statePreserved: true,
    sourceCommit,
    clientVersion,
    installedFrom,
    updatedTo: expectedVersion,
    pluginId: 'bughunter@bughunter-market',
    installPathWithinConfig: true,
    archiveSha256,
    sentinels,
  };
  const directory = join(evidenceDir, 'qwen');
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'public-install.json');
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  return path;
}
