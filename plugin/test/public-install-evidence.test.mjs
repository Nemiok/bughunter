import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { recordPublicInstallEvidence } from './public-install-evidence.mjs';

const SOURCE_COMMIT = 'a'.repeat(40);
const VERSION = '0.2.2';
const CLIENT_VERSION = '1.0.0-preview.2';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bh-public-evidence-'));
  const configDir = join(root, 'config');
  const installPath = join(configDir, 'plugins', 'cache', 'bughunter-market', 'bughunter', VERSION);
  await mkdir(installPath, { recursive: true });
  const archivePath = join(root, 'bughunter-qwen.zip');
  const archiveBytes = 'zip-bytes';
  await writeFile(archivePath, archiveBytes);
  const sha256 = createHash('sha256').update(archiveBytes).digest('hex');

  const catalog = {
    plugins: [{
      name: 'bughunter',
      version: VERSION,
      source: {
        source: 'archive',
        url: `https://github.com/acme/bughunter/releases/download/${VERSION}/bughunter-qwen.zip`,
        sha256,
      },
      metadata: { payloadCommit: SOURCE_COMMIT },
    }],
  };
  const installList = [{
    id: 'bughunter@bughunter-market',
    name: 'bughunter',
    version: VERSION,
    enabled: true,
    installPath,
  }];
  const sentinelPairs = [];
  for (const name of ['config', 'profiles', 'runs', 'auth']) {
    const before = join(root, 'before', name);
    const after = join(root, 'after', name);
    await mkdir(before, { recursive: true });
    await mkdir(after, { recursive: true });
    await writeFile(join(before, 'sentinel.txt'), `${name}-sentinel\n`);
    await writeFile(join(after, 'sentinel.txt'), `${name}-sentinel\n`);
    sentinelPairs.push({ name, beforePath: before, afterPath: after });
  }
  const evidenceDir = join(root, 'evidence');
  const expectedEvidencePath = join(evidenceDir, 'qwen', 'public-install.json');
  const input = {
    sourceCommit: SOURCE_COMMIT,
    expectedVersion: VERSION,
    installedFrom: '0.2.1',
    catalog,
    archivePath,
    installList,
    configDir,
    sentinelPairs,
    evidenceDir,
    spawn: () => ({ status: 0, stdout: `${CLIENT_VERSION}\n`, stderr: '' }),
  };
  return {
    root, configDir, installPath, archivePath, sha256, catalog, installList,
    sentinelPairs, evidenceDir, expectedEvidencePath, input,
  };
}

test('valid public install evidence records digest, version and preserved sentinels', async () => {
  const f = await fixture();
  const path = await recordPublicInstallEvidence(f.input);
  assert.equal(path, f.expectedEvidencePath);
  const evidence = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(evidence.host, 'qwen');
  assert.equal(evidence.surface, 'cli');
  assert.equal(evidence.gate, 'public-install');
  assert.equal(evidence.status, 'passed');
  assert.equal(evidence.source, 'github-marketplace');
  assert.equal(evidence.public, true);
  assert.equal(evidence.sha256Verified, true);
  assert.equal(evidence.statePreserved, true);
  assert.equal(evidence.sourceCommit, SOURCE_COMMIT);
  assert.equal(evidence.clientVersion, CLIENT_VERSION);
  assert.equal(evidence.installedFrom, '0.2.1');
  assert.equal(evidence.updatedTo, VERSION);
  assert.equal(evidence.installPathWithinConfig, true);
  assert.equal(evidence.archiveSha256, f.sha256);
  assert.deepEqual(evidence.sentinels, ['auth', 'config', 'profiles', 'runs']);
  assert.equal('installPath' in evidence, false);
});

test('public install evidence rejects digest, version and source mismatches', async () => {
  const digest = await fixture();
  await writeFile(digest.archivePath, 'tampered');
  await assert.rejects(recordPublicInstallEvidence(digest.input), /PUBLIC_INSTALL_SHA256_MISMATCH/);
  await assert.rejects(access(digest.expectedEvidencePath));

  const version = await fixture();
  version.catalog.plugins[0].version = '0.2.1';
  await assert.rejects(recordPublicInstallEvidence(version.input), /PUBLIC_INSTALL_VERSION_MISMATCH/);
  await assert.rejects(access(version.expectedEvidencePath));

  const source = await fixture();
  source.catalog.plugins[0].metadata.payloadCommit = 'b'.repeat(40);
  await assert.rejects(recordPublicInstallEvidence(source.input), /PUBLIC_INSTALL_SOURCE_MISMATCH/);
  await assert.rejects(access(source.expectedEvidencePath));
});

