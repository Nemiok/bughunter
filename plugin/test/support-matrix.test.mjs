import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildSupportMatrix } from '../support-matrix.mjs';

const base = {
  host: 'kimi', surface: 'cli', clientVersion: '2.5.3', status: 'passed',
  sourceCommit: 'a'.repeat(40),
};

async function writeEvidence(evidenceDir, relPath, data) {
  const path = join(evidenceDir, ...relPath.split('/'));
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(data)}\n`);
  return path;
}

test('full requires install, target and resume evidence on the same client', async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'bh-matrix-'));
  await mkdir(join(evidenceDir, 'kimi'), { recursive: true });
  for (const gate of ['install', 'target', 'resume']) {
    await writeFile(join(evidenceDir, 'kimi', `${gate}.json`), JSON.stringify({ ...base, gate }));
  }
  const matrix = await buildSupportMatrix({ evidenceDir, sourceCommit: 'a'.repeat(40), version: '0.2.0' });
  assert.equal(matrix.entries.find((entry) => entry.host === 'kimi' && entry.surface === 'cli').status, 'full');
});

test('missing resume cannot be manually promoted to full', async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'bh-matrix-missing-'));
  await mkdir(join(evidenceDir, 'kimi'), { recursive: true });
  await writeFile(join(evidenceDir, 'kimi', 'install.json'), JSON.stringify({ ...base, gate: 'install' }));
  await writeFile(join(evidenceDir, 'kimi', 'target.json'), JSON.stringify({ ...base, gate: 'target' }));
  const matrix = await buildSupportMatrix({ evidenceDir, sourceCommit: 'a'.repeat(40), version: '0.2.0' });
  assert.equal(matrix.entries.find((entry) => entry.host === 'kimi' && entry.surface === 'cli').status, 'experimental');
});

test('no evidence leaves the surface planned', async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'bh-matrix-planned-'));
  const matrix = await buildSupportMatrix({ evidenceDir, sourceCommit: 'a'.repeat(40), version: '0.2.0' });
  assert.equal(matrix.entries.length, 6);
  for (const entry of matrix.entries) {
    assert.equal(entry.status, 'planned');
    assert.equal(entry.clientVersion, undefined);
    assert.deepEqual(entry.evidence, []);
  }
});

test('matrix carries the requested version and source commit', async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'bh-matrix-meta-'));
  const matrix = await buildSupportMatrix({ evidenceDir, sourceCommit: 'b'.repeat(40), version: '0.3.0-rc.1' });
  assert.equal(matrix.version, '0.3.0-rc.1');
  assert.equal(matrix.sourceCommit, 'b'.repeat(40));
});

test('desktop requires its own desktop install and target evidence', async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'bh-matrix-desktop-'));
  const commit = 'c'.repeat(40);
  for (const gate of ['install', 'target', 'resume']) {
    await writeEvidence(evidenceDir, `kimi/${gate}.json`, { ...base, gate, sourceCommit: commit });
  }
  let matrix = await buildSupportMatrix({ evidenceDir, sourceCommit: commit, version: '0.2.0' });
  assert.equal(matrix.entries.find((entry) => entry.host === 'kimi' && entry.surface === 'desktop').status, 'planned');
  await writeEvidence(evidenceDir, 'kimi/desktop/install.json', {
    host: 'kimi', surface: 'desktop', clientVersion: '2.5.3', status: 'passed', gate: 'install', sourceCommit: commit,
  });
  matrix = await buildSupportMatrix({ evidenceDir, sourceCommit: commit, version: '0.2.0' });
  const desktop = matrix.entries.find((entry) => entry.host === 'kimi' && entry.surface === 'desktop');
  assert.equal(desktop.status, 'experimental');
  await writeEvidence(evidenceDir, 'kimi/desktop/target.json', {
    host: 'kimi', surface: 'desktop', clientVersion: '2.5.3', status: 'passed', gate: 'target', sourceCommit: commit,
  });
  matrix = await buildSupportMatrix({ evidenceDir, sourceCommit: commit, version: '0.2.0' });
  assert.equal(matrix.entries.find((entry) => entry.host === 'kimi' && entry.surface === 'desktop').status, 'full');
});

test('a cli install does not substitute for a desktop install', async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'bh-matrix-desktop-cli-'));
  const commit = 'd'.repeat(40);
  await writeEvidence(evidenceDir, 'kimi/install.json', { ...base, gate: 'install', sourceCommit: commit });
  await writeEvidence(evidenceDir, 'kimi/desktop/target.json', {
    host: 'kimi', surface: 'desktop', clientVersion: '2.5.3', status: 'passed', gate: 'target', sourceCommit: commit,
  });
  const matrix = await buildSupportMatrix({ evidenceDir, sourceCommit: commit, version: '0.2.0' });
  assert.equal(matrix.entries.find((entry) => entry.host === 'kimi' && entry.surface === 'desktop').status, 'experimental');
});

test('stale evidence on a different source commit blocks the surface', async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'bh-matrix-stale-'));
  for (const gate of ['install', 'target', 'resume']) {
    await writeEvidence(evidenceDir, `kimi/${gate}.json`, { ...base, gate, sourceCommit: 'e'.repeat(40) });
  }
  const matrix = await buildSupportMatrix({ evidenceDir, sourceCommit: 'f'.repeat(40), version: '0.2.0' });
  const entry = matrix.entries.find((item) => item.host === 'kimi' && item.surface === 'cli');
  assert.equal(entry.status, 'blocked');
  assert.equal(entry.blocker, 'STALE_EVIDENCE');
});

test('conflicting client versions across gates block the surface', async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'bh-matrix-version-'));
  const commit = 'a'.repeat(40);
  await writeEvidence(evidenceDir, 'kimi/install.json', { ...base, gate: 'install', sourceCommit: commit });
  await writeEvidence(evidenceDir, 'kimi/target.json', { ...base, gate: 'target', sourceCommit: commit });
  await writeEvidence(evidenceDir, 'kimi/resume.json', { ...base, gate: 'resume', clientVersion: '2.5.4', sourceCommit: commit });
  const matrix = await buildSupportMatrix({ evidenceDir, sourceCommit: commit, version: '0.2.0' });
  const entry = matrix.entries.find((item) => item.host === 'kimi' && item.surface === 'cli');
  assert.equal(entry.status, 'blocked');
  assert.equal(entry.blocker, 'CLIENT_VERSION_MISMATCH');
});

test('target and resume gates require a non-empty runId', async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'bh-matrix-runid-'));
  const commit = 'a'.repeat(40);
  await writeEvidence(evidenceDir, 'kimi/install.json', { ...base, gate: 'install', sourceCommit: commit });
  await writeEvidence(evidenceDir, 'kimi/target.json', { ...base, gate: 'target', sourceCommit: commit, runId: '  ' });
  await writeEvidence(evidenceDir, 'kimi/resume.json', { ...base, gate: 'resume', sourceCommit: commit, runId: '' });
  const matrix = await buildSupportMatrix({ evidenceDir, sourceCommit: commit, version: '0.2.0' });
  assert.equal(matrix.entries.find((entry) => entry.host === 'kimi' && entry.surface === 'cli').status, 'experimental');
});

test('qwen cli full requires marketplace install source and a post-refactor target run', async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'bh-matrix-qwen-'));
  const commit = 'a'.repeat(40);
  const qwenBase = { host: 'qwen', surface: 'cli', clientVersion: '1.0.0', status: 'passed', sourceCommit: commit };
  await writeEvidence(evidenceDir, 'qwen/install.json', { ...qwenBase, gate: 'install' });
  await writeEvidence(evidenceDir, 'qwen/target.json', { ...qwenBase, gate: 'target', runId: 'run-1', afterHostRefactor: true });
  let matrix = await buildSupportMatrix({ evidenceDir, sourceCommit: commit, version: '0.2.0' });
  assert.notEqual(matrix.entries.find((entry) => entry.host === 'qwen' && entry.surface === 'cli').status, 'full');
  await writeEvidence(evidenceDir, 'qwen/install.json', { ...qwenBase, gate: 'install', source: 'marketplace' });
  matrix = await buildSupportMatrix({ evidenceDir, sourceCommit: commit, version: '0.2.0' });
  assert.equal(matrix.entries.find((entry) => entry.host === 'qwen' && entry.surface === 'cli').status, 'full');
  await writeEvidence(evidenceDir, 'qwen/target.json', { ...qwenBase, gate: 'target', runId: 'run-1' });
  matrix = await buildSupportMatrix({ evidenceDir, sourceCommit: commit, version: '0.2.0' });
  assert.equal(matrix.entries.find((entry) => entry.host === 'qwen' && entry.surface === 'cli').status, 'experimental');
});

test('qwen mcp-only requires workspace evidence and a blocked workspace blocks the surface', async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'bh-matrix-mcp-'));
  const commit = 'a'.repeat(40);
  const mcpBase = { host: 'qwen', surface: 'mcp-only', clientVersion: '1.0.0', status: 'passed', sourceCommit: commit };
  await writeEvidence(evidenceDir, 'qwen/mcp-only/install.json', { ...mcpBase, gate: 'install' });
  let matrix = await buildSupportMatrix({ evidenceDir, sourceCommit: commit, version: '0.2.0' });
  assert.equal(matrix.entries.find((entry) => entry.host === 'qwen' && entry.surface === 'mcp-only').status, 'experimental');
  await writeEvidence(evidenceDir, 'qwen/mcp-only/safety.json', { ...mcpBase, gate: 'safety' });
  matrix = await buildSupportMatrix({ evidenceDir, sourceCommit: commit, version: '0.2.0' });
  assert.equal(matrix.entries.find((entry) => entry.host === 'qwen' && entry.surface === 'mcp-only').status, 'experimental');
  await writeEvidence(evidenceDir, 'qwen/mcp-only/workspace.json', {
    host: 'qwen', surface: 'mcp-only', clientVersion: '1.0.0', gate: 'workspace', status: 'blocked',
    blocker: 'BUGHUNTER_PROJECT_UNKNOWN', sourceCommit: commit,
  });
  matrix = await buildSupportMatrix({ evidenceDir, sourceCommit: commit, version: '0.2.0' });
  const blocked = matrix.entries.find((entry) => entry.host === 'qwen' && entry.surface === 'mcp-only');
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.blocker, 'BUGHUNTER_PROJECT_UNKNOWN');
  await writeEvidence(evidenceDir, 'qwen/mcp-only/workspace.json', { ...mcpBase, gate: 'workspace' });
  matrix = await buildSupportMatrix({ evidenceDir, sourceCommit: commit, version: '0.2.0' });
  assert.equal(matrix.entries.find((entry) => entry.host === 'qwen' && entry.surface === 'mcp-only').status, 'mcp-only');
});

test('a current blocked gate takes precedence over stale evidence from other gates', async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'bh-matrix-blocked-precedence-'));
  const commit = 'a'.repeat(40);
  await writeEvidence(evidenceDir, 'qwen/mcp-only/install.json', {
    host: 'qwen', surface: 'mcp-only', clientVersion: '1.0.0', gate: 'install', status: 'passed', sourceCommit: 'b'.repeat(40),
  });
  await writeEvidence(evidenceDir, 'qwen/mcp-only/safety.json', {
    host: 'qwen', surface: 'mcp-only', clientVersion: '1.0.0', gate: 'safety', status: 'passed', sourceCommit: commit,
  });
  await writeEvidence(evidenceDir, 'qwen/mcp-only/workspace.json', {
    host: 'qwen', surface: 'mcp-only', clientVersion: '1.0.0', gate: 'workspace', status: 'blocked',
    blocker: 'BUGHUNTER_PROJECT_UNKNOWN', sourceCommit: commit,
  });
  const matrix = await buildSupportMatrix({ evidenceDir, sourceCommit: commit, version: '0.2.0' });
  const entry = matrix.entries.find((item) => item.host === 'qwen' && item.surface === 'mcp-only');
  assert.equal(entry.status, 'blocked');
  assert.equal(entry.blocker, 'BUGHUNTER_PROJECT_UNKNOWN');
});

test('stale blocked evidence falls back to the stale blocker', async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'bh-matrix-stale-blocked-'));
  const commit = 'a'.repeat(40);
  await writeEvidence(evidenceDir, 'qwen/mcp-only/workspace.json', {
    host: 'qwen', surface: 'mcp-only', clientVersion: '1.0.0', gate: 'workspace', status: 'blocked',
    blocker: 'BUGHUNTER_PROJECT_UNKNOWN', sourceCommit: 'c'.repeat(40),
  });
  const matrix = await buildSupportMatrix({ evidenceDir, sourceCommit: commit, version: '0.2.0' });
  const entry = matrix.entries.find((item) => item.host === 'qwen' && item.surface === 'mcp-only');
  assert.equal(entry.status, 'blocked');
  assert.equal(entry.blocker, 'STALE_EVIDENCE');
});

test('mcp-only status is not awarded to cli surfaces', async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'bh-matrix-mcp-cli-'));
  const commit = 'a'.repeat(40);
  const qwenBase = { host: 'qwen', surface: 'cli', clientVersion: '1.0.0', status: 'passed', sourceCommit: commit, source: 'marketplace' };
  await writeEvidence(evidenceDir, 'qwen/install.json', { ...qwenBase, gate: 'install' });
  await writeEvidence(evidenceDir, 'qwen/target.json', { ...qwenBase, gate: 'target', runId: 'run-1', afterHostRefactor: true });
  const matrix = await buildSupportMatrix({ evidenceDir, sourceCommit: commit, version: '0.2.0' });
  assert.equal(matrix.entries.find((entry) => entry.host === 'qwen' && entry.surface === 'cli').status, 'full');
});

test('failed gates are ignored and cannot make a surface full', async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'bh-matrix-failed-'));
  const commit = 'a'.repeat(40);
  await writeEvidence(evidenceDir, 'kimi/install.json', { ...base, gate: 'install', status: 'failed', sourceCommit: commit });
  await writeEvidence(evidenceDir, 'kimi/target.json', { ...base, gate: 'target', sourceCommit: commit });
  await writeEvidence(evidenceDir, 'kimi/resume.json', { ...base, gate: 'resume', sourceCommit: commit });
  const matrix = await buildSupportMatrix({ evidenceDir, sourceCommit: commit, version: '0.2.0' });
  assert.equal(matrix.entries.find((entry) => entry.host === 'kimi' && entry.surface === 'cli').status, 'experimental');
});

test('evidence from another host or surface is not accepted', async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'bh-matrix-foreign-'));
  const commit = 'a'.repeat(40);
  await writeEvidence(evidenceDir, 'kimi/install.json', { ...base, gate: 'install', host: 'claude', sourceCommit: commit });
  await writeEvidence(evidenceDir, 'kimi/target.json', { ...base, gate: 'target', surface: 'desktop', sourceCommit: commit });
  await writeEvidence(evidenceDir, 'kimi/resume.json', { ...base, gate: 'resume', sourceCommit: commit });
  const matrix = await buildSupportMatrix({ evidenceDir, sourceCommit: commit, version: '0.2.0' });
  assert.equal(matrix.entries.find((entry) => entry.host === 'kimi' && entry.surface === 'cli').status, 'experimental');
});

test('evidence without sourceCommit is stale and cannot become full', async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'bh-matrix-nocommit-'));
  const commit = 'a'.repeat(40);
  await writeEvidence(evidenceDir, 'kimi/install.json', { ...base, gate: 'install' });
  await writeEvidence(evidenceDir, 'kimi/target.json', { ...base, gate: 'target' });
  const { sourceCommit, ...resume } = { ...base, gate: 'resume', sourceCommit: commit };
  await writeEvidence(evidenceDir, 'kimi/resume.json', resume);
  const matrix = await buildSupportMatrix({ evidenceDir, sourceCommit: commit, version: '0.2.0' });
  const entry = matrix.entries.find((item) => item.host === 'kimi' && item.surface === 'cli');
  assert.notEqual(entry.status, 'full');
  assert.equal(entry.status, 'blocked');
  assert.equal(entry.blocker, 'STALE_EVIDENCE');
});

test('matrix serialization stays stable for identical inputs', async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'bh-matrix-stable-'));
  const commit = 'a'.repeat(40);
  for (const gate of ['install', 'target', 'resume']) {
    await writeEvidence(evidenceDir, `kimi/${gate}.json`, { ...base, gate, sourceCommit: commit });
  }
  const first = await buildSupportMatrix({ evidenceDir, sourceCommit: commit, version: '0.2.0' });
  const second = await buildSupportMatrix({ evidenceDir, sourceCommit: commit, version: '0.2.0' });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(Object.keys(first).sort(), ['entries', 'sourceCommit', 'version']);
});
