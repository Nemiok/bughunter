import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { verifyArchive } from './archive.mjs';
import { buildSupportMatrix } from './support-matrix.mjs';
import { buildClaudeMarketplace, buildQwenArchiveMarketplace, buildQwenMarketplace } from './marketplace.mjs';
import { kimiHost } from './hosts/kimi.mjs';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const COMMIT_HEX = /^[0-9a-f]{40}$/;

const ALL_HOSTS = ['qwen', 'kimi', 'claude', 'qwen-mcp-only'];
const OPTIONAL_HOSTS = ['qwen-extension', 'gigacode'];
const KNOWN_HOSTS = [...ALL_HOSTS, ...OPTIONAL_HOSTS];
const ZIP_NAMES = {
  qwen: 'bughunter.zip',
  kimi: 'bughunter.zip',
  claude: 'bughunter.zip',
  'qwen-mcp-only': 'bughunter-mcp.zip',
  'qwen-extension': 'bughunter.zip',
  gigacode: 'bughunter.zip',
};
const EXPERIMENTAL_NOTE = 'experimental; full workflow not certified';
export const USAGE = 'USAGE: node release.mjs --version <semver> --source <commit> [--host all] [--evidence-dir dir] [--out-dir dir] [--metadata-only] [--release-base-url url|--marketplace-repo repo]';
const RELEASE_ROOT = resolve(import.meta.dirname);
const REPO_ROOT = resolve(RELEASE_ROOT, '..');

const MANIFEST_FILES = {
  qwen: join('.claude-plugin', 'plugin.json'),
  kimi: 'kimi.plugin.json',
  claude: join('.claude-plugin', 'plugin.json'),
  'qwen-mcp-only': 'plugin.json',
  'qwen-extension': 'qwen-extension.json',
  gigacode: 'gigacode-extension.json',
};

export function defaultArtifactDirs() {
  return {
    qwen: join(RELEASE_ROOT, 'dist', 'bughunter'),
    kimi: join(RELEASE_ROOT, 'dist', 'kimi', 'bughunter'),
    claude: join(RELEASE_ROOT, 'dist', 'claude', 'bughunter'),
    'qwen-mcp-only': join(RELEASE_ROOT, 'dist', 'qwen', 'bughunter-mcp'),
    'qwen-extension': join(RELEASE_ROOT, 'dist', 'qwen-extension', 'bughunter'),
    gigacode: join(RELEASE_ROOT, 'dist', 'gigacode', 'bughunter'),
  };
}

function defaultGit() {
  return {
    revParseHead: () => {
      const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`GIT_UNAVAILABLE: ${result.stderr.trim()}`);
      return result.stdout.trim();
    },
    isDirty: () => {
      const unstaged = spawnSync('git', ['diff', '--quiet'], { cwd: REPO_ROOT });
      const staged = spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: REPO_ROOT });
      return unstaged.status !== 0 || staged.status !== 0;
    },
    isCatalogOnlyCommit: (payloadCommit) => {
      const diff = spawnSync('git', ['diff', '--name-only', `${payloadCommit}..HEAD`], {
        cwd: REPO_ROOT, encoding: 'utf8',
      });
      if (diff.status !== 0) return false;
      const files = diff.stdout.split('\n').filter(Boolean);
      return files.length === 1 && files[0] === '.claude-plugin/marketplace.json';
    },
  };
}

function resolveHosts(requested) {
  const hosts = requested === 'all' || requested === undefined
    ? ALL_HOSTS
    : Array.isArray(requested) ? requested : [requested];
  for (const host of hosts) {
    if (!KNOWN_HOSTS.includes(host)) throw new Error(`HOST_INVALID: ${host}`);
  }
  return hosts;
}

