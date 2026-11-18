import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const SURFACES = [
  'qwen/cli',
  'kimi/cli',
  'kimi/desktop',
  'claude/cli',
  'claude/desktop',
  'qwen/mcp-only',
  'qwen/extension',
  'gigacode/extension',
];

export const requirements = {
  'qwen/cli': ['install', 'target'],
  'kimi/cli': ['install', 'target', 'resume'],
  'claude/cli': ['install', 'target', 'resume'],
  'kimi/desktop': ['install', 'target'],
  'claude/desktop': ['install', 'target'],
  'qwen/mcp-only': ['install', 'safety', 'workspace'],
  'qwen/extension': ['install', 'workspace', 'target', 'resume'],
  'gigacode/extension': ['install', 'workspace', 'target', 'resume'],
};

export const STATUS_LEVELS = {
  planned: 'planned',
  experimental: 'experimental',
  full: 'certified',
  'mcp-only': 'mcp-only',
  blocked: 'blocked',
  unsupported: 'unsupported',
};

const ARTIFACTS = {
  'qwen/cli': 'qwen/bughunter.zip',
  'kimi/cli': 'kimi/bughunter.zip',
  'kimi/desktop': 'kimi/bughunter.zip',
  'claude/cli': 'claude/bughunter.zip',
  'claude/desktop': 'claude/bughunter.zip',
  'qwen/mcp-only': 'qwen-mcp-only/bughunter-mcp.zip',
  'qwen/extension': 'qwen-extension/bughunter.zip',
  'gigacode/extension': 'gigacode/bughunter.zip',
};

function evidencePathFor(evidenceDir, surface, gate) {
  const [host, kind] = surface.split('/');
  if (kind === 'desktop') return join(evidenceDir, host, 'desktop', `${gate}.json`);
  if (kind === 'mcp-only') return join(evidenceDir, host, 'mcp-only', `${gate}.json`);
  if (kind === 'extension') return join(evidenceDir, host, 'extension', `${gate}.json`);
  return join(evidenceDir, host, `${gate}.json`);
}

function acceptsGate(surface, gate, evidence) {
  if (evidence.status !== 'passed') return false;
  const [host] = surface.split('/');
  if (evidence.host !== host || evidence.surface !== surface.split('/')[1]) return false;
  if (surface === 'qwen/cli' && gate === 'install' && evidence.source !== 'marketplace') return false;
  if (surface === 'qwen/cli' && gate === 'target' && evidence.afterHostRefactor !== true) return false;
  if (gate === 'workspace' && surface.split('/')[1] === 'extension'
    && (evidence.workspaceResolved !== true || evidence.filesWritten !== 0)) return false;
  if ((gate === 'target' || gate === 'resume')
    && (typeof evidence.runId !== 'string' || evidence.runId.trim() === '')) {
    return false;
  }
  return true;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

async function buildEntry({ evidenceDir, surface, sourceCommit }) {
  const [host] = surface.split('/');
  const entry = {
    host,
    surface: surface.split('/')[1],
    clientVersion: undefined,
    artifact: ARTIFACTS[surface],
    level: 'planned',
    status: 'planned',
    evidence: [],
    blocker: undefined,
  };
  const gates = requirements[surface] ?? [];
  const accepted = [];
  let stale = false;
  let versionConflict = false;
  let blockedBy;
  for (const gate of gates) {
    const evidence = await readJson(evidencePathFor(evidenceDir, surface, gate));
    if (evidence === undefined) continue;
    if (evidence.sourceCommit !== sourceCommit) {
      stale = true;
      continue;
    }
    if (evidence.status === 'blocked' && typeof evidence.blocker === 'string' && evidence.blocker.length > 0) {
      blockedBy ??= evidence.blocker;
      continue;
    }
    if (!acceptsGate(surface, gate, evidence)) continue;
    accepted.push({ gate, ...pick(evidence, ['runId', 'clientVersion']) });
  }
  const versions = [...new Set(accepted.map((item) => item.clientVersion).filter((value) => value !== undefined))];
  if (versions.length > 1) versionConflict = true;
  entry.clientVersion = versions.length === 1 ? versions[0] : undefined;
  entry.evidence = accepted.map((item) => item.gate);
  if (blockedBy !== undefined) {
    entry.status = 'blocked';
    entry.blocker = blockedBy;
  } else if (stale) {
    entry.status = 'blocked';
    entry.blocker = 'STALE_EVIDENCE';
  } else if (versionConflict) {
    entry.status = 'blocked';
    entry.blocker = 'CLIENT_VERSION_MISMATCH';
  } else if (accepted.length === 0) {
    entry.status = 'planned';
  } else if (accepted.length === gates.length) {
    entry.status = surface === 'qwen/mcp-only' ? 'mcp-only' : 'full';
  } else {
    entry.status = 'experimental';
  }
  entry.level = STATUS_LEVELS[entry.status];
  return entry;
}

function pick(source, keys) {
  const result = {};
  for (const key of keys) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}

export async function buildSupportMatrix({ evidenceDir, sourceCommit, version }) {
  const entries = [];
  for (const surface of SURFACES) {
    entries.push(await buildEntry({ evidenceDir, surface, sourceCommit }));
  }
  return { version, sourceCommit, entries };
}