test('public install evidence requires an enabled installed plugin', async () => {
  const f = await fixture();
  f.installList[0].enabled = false;
  await assert.rejects(recordPublicInstallEvidence(f.input), /PUBLIC_INSTALL_PLUGIN_MISSING/);
  await assert.rejects(access(f.expectedEvidencePath));
});

test('public install evidence rejects non-GitHub and non-HTTPS archives', async () => {
  for (const url of [
    'http://github.com/acme/bughunter/releases/download/0.2.2/bughunter-qwen.zip',
    'https://example.com/acme/bughunter/releases/download/0.2.2/bughunter-qwen.zip',
    'https://github.com/acme/bughunter/releases/download/0.2.1/bughunter-qwen.zip',
  ]) {
    const f = await fixture();
    f.catalog.plugins[0].source.url = url;
    await assert.rejects(recordPublicInstallEvidence(f.input), /PUBLIC_INSTALL_CATALOG_INVALID/);
    await assert.rejects(access(f.expectedEvidencePath));
  }
});

test('public install evidence rejects changed sentinel content and paths', async () => {
  const content = await fixture();
  await writeFile(join(content.root, 'after', 'config', 'sentinel.txt'), 'changed\n');
  await assert.rejects(recordPublicInstallEvidence(content.input), /PUBLIC_INSTALL_SENTINEL_MISMATCH/);
  await assert.rejects(access(content.expectedEvidencePath));

  const paths = await fixture();
  await writeFile(join(paths.root, 'after', 'runs', 'extra.txt'), 'extra\n');
  await assert.rejects(recordPublicInstallEvidence(paths.input), /PUBLIC_INSTALL_SENTINEL_MISMATCH/);
  await assert.rejects(access(paths.expectedEvidencePath));

  const missing = await fixture();
  missing.input.sentinelPairs[3].afterPath = join(missing.root, 'after', 'missing-auth');
  await assert.rejects(recordPublicInstallEvidence(missing.input), /PUBLIC_INSTALL_SENTINEL_MISSING/);
  await assert.rejects(access(missing.expectedEvidencePath));
});

test('public install evidence rejects same-path, arbitrary and incomplete sentinels', async () => {
  const same = await fixture();
  same.sentinelPairs[0].afterPath = same.sentinelPairs[0].beforePath;
  await assert.rejects(recordPublicInstallEvidence(same.input), /PUBLIC_INSTALL_SENTINEL_INVALID/);
  await assert.rejects(access(same.expectedEvidencePath));

  const arbitrary = await fixture();
  arbitrary.sentinelPairs[0].name = 'fake';
  await assert.rejects(recordPublicInstallEvidence(arbitrary.input), /PUBLIC_INSTALL_SENTINEL_INVALID/);
  await assert.rejects(access(arbitrary.expectedEvidencePath));

  const incomplete = await fixture();
  incomplete.sentinelPairs.pop();
  await assert.rejects(recordPublicInstallEvidence(incomplete.input), /PUBLIC_INSTALL_SENTINELS_REQUIRED/);
  await assert.rejects(access(incomplete.expectedEvidencePath));
});

test('public install evidence requires a real update transition', async () => {
  const f = await fixture();
  f.input.installedFrom = VERSION;
  await assert.rejects(recordPublicInstallEvidence(f.input), /PUBLIC_INSTALL_UPDATE_REQUIRED/);
  await assert.rejects(access(f.expectedEvidencePath));
});

test('public install evidence requires an install path inside the isolated config', async () => {
  const f = await fixture();
  const outside = join(f.root, 'outside-install');
  await mkdir(outside, { recursive: true });
  f.installList[0].installPath = outside;
  await assert.rejects(recordPublicInstallEvidence(f.input), /PUBLIC_INSTALL_PATH_INVALID/);
  await assert.rejects(access(f.expectedEvidencePath));
});

test('public install evidence requires sentinels, an archive and a real client version', async () => {
  const noSentinels = await fixture();
  noSentinels.input.sentinelPairs = [];
  await assert.rejects(recordPublicInstallEvidence(noSentinels.input), /PUBLIC_INSTALL_SENTINELS_REQUIRED/);
  await assert.rejects(access(noSentinels.expectedEvidencePath));

  const noArchive = await fixture();
  await rm(noArchive.archivePath);
  await assert.rejects(recordPublicInstallEvidence(noArchive.input), /PUBLIC_INSTALL_ARCHIVE_MISSING/);
  await assert.rejects(access(noArchive.expectedEvidencePath));

  const noClient = await fixture();
  noClient.input.spawn = () => ({ status: 1, stdout: '', stderr: 'ETIMEDOUT' });
  await assert.rejects(recordPublicInstallEvidence(noClient.input), /PUBLIC_INSTALL_CLIENT_VERSION_MISSING/);
  await assert.rejects(access(noClient.expectedEvidencePath));
});