function surfacesFor(host) {
  if (host === 'qwen') return ['qwen/cli'];
  if (host === 'kimi') return ['kimi/cli', 'kimi/desktop'];
  if (host === 'claude') return ['claude/cli', 'claude/desktop'];
  if (host === 'qwen-extension') return ['qwen/extension'];
  if (host === 'gigacode') return ['gigacode/extension'];
  return ['qwen/mcp-only'];
}

function readiness(entry) {
  if (entry.status === 'blocked') return 'blocked';
  if (entry.status === 'full') return 'full';
  if (entry.status === 'mcp-only') return 'mcp-only';
  return 'partial';
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readManifestVersion(artifactDir, host) {
  const manifestPath = join(artifactDir, MANIFEST_FILES[host]);
  let raw;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch {
    throw new Error(`MANIFEST_MISSING: ${host} -> ${manifestPath}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    throw new Error(`MANIFEST_INVALID: ${host} -> ${manifestPath}`);
  }
  if (typeof manifest.version !== 'string' || manifest.version.trim() === '') {
    throw new Error(`MANIFEST_INVALID: ${host} has no usable version`);
  }
  return manifest.version;
}

async function zipDirectory(artifactDir, zipPath) {
  const result = spawnSync('zip', ['-qr', zipPath, '.'], { cwd: artifactDir, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`ZIP_FAILED: ${result.stderr?.trim() || zipPath}`);
  }
}

async function writeChecksum(zipPath) {
  const digest = createHash('sha256').update(await readFile(zipPath)).digest('hex');
  const name = zipPath.split('/').pop();
  await writeFile(`${zipPath}.sha256`, `${digest}  ${name}\n`, 'utf8');
  return digest;
}

async function applyMarketplaceNote(marketplaceRoot, note) {
  const catalogPath = join(marketplaceRoot, '.claude-plugin', 'marketplace.json');
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  catalog.plugins[0].description = `${catalog.plugins[0].description} (${note})`;
  await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
}

async function writeKimiMarketplace({ outDir, version, source, description }) {
  const catalog = {
    version: '2',
    plugins: [{
      id: 'bughunter',
      displayName: 'Bughunter',
      description,
      version,
      source,
      clients: [...kimiHost.clients],
      platforms: ['darwin', 'win32', 'linux'],
    }],
  };
  await writeFile(join(outDir, 'marketplace.json'), `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
}

function withNote(description, ready) {
  return ready ? description : `${description} (${EXPERIMENTAL_NOTE})`;
}

function renderCompatibility({ version, sourceCommit, catalogCommit, publication, licenseError, matrix }) {
  const lines = [
    '# Bughunter compatibility',
    '',
    `Version: ${version}`,
    `Source: ${sourceCommit}`,
  ];
  if (catalogCommit !== undefined) lines.push(`Catalog: ${catalogCommit}`);
  lines.push(
    `Publication: ${publication}`,
    '',
    '| Host | Surface | Client | Status | Level | Evidence | Blocker | Artifact |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const entry of matrix.entries) {
    const client = entry.clientVersion ?? '—';
    const evidence = entry.evidence.length > 0 ? entry.evidence.join(', ') : '—';
    const blocker = entry.blocker ?? '—';
    lines.push(
      `| ${entry.host} | ${entry.surface} | ${client} | ${entry.status} | ${entry.level} | ${evidence} | ${blocker} | ${entry.artifact} |`,
    );
  }
  lines.push('', `License materials: ${licenseError ?? 'present'}`, '');
  return lines.join('\n');
}

export function renderReleaseSummary(result) {
  const lines = [
    `release ${result.version} (${result.sourceCommit})`,
    `publication: ${result.publication}`,
  ];
  let allReady = result.licenseError === undefined;
  for (const host of result.requestedHosts) {
    const status = result.hosts[host];
    if (status !== 'ready') allReady = false;
    lines.push(`${host}: ${status}`);
  }
  if (result.licenseError !== undefined) lines.push(`license: ${result.licenseError}`);
  lines.push(allReady ? 'release: PASS' : 'release: INCOMPLETE');
  return lines.join('\n');
}

export async function createRelease({
  version,
  sourceCommit,
  evidenceDir,
  outDir,
  hosts = 'all',
  artifacts = {},
  releaseBaseUrl,
  marketplaceRepo,
  metadataOnly = false,
  git = defaultGit(),
  licenseFiles = {
    license: join(REPO_ROOT, 'LICENSE'),
    notices: join(REPO_ROOT, 'THIRD_PARTY_NOTICES.md'),
  },
}) {
  if (!SEMVER.test(version)) throw new Error(`VERSION_INVALID: ${version}`);
  if (!COMMIT_HEX.test(sourceCommit)) throw new Error(`SOURCE_INVALID: ${sourceCommit}`);
  const head = git.revParseHead();
  if (head !== sourceCommit
    && !(metadataOnly && git.isCatalogOnlyCommit?.(sourceCommit) === true)) {
    throw new Error(`SOURCE_NOT_HEAD: ${sourceCommit}`);
  }
  if (git.isDirty()) throw new Error('DIRTY_TREE: commit or stash tracked changes before release');

  const requestedHosts = resolveHosts(hosts);
  const matrix = await buildSupportMatrix({ evidenceDir, sourceCommit, version });

  const licensePresent = await exists(licenseFiles.license) && await exists(licenseFiles.notices);
  const licenseError = licensePresent ? undefined : 'LICENSE_MATERIALS_MISSING';
  const configured = (releaseBaseUrl !== undefined && releaseBaseUrl !== '') || (marketplaceRepo !== undefined && marketplaceRepo !== '');
  const publication = licenseError !== undefined ? 'blocked' : configured ? 'configured' : 'not-configured';

  const hostStatus = {};
  const bySurface = Object.fromEntries(matrix.entries.map((entry) => [`${entry.host}/${entry.surface}`, entry]));
  for (const host of requestedHosts) {
    const states = surfacesFor(host).map((surface) => readiness(bySurface[surface]));
    hostStatus[host] = states.includes('blocked')
      ? 'blocked'
      : states.every((state) => state === 'full' || state === 'mcp-only') ? 'ready' : 'experimental';
  }

  const resolvedArtifacts = {};
  for (const host of requestedHosts) {
    const artifactDir = artifacts[host] ?? defaultArtifactDirs()[host];
    if (!(await exists(artifactDir))) throw new Error(`ARTIFACT_MISSING: ${host} -> ${artifactDir}`);
    resolvedArtifacts[host] = artifactDir;
  }
  for (const host of requestedHosts) {
    const manifestVersion = await readManifestVersion(resolvedArtifacts[host], host);
    if (manifestVersion !== version) {
      throw new Error(`VERSION_MISMATCH: ${host} manifest ${manifestVersion} != release ${version}`);
    }
  }

  const built = {};
  for (const host of requestedHosts) {
    const artifactDir = resolvedArtifacts[host];
    const hostOut = join(outDir, host);
    const zipPath = join(hostOut, ZIP_NAMES[host]);
    if (metadataOnly) {
      let declared;
      try {
        declared = (await readFile(`${zipPath}.sha256`, 'utf8')).trim().split(/\s+/)[0];
      } catch {
        throw new Error(`ARTIFACT_MISSING: ${host} -> ${zipPath}`);
      }
      let verified;
      try {
        verified = await verifyArchive(zipPath, declared);
      } catch (error) {
        if (error.code === 'ENOENT') throw new Error(`ARTIFACT_MISSING: ${host} -> ${zipPath}`);
        throw error;
      }
      built[host] = { zip: zipPath, sha256: verified };
      continue;
    }
    await mkdir(hostOut, { recursive: true });
    await zipDirectory(artifactDir, zipPath);
    const sha256 = await writeChecksum(zipPath);
    built[host] = { zip: zipPath, sha256 };
    const ready = hostStatus[host] === 'ready';
    const description = withNote(
      'Evidence-based bug hunting with reproduction and red regression tests.',
      ready,
    );
    if (host === 'qwen') {
      if (ready || hostStatus[host] === 'experimental') {
        const marketplaceRoot = join(hostOut, 'marketplace');
        let catalogBuilt = false;
        if (releaseBaseUrl !== undefined || marketplaceRepo !== undefined) {
          if (!releaseBaseUrl || !marketplaceRepo) throw new Error('PUBLICATION_CONFIG_INCOMPLETE');
          if (licenseError === undefined) {
            await buildQwenArchiveMarketplace({
              marketplaceRoot,
              version,
              archiveUrl: `${releaseBaseUrl.replace(/\/$/, '')}/${version}/bughunter-qwen.zip`,
              sha256: built[host].sha256,
              payloadCommit: sourceCommit,
              repository: marketplaceRepo,
            });
            catalogBuilt = true;
          }
        } else {
          await buildQwenMarketplace({ pluginDir: artifactDir, marketplaceRoot, version });
          catalogBuilt = true;
        }
        if (!ready && catalogBuilt) await applyMarketplaceNote(marketplaceRoot, EXPERIMENTAL_NOTE);
      }
    } else if (host === 'claude') {
      if (ready || hostStatus[host] === 'experimental') {
        const marketplaceRoot = join(hostOut, 'marketplace');
        await buildClaudeMarketplace({ pluginDir: artifactDir, marketplaceRoot, version });
        if (!ready) await applyMarketplaceNote(marketplaceRoot, EXPERIMENTAL_NOTE);
      }
    } else if (host === 'kimi') {
      const source = configured && releaseBaseUrl
        ? `${releaseBaseUrl.replace(/\/$/, '')}/${version}/kimi/bughunter.zip`
        : './kimi/bughunter.zip';
      await writeKimiMarketplace({ outDir: hostOut, version, source, description });
    }
  }

  const summary = {
    version,
    sourceCommit,
    payloadCommit: sourceCommit,
    ...(metadataOnly ? { catalogCommit: head } : {}),
    publication,
    hosts: hostStatus,
  };
  const compatibility = renderCompatibility({
    version, sourceCommit, publication, licenseError, matrix,
    ...(metadataOnly ? { catalogCommit: head } : {}),
  });
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'support-matrix.json'), `${JSON.stringify(matrix, null, 2)}\n`, 'utf8');
  await writeFile(join(outDir, 'COMPATIBILITY.md'), compatibility, 'utf8');
  await writeFile(join(outDir, 'release-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  return {
    version,
    sourceCommit,
    publication,
    licenseError,
    requestedHosts,
    hosts: hostStatus,
    matrix,
    artifacts: built,
    outDir,
  };
}

export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--metadata-only') {
      options.metadataOnly = true;
      continue;
    }
    if (arg === '--version') options.version = argv[index + 1];
    else if (arg === '--source') options.sourceCommit = argv[index + 1];
    else if (arg === '--host') options.hosts = argv[index + 1];
    else if (arg === '--evidence-dir') options.evidenceDir = argv[index + 1];
    else if (arg === '--out-dir') options.outDir = argv[index + 1];
    else if (arg === '--release-base-url') options.releaseBaseUrl = argv[index + 1];
    else if (arg === '--marketplace-repo') options.marketplaceRepo = argv[index + 1];
    index += 1;
  }
  return options;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.version === undefined || args.sourceCommit === undefined) {
    throw new Error(USAGE);
  }
  const outDir = args.outDir ?? join(RELEASE_ROOT, 'release', args.version);
  const evidenceDir = args.evidenceDir ?? join(RELEASE_ROOT, 'evidence');
  const result = await createRelease({ ...args, outDir, evidenceDir });
  console.log(renderReleaseSummary(result));
  console.log(`artifacts: ${result.outDir}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === join(RELEASE_ROOT, 'release.mjs')) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
