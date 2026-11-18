import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildSupportMatrix } from '../support-matrix.mjs';
import { createRelease, renderReleaseSummary } from '../release.mjs';

const COMMIT = 'a'.repeat(40);

const kimiBase = {
  host: 'kimi', surface: 'cli', clientVersion: '2.5.3', status: 'passed', sourceCommit: COMMIT,
};

async function writeEvidence(evidenceDir, relPath, data) {
  const path = join(evidenceDir, ...relPath.split('/'));
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(data)}\n`);
}

async function makeKimiFullEvidence(evidenceDir) {
  for (const gate of ['install', 'target', 'resume']) {
    await writeEvidence(evidenceDir, `kimi/${gate}.json`, { ...kimiBase, gate });
  }
  for (const gate of ['install', 'target']) {
    await writeEvidence(evidenceDir, `kimi/desktop/${gate}.json`, {
      host: 'kimi', surface: 'desktop', clientVersion: '2.5.3', status: 'passed', gate, sourceCommit: COMMIT,
    });
  }
}

async function makeArtifact(root, name, file = 'plugin.json') {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), '{"name":"bughunter"}\n');
  return dir;
}

const cleanGit = () => ({ revParseHead: () => COMMIT, isDirty: () => false });

async function baseReleaseOptions() {
  const root = await mkdtemp(join(tmpdir(), 'bh-release-'));
  const evidenceDir = join(root, 'evidence');
  const outDir = join(root, 'release-out');
  await makeKimiFullEvidence(evidenceDir);
  const artifacts = {
    qwen: await makeArtifact(root, 'qwen-artifact'),
    kimi: await makeArtifact(root, 'kimi-artifact'),
    claude: await makeArtifact(root, 'claude-artifact'),
    'qwen-mcp-only': await makeArtifact(root, 'mcp-artifact'),
  };
  await writeFile(join(root, 'LICENSE'), 'MIT\n');
  await writeFile(join(root, 'THIRD_PARTY_NOTICES.md'), '# Notices\n');
  const licenseFiles = { license: join(root, 'LICENSE'), notices: join(root, 'THIRD_PARTY_NOTICES.md') };
  return { root, evidenceDir, outDir, artifacts, licenseFiles };
}

test('release layout carries zips, sha256 files, matrix, compatibility and summary', async () => {
  const { evidenceDir, outDir, artifacts, licenseFiles } = await baseReleaseOptions();
  const result = await createRelease({
    version: '0.2.0', sourceCommit: COMMIT, evidenceDir, outDir, artifacts,
    hosts: ['qwen', 'kimi', 'claude', 'qwen-mcp-only'], git: cleanGit(), licenseFiles,
  });
  assert.equal(result.version, '0.2.0');
  assert.equal(result.sourceCommit, COMMIT);
  assert.equal(result.publication, 'not-configured');
  for (const host of ['qwen', 'kimi', 'claude', 'qwen-mcp-only']) {
    const zipName = host === 'qwen-mcp-only' ? 'bughunter-mcp.zip' : 'bughunter.zip';
    await access(join(outDir, host, zipName));
    await access(join(outDir, host, `${zipName}.sha256`));
  }
  await access(join(outDir, 'support-matrix.json'));
  await access(join(outDir, 'COMPATIBILITY.md'));
  const summary = JSON.parse(await readFile(join(outDir, 'release-summary.json'), 'utf8'));
  assert.equal(summary.version, '0.2.0');
  assert.equal(summary.sourceCommit, COMMIT);
  const matrix = JSON.parse(await readFile(join(outDir, 'support-matrix.json'), 'utf8'));
  assert.equal(matrix.version, '0.2.0');
  assert.equal(matrix.sourceCommit, COMMIT);
  const compatibility = await readFile(join(outDir, 'COMPATIBILITY.md'), 'utf8');
  assert.match(compatibility, /0\.2\.0/);
  assert.match(compatibility, new RegExp(COMMIT));
});

test('sha256 sidecar matches a recomputation over the zip bytes', async () => {
  const { evidenceDir, outDir, artifacts, licenseFiles } = await baseReleaseOptions();
  await createRelease({
    version: '0.2.0', sourceCommit: COMMIT, evidenceDir, outDir, artifacts,
    hosts: ['kimi'], git: cleanGit(), licenseFiles,
  });
  const zipPath = join(outDir, 'kimi', 'bughunter.zip');
  const expected = createHash('sha256').update(await readFile(zipPath)).digest('hex');
  const sidecar = await readFile(`${zipPath}.sha256`, 'utf8');
  assert.equal(sidecar.split(/\s+/)[0], expected);
});

test('version and source must match across matrix, summary and compatibility', async () => {
  const { evidenceDir, outDir, artifacts, licenseFiles } = await baseReleaseOptions();
  const result = await createRelease({
    version: '0.3.0', sourceCommit: COMMIT, evidenceDir, outDir, artifacts,
    hosts: ['kimi'], git: cleanGit(), licenseFiles,
  });
  const summary = JSON.parse(await readFile(join(outDir, 'release-summary.json'), 'utf8'));
  const matrix = JSON.parse(await readFile(join(outDir, 'support-matrix.json'), 'utf8'));
  const compatibility = await readFile(join(outDir, 'COMPATIBILITY.md'), 'utf8');
  for (const doc of [result, summary, matrix]) {
    assert.equal(doc.version, '0.3.0');
    assert.equal(doc.sourceCommit, COMMIT);
  }
  assert.match(compatibility, /0\.3\.0/);
  assert.match(compatibility, new RegExp(COMMIT));
});

test('invalid version, source format and dirty trees are rejected', async () => {
  const { evidenceDir, outDir, artifacts } = await baseReleaseOptions();
  const licenseFiles = { license: join(outDir, 'LICENSE'), notices: join(outDir, 'THIRD_PARTY_NOTICES.md') };
  await assert.rejects(
    createRelease({ version: 'v2', sourceCommit: COMMIT, evidenceDir, outDir, artifacts, git: cleanGit(), licenseFiles }),
    /VERSION_INVALID/,
  );
  await assert.rejects(
    createRelease({ version: '0.2.0', sourceCommit: 'not-hex', evidenceDir, outDir, artifacts, git: cleanGit(), licenseFiles }),
    /SOURCE_INVALID/,
  );
  await assert.rejects(
    createRelease({ version: '0.2.0', sourceCommit: 'b'.repeat(40), evidenceDir, outDir, artifacts, git: cleanGit(), licenseFiles }),
    /SOURCE_NOT_HEAD/,
  );
  await assert.rejects(
    createRelease({
      version: '0.2.0', sourceCommit: COMMIT, evidenceDir, outDir, artifacts,
      git: { revParseHead: () => COMMIT, isDirty: () => true }, licenseFiles,
    }),
    /DIRTY_TREE/,
  );
});

test('missing license materials keep local artifacts but block publication', async () => {
  const { evidenceDir, outDir, artifacts } = await baseReleaseOptions();
  const result = await createRelease({
    version: '0.2.0', sourceCommit: COMMIT, evidenceDir, outDir, artifacts,
    hosts: ['kimi'], git: cleanGit(),
    licenseFiles: { license: join(outDir, 'LICENSE'), notices: join(outDir, 'THIRD_PARTY_NOTICES.md') },
    releaseBaseUrl: 'https://example.invalid/releases',
  });
  assert.equal(result.licenseError, 'LICENSE_MATERIALS_MISSING');
  assert.equal(result.publication, 'blocked');
  await access(join(outDir, 'kimi', 'bughunter.zip'));
});

test('full evidence plus license materials produce a configured publication', async () => {
  const { root, evidenceDir, outDir, artifacts } = await baseReleaseOptions();
  await writeFile(join(root, 'LICENSE'), 'MIT\n');
  await writeFile(join(root, 'THIRD_PARTY_NOTICES.md'), '# Notices\n');
  const result = await createRelease({
    version: '0.2.0', sourceCommit: COMMIT, evidenceDir, outDir, artifacts,
    hosts: ['kimi'], git: cleanGit(),
    licenseFiles: { license: join(root, 'LICENSE'), notices: join(root, 'THIRD_PARTY_NOTICES.md') },
    releaseBaseUrl: 'https://example.invalid/releases',
  });
  assert.equal(result.licenseError, undefined);
  assert.equal(result.publication, 'configured');
});

test('missing Claude evidence does not block a qwen-only local bundle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bh-release-qwen-only-'));
  const evidenceDir = join(root, 'evidence');
  const outDir = join(root, 'release-out');
  const qwenBase = {
    host: 'qwen', surface: 'cli', clientVersion: '1.0.0', status: 'passed', sourceCommit: COMMIT, source: 'marketplace',
  };
  await writeEvidence(evidenceDir, 'qwen/install.json', { ...qwenBase, gate: 'install' });
  await writeEvidence(evidenceDir, 'qwen/target.json', { ...qwenBase, gate: 'target', runId: 'run-1', afterHostRefactor: true });
  const artifacts = { qwen: await makeArtifact(root, 'qwen-artifact') };
  const result = await createRelease({
    version: '0.2.0', sourceCommit: COMMIT, evidenceDir, outDir, artifacts,
    hosts: ['qwen'], git: cleanGit(),
    licenseFiles: { license: join(outDir, 'LICENSE'), notices: join(outDir, 'THIRD_PARTY_NOTICES.md') },
  });
  assert.equal(result.hosts.qwen, 'ready');
  const rendering = renderReleaseSummary(result);
  assert.match(rendering, /PASS/);
});

test('an all-hosts rendering never reports an overall PASS without every full host', async () => {
  const { evidenceDir, outDir, artifacts, licenseFiles } = await baseReleaseOptions();
  const result = await createRelease({
    version: '0.2.0', sourceCommit: COMMIT, evidenceDir, outDir, artifacts,
    hosts: ['qwen', 'kimi', 'claude', 'qwen-mcp-only'], git: cleanGit(), licenseFiles,
  });
  assert.equal(result.hosts.kimi, 'ready');
  assert.equal(result.hosts.claude, 'experimental');
  const rendering = renderReleaseSummary(result);
  assert.doesNotMatch(rendering, /PASS/);
  assert.match(rendering, /claude: experimental/);
});

test('experimental marketplaces carry the experimental disclaimer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bh-release-experimental-'));
  const evidenceDir = join(root, 'evidence');
  const outDir = join(root, 'release-out');
  const claudeBase = {
    host: 'claude', surface: 'cli', clientVersion: '2.1.327 (Claude Code)', status: 'passed', sourceCommit: COMMIT,
  };
  await writeEvidence(evidenceDir, 'claude/install.json', { ...claudeBase, gate: 'install' });
  await writeEvidence(evidenceDir, 'claude/target.json', { ...claudeBase, gate: 'target', runId: 'run-1' });
  const artifacts = { claude: await makeArtifact(root, 'claude-artifact') };
  const result = await createRelease({
    version: '0.2.0', sourceCommit: COMMIT, evidenceDir, outDir, artifacts,
    hosts: ['claude'], git: cleanGit(),
    licenseFiles: { license: join(outDir, 'LICENSE'), notices: join(outDir, 'THIRD_PARTY_NOTICES.md') },
  });
  assert.equal(result.hosts.claude, 'experimental');
  const catalog = JSON.parse(
    await readFile(join(outDir, 'claude', 'marketplace', '.claude-plugin', 'marketplace.json'), 'utf8'),
  );
  assert.match(catalog.plugins[0].description, /experimental; full workflow not certified/);
});

test('release refuses when an artifact directory is missing', async () => {
  const { evidenceDir, outDir, artifacts } = await baseReleaseOptions();
  await assert.rejects(
    createRelease({
      version: '0.2.0', sourceCommit: COMMIT, evidenceDir, outDir,
      artifacts: { ...artifacts, kimi: join(outDir, 'no-such-artifact') },
      hosts: ['kimi'], git: cleanGit(),
      licenseFiles: { license: join(outDir, 'LICENSE'), notices: join(outDir, 'THIRD_PARTY_NOTICES.md') },
    }),
    /ARTIFACT_MISSING/,
  );
});

test('support matrix import stays shared between the two modules', async () => {
  const { evidenceDir } = await baseReleaseOptions();
  const matrix = await buildSupportMatrix({ evidenceDir, sourceCommit: COMMIT, version: '0.2.0' });
  assert.equal(matrix.entries.find((entry) => entry.host === 'kimi' && entry.surface === 'cli').status, 'full');
});
