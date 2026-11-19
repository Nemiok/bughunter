import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { clientVersionFrom, installedPlugin } from './public-install-evidence.mjs';
import { inspectQwenActivation } from './transcript-evidence.mjs';

const COMMIT = /^[a-f0-9]{40}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const REQUIRED_SETUP_FILES = [
  '.qwen/bughunter.json',
  '.qwen/bughunter/state/web/config.json',
];

function setupError(code, detail) {
  return new Error(detail === undefined ? code : `${code}: ${detail}`);
}

async function hashFile(path) {
  let info;
  try {
    info = await lstat(path);
  } catch {
    throw setupError('ACTIVATION_SETUP_FILES_REQUIRED', path);
  }
  if (info.isSymbolicLink()) throw setupError('ACTIVATION_SETUP_SYMLINK', path);
  if (!info.isFile()) throw setupError('ACTIVATION_SETUP_FILES_REQUIRED', path);
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

function relativeKey(root, path) {
  const key = relative(root, path).split(sep).join('/');
  if (key === '' || key.startsWith('../') || isAbsolute(key)) {
    throw setupError('ACTIVATION_SETUP_FILES_REQUIRED', path);
  }
  return key;
}

async function addFile(files, root, path) {
  files.set(relativeKey(root, path), await hashFile(path));
}

async function addDirectory(files, root, directory) {
  let info;
  try {
    info = await lstat(directory);
  } catch {
    return;
  }
  if (info.isSymbolicLink()) throw setupError('ACTIVATION_SETUP_SYMLINK', directory);
  if (!info.isDirectory()) throw setupError('ACTIVATION_SETUP_FILES_REQUIRED', directory);
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((first, second) => first.name.localeCompare(second.name));
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw setupError('ACTIVATION_SETUP_SYMLINK', path);
    if (entry.isDirectory()) {
      await addDirectory(files, root, path);
    } else if (entry.isFile()) {
      await addFile(files, root, path);
    } else {
      throw setupError('ACTIVATION_SETUP_FILES_REQUIRED', path);
    }
  }
}

export async function createSetupSnapshot({ projectRoot, preset }) {
  if (typeof projectRoot !== 'string' || !['web', 'node'].includes(preset)) {
    throw setupError('ACTIVATION_SETUP_FILES_REQUIRED');
  }
  const root = resolve(projectRoot);
  const stateDir = join(root, '.qwen', 'bughunter', 'state', preset);
  const files = new Map();
  await addFile(files, root, join(root, '.qwen', 'bughunter.json'));
  await addFile(files, root, join(stateDir, 'config.json'));
  await addDirectory(files, root, join(stateDir, 'profiles'));
  await addDirectory(files, root, join(stateDir, 'scenarios'));
  if (preset === 'node'
    && ![...files.keys()].some((key) => key.startsWith('.qwen/bughunter/state/node/profiles/'))) {
    throw setupError('ACTIVATION_SETUP_FILES_REQUIRED', 'node profile');
  }
  return {
    projectRoot: root,
    files: Object.fromEntries([...files.entries()].sort(([first], [second]) => first.localeCompare(second))),
  };
}

async function readPublicEvidence(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw setupError('ACTIVATION_PUBLIC_EVIDENCE_MISSING', path);
  }
  let evidence;
  try {
    evidence = JSON.parse(raw);
  } catch {
    throw setupError('ACTIVATION_PUBLIC_EVIDENCE_INVALID', 'json');
  }
  if (evidence?.host !== 'qwen'
    || evidence?.surface !== 'cli'
    || evidence?.gate !== 'public-install'
    || evidence?.status !== 'passed'
    || evidence?.source !== 'github-marketplace'
    || evidence?.public !== true
    || evidence?.sha256Verified !== true
    || evidence?.statePreserved !== true
    || typeof evidence?.sourceCommit !== 'string'
    || typeof evidence?.clientVersion !== 'string'
    || evidence.clientVersion.trim() === ''
    || !SEMVER.test(evidence?.updatedTo ?? '')) {
    throw setupError('ACTIVATION_PUBLIC_EVIDENCE_INVALID', 'shape');
  }
  return evidence;
}

function sameFiles(first, second) {
  const firstKeys = Object.keys(first).sort();
  const secondKeys = Object.keys(second).sort();
  return firstKeys.length === secondKeys.length
    && firstKeys.every((key, index) => key === secondKeys[index] && first[key] === second[key]);
}

