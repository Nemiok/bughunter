import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { buildSupportMatrix } from '../support-matrix.mjs';

const pluginRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(pluginRoot, '..');

function headCommit() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(result.status, 0, 'git rev-parse HEAD must succeed');
  return result.stdout.trim();
}

async function writeEvidence(evidenceDir, relPath, data) {
  const path = join(evidenceDir, ...relPath.split('/'));
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
}

// Payload shapes below mirror the gate producers field for field:
// - test/qwen-marketplace-install.mjs (qwen/cli install)
// - test/kimi-marketplace-install.mjs (kimi/cli install)
// - test/claude-marketplace-install.mjs (claude/cli install)
// - test/qwen-mcp-only-install.mjs (qwen/mcp-only install/safety/workspace)
// Keep them in sync when a producer gains or loses a field.

function qwenCliInstall(commit, clientVersion) {
  return {
    host: 'qwen',
    surface: 'cli',
    gate: 'install',
    status: 'passed',
    source: 'marketplace',
    sourceCommit: commit,
    clientVersion,
    dormantTools: 1,
    skills: 7,
    agents: 6,
    updatedTo: '0.1.1-test.1',
    statePreserved: true,
  };
}

function kimiCliInstall(commit, clientVersion) {
  return {
    host: 'kimi',
    surface: 'cli',
    gate: 'install',
    status: 'passed',
    sourceCommit: commit,
    clientVersion,
    webTools: 19,
    nodeTools: 16,
    skills: 7,
    statePreserved: true,
  };
}

function claudeCliInstall(commit, clientVersion) {
  return {
    host: 'claude',
    surface: 'cli',
    gate: 'install',
    status: 'passed',
    sourceCommit: commit,
    clientVersion,
    dormantTools: 1,
    webTools: 19,
    nodeTools: 16,
    statePreserved: true,
  };
}

function qwenMcpOnly(commit, clientVersion) {
  return {
    install: {
      host: 'qwen',
      surface: 'mcp-only',
      channel: 'extensions',
      gate: 'install',
      clientVersion,
      initVersion: clientVersion,
      sourceCommit: commit,
      package: 'bughunter-mcp',
      dormantTools: 1,
      skill: 'bughunter-mcp:bughunter-setup',
      stateCreated: false,
      status: 'passed',
    },
    safety: {
      host: 'qwen',
      surface: 'mcp-only',
      channel: 'extensions',
      clientVersion,
      sourceCommit: commit,
      gate: 'bh_open-without-lease',
      scope: 'full',
      code: 'LEASE_REQUIRED',
      status: 'passed',
    },
    workspace: {
      host: 'qwen',
      surface: 'mcp-only',
      channel: 'extensions',
      clientVersion,
      sourceCommit: commit,
      gate: 'workspace',
      status: 'blocked',
      blocker: 'BUGHUNTER_PROJECT_UNKNOWN',
      spawn: 'cwd=PLUGIN_ROOT',
      filesWritten: 0,
      serverDiagnostics: { webTools: 19, nodeTools: 16 },
    },
  };
}

test('qwen marketplace install evidence is accepted for qwen/cli at HEAD', async () => {
  const commit = headCommit();
  const evidenceDir = await mkdtemp(join(tmpdir(), 'bh-contract-qwen-'));
  await writeEvidence(evidenceDir, 'qwen/install.json', qwenCliInstall(commit, '0.28.0'));
  const matrix = await buildSupportMatrix({ evidenceDir, sourceCommit: commit, version: '0.1.0' });
  const entry = matrix.entries.find((item) => item.host === 'qwen' && item.surface === 'cli');
  assert.deepEqual(entry.evidence, ['install']);
  assert.equal(entry.status, 'experimental');
  assert.equal(entry.clientVersion, '0.28.0');
  assert.equal(entry.blocker, undefined);
});

test('kimi marketplace install evidence is accepted for kimi/cli at HEAD', async () => {
  const commit = headCommit();
  const evidenceDir = await mkdtemp(join(tmpdir(), 'bh-contract-kimi-'));
  await writeEvidence(evidenceDir, 'kimi/install.json', kimiCliInstall(commit, '2.5.3'));
  const matrix = await buildSupportMatrix({ evidenceDir, sourceCommit: commit, version: '0.1.0' });
  const entry = matrix.entries.find((item) => item.host === 'kimi' && item.surface === 'cli');
  assert.deepEqual(entry.evidence, ['install']);
  assert.equal(entry.status, 'experimental');
  assert.equal(entry.clientVersion, '2.5.3');
});

test('claude marketplace install evidence is accepted for claude/cli at HEAD', async () => {
  const commit = headCommit();
  const evidenceDir = await mkdtemp(join(tmpdir(), 'bh-contract-claude-'));
  await writeEvidence(evidenceDir, 'claude/install.json', claudeCliInstall(commit, '2.1.327 (Claude Code)'));
  const matrix = await buildSupportMatrix({ evidenceDir, sourceCommit: commit, version: '0.1.0' });
  const entry = matrix.entries.find((item) => item.host === 'claude' && item.surface === 'cli');
  assert.deepEqual(entry.evidence, ['install']);
  assert.equal(entry.status, 'experimental');
  assert.equal(entry.clientVersion, '2.1.327 (Claude Code)');
});

test('qwen mcp-only install and safety evidence is accepted at HEAD', async () => {
  const commit = headCommit();
  const evidenceDir = await mkdtemp(join(tmpdir(), 'bh-contract-mcp-'));
  const mcp = qwenMcpOnly(commit, '0.28.0');
  await writeEvidence(evidenceDir, 'qwen/mcp-only/install.json', mcp.install);
  await writeEvidence(evidenceDir, 'qwen/mcp-only/safety.json', mcp.safety);
  let matrix = await buildSupportMatrix({ evidenceDir, sourceCommit: commit, version: '0.1.0' });
  let entry = matrix.entries.find((item) => item.host === 'qwen' && item.surface === 'mcp-only');
  assert.deepEqual([...entry.evidence].sort(), ['install', 'safety']);
  assert.equal(entry.status, 'experimental');
  await writeEvidence(evidenceDir, 'qwen/mcp-only/workspace.json', mcp.workspace);
  matrix = await buildSupportMatrix({ evidenceDir, sourceCommit: commit, version: '0.1.0' });
  entry = matrix.entries.find((item) => item.host === 'qwen' && item.surface === 'mcp-only');
  assert.equal(entry.status, 'blocked');
  assert.equal(entry.blocker, 'BUGHUNTER_PROJECT_UNKNOWN');
  assert.deepEqual([...entry.evidence].sort(), ['install', 'safety']);
});