async function transcriptDigest(path) {
  try {
    return createHash('sha256').update(await readFile(path)).digest('hex');
  } catch {
    throw setupError('TRANSCRIPT_READ_FAILED', path);
  }
}

export async function recordActivationGate({
  beforeTranscriptPath,
  afterTranscriptPath,
  beforeSnapshot,
  afterSnapshot,
  publicInstallEvidencePath,
  installList,
  configDir,
  evidenceDir,
  spawn = spawnSync,
}) {
  if (typeof evidenceDir !== 'string'
    || typeof configDir !== 'string'
    || typeof beforeTranscriptPath !== 'string'
    || typeof afterTranscriptPath !== 'string') {
    throw setupError('ACTIVATION_CONTEXT_MISMATCH');
  }
  const publicEvidence = await readPublicEvidence(publicInstallEvidencePath);
  if (!COMMIT.test(publicEvidence.sourceCommit)) throw setupError('ACTIVATION_PAYLOAD_MISMATCH');
  const clientVersion = clientVersionFrom(spawn);
  if (clientVersion !== publicEvidence.clientVersion) throw setupError('ACTIVATION_CLIENT_MISMATCH');

  const installed = installedPlugin(installList);
  if (installed.version !== publicEvidence.updatedTo) throw setupError('ACTIVATION_PAYLOAD_MISMATCH');
  if (typeof installed.installPath !== 'string') throw setupError('ACTIVATION_CONTEXT_MISMATCH');
  const configRoot = resolve(configDir);
  const installRoot = resolve(installed.installPath);
  const relativeInstall = relative(configRoot, installRoot);
  if (relativeInstall === '' || relativeInstall.startsWith('..') || isAbsolute(relativeInstall)) {
    throw setupError('ACTIVATION_CONTEXT_MISMATCH', 'installPath');
  }
  try {
    await access(installRoot);
  } catch {
    throw setupError('ACTIVATION_CONTEXT_MISMATCH', 'installPath');
  }

  const inspected = await inspectQwenActivation({ beforeTranscriptPath, afterTranscriptPath });
  for (const snapshot of [beforeSnapshot, afterSnapshot]) {
    if (snapshot === null || typeof snapshot !== 'object'
      || typeof snapshot.projectRoot !== 'string'
      || snapshot.files === null || typeof snapshot.files !== 'object') {
      throw setupError('ACTIVATION_SETUP_FILES_REQUIRED');
    }
  }
  if (resolve(beforeSnapshot.projectRoot) !== resolve(afterSnapshot.projectRoot)
    || resolve(afterSnapshot.projectRoot) !== resolve(inspected.projectRoot)
    || installRoot !== resolve(inspected.pluginRoot)) {
    throw setupError('ACTIVATION_CONTEXT_MISMATCH');
  }
  for (const file of REQUIRED_SETUP_FILES) {
    if (!(file in beforeSnapshot.files) || !(file in afterSnapshot.files)) {
      throw setupError('ACTIVATION_SETUP_FILES_REQUIRED', file);
    }
  }
  if (!sameFiles(beforeSnapshot.files, afterSnapshot.files)) {
    throw setupError('ACTIVATION_CONFIG_CHANGED');
  }

  const transcriptSha256 = await Promise.all([
    transcriptDigest(beforeTranscriptPath),
    transcriptDigest(afterTranscriptPath),
  ]);
  const evidence = {
    host: 'qwen',
    surface: 'cli',
    gate: 'activation',
    status: 'passed',
    sourceCommit: publicEvidence.sourceCommit,
    clientVersion,
    pluginVersion: installed.version,
    activationMode: 'new-session',
    setupValidated: inspected.setupValidated,
    restartVerified: inspected.restartVerified,
    newSessionVerified: inspected.newSessionVerified,
    sameProjectVerified: inspected.sameProjectVerified,
    configPreserved: true,
    continuationVerified: inspected.continuationVerified,
    activeToolsVerified: inspected.activeToolsVerified,
    preset: 'web',
    toolCount: inspected.toolCount,
    skillCount: inspected.skillCount,
    agentCount: inspected.agentCount,
    transcriptSha256,
  };
  const directory = join(evidenceDir, 'qwen');
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'activation.json');
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return path;
}
