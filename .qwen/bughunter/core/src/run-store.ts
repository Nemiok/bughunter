import { execFile as execFileCallback } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { ReportFormat } from './preset.ts';
import type { Candidate, CandidateVerdict, Config, ExploreQueueItem, Finding, OperationStage, TargetStage, Run, Scope } from './types.ts';

const execFile = promisify(execFileCallback);

function validateRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) || runId === '.' || runId === '..') {
    throw new Error(`RUN_ID_INVALID: ${runId}`);
  }
}

function runPath(runId: string, stateDir: string): string {
  validateRunId(runId);
  return join(stateDir, 'runs', runId, 'run.json');
}

async function writeAtomic(file: string, contents: string): Promise<void> {
  const directory = dirname(file);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx');
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, file);
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) {
    throw new TypeError('JSON_VALUE_REQUIRED');
  }
  await writeAtomic(file, `${serialized}\n`);
}

function globMatches(pattern: string, path: string): boolean {
  const escape = (value: string) => value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  const source = pattern
    .split(/(\*\*\/|\*\*|\*)/)
    .map((part) => {
      if (part === '**/') return '(?:.*/)?';
      if (part === '**') return '.*';
      if (part === '*') return '[^/]*';
      return escape(part);
    })
    .join('');
  return new RegExp(`^${source}$`).test(path);
}

async function diffTargets(config: Config, targets: readonly string[], projectRoot: string): Promise<string[]> {
  const { stdout } = await execFile('git', ['diff', '--name-only', `${config.baseBranch}...HEAD`], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  const files = stdout.split(/\r?\n/).filter(Boolean).map((file) => file.replace(/\\/g, '/'));
  const matched = targets.filter((target) =>
    Object.entries(config.targetMap).some(([pattern, mappedTargets]) =>
      mappedTargets.includes(target) && files.some((file) => globMatches(pattern, file)),
    ),
  );
  return matched.length > 0 ? [...matched] : [...targets];
}

export async function createRun(
  scope: Scope,
  target: string | undefined,
  deps: {
    config: Config;
    projectRoot: string;
    stateDir: string;
    personas: readonly string[];
    /** Инвентарь целей: его состав знает пресет, core получает только список. */
    targets: readonly string[];
  },
): Promise<Run> {
  let targets: string[];
  if (scope === 'target') {
    if (target === undefined) throw new Error('TARGET_REQUIRED');
    if (!deps.targets.includes(target)) throw new Error(`TARGET_NOT_ALLOWED: ${target}`);
    targets = [target];
  } else if (scope === 'sweep') {
    // Пустой список — весь инвентарь пресета, одна цель — обход только её. Принадлежность
    // цели инвентарю проверяет сам обход: только он читает инвентарь приложения.
    if (target !== undefined && target.length === 0) throw new Error('TARGET_REQUIRED');
    targets = target === undefined ? [] : [target];
  } else if (scope === 'diff') {
    targets = await diffTargets(deps.config, deps.targets, deps.projectRoot);
  } else {
    targets = [...deps.targets];
  }

  // Детерминированный обход не даёт модели очередь исследования: цели обходит `bh_sweep`.
  const deterministic = scope === 'sweep';
  const timestamp = new Date();
  const id = `${timestamp.toISOString().replace(/[-:]/g, '')}-${randomBytes(6).toString('hex')}`;
  const run: Run = {
    id,
    scope,
    targets,
    status: 'created',
    stages: deterministic
      ? { sweep: 'pending', findings: 'pending', reproduce: 'pending', triage: 'pending', export: 'pending' }
      : { explore: 'pending', reproduce: 'pending', triage: 'pending', export: 'pending' },
    targetStages: Object.fromEntries(targets.map((entry) => [entry, 'pending'])),
    ...(deterministic ? {} : { exploreQueue: buildExploreQueue(targets, deps.personas) }),
    createdAt: timestamp.toISOString(),
    updatedAt: timestamp.toISOString(),
  };
  await writeJsonAtomic(runPath(id, deps.stateDir), run);
  return run;
}

function buildExploreQueue(targets: readonly string[], personas: readonly string[]): ExploreQueueItem[] {
  return targets.flatMap((target) =>
    personas.map((persona) => ({
      id: `${target}::${persona}`,
      target,
      persona,
      status: 'pending' as const,
    })),
  );
}

export type ExploreNextResult =
  | { status: 'done' }
  | { status: 'busy'; activeTarget: string }
  | { status: 'task'; leaseId: string; target: string; persona: string };

const defaultStaleLeaseMs = 30 * 60 * 1000;

function queueFor(run: Run, personas: readonly string[]): ExploreQueueItem[] {
  // Прогоны, созданные до появления очереди, получают её лениво: уже завершённые цели не переисследуются.
  return run.exploreQueue ?? buildExploreQueue(run.targets.filter((target) => run.targetStages[target] !== 'done'), personas);
}

export async function leaseNextExploration(
  runId: string,
  options: { personas: readonly string[]; target?: string; staleLeaseMs?: number; now?: () => number; keepLeaseIds?: ReadonlySet<string> },
  stateDir: string,
): Promise<ExploreNextResult> {
  const run = await readRun(runId, stateDir);
  const now = options.now?.() ?? Date.now();
  const staleLeaseMs = options.staleLeaseMs ?? defaultStaleLeaseMs;
  const keep = options.keepLeaseIds ?? new Set<string>();
  let changed = run.exploreQueue === undefined;
  const queue = queueFor(run, options.personas).map((item) => {
    // Lease живой в этом процессе сессии не является устаревшим, сколько бы он ни длился.
    if (
      item.status === 'leased' && item.leasedAt !== undefined && item.leaseId !== undefined
      && !keep.has(item.leaseId) && now - Date.parse(item.leasedAt) >= staleLeaseMs
    ) {
      changed = true;
      return { ...item, status: 'pending' as const, leaseId: undefined, leasedAt: undefined };
    }
    return item;
  });

  const active = queue.find((item) => item.status === 'leased');
  if (active) {
    if (changed) await updateRun(runId, { exploreQueue: queue }, stateDir);
    return { status: 'busy', activeTarget: active.target };
  }
  const next = queue.find((item) =>
    item.status === 'pending' && (options.target === undefined || item.target === options.target),
  );
  if (!next) {
    if (changed) await updateRun(runId, { exploreQueue: queue }, stateDir);
    return { status: 'done' };
  }
  const leased: ExploreQueueItem = {
    ...next,
    status: 'leased',
    leaseId: randomUUID(),
    leasedAt: new Date(now).toISOString(),
  };
  await updateRun(runId, { exploreQueue: queue.map((item) => (item.id === next.id ? leased : item)) }, stateDir);
  return { status: 'task', leaseId: leased.leaseId!, target: leased.target, persona: leased.persona };
}

function findLease(run: Run, leaseId: string): ExploreQueueItem | undefined {
  return run.exploreQueue?.find((item) => item.leaseId !== undefined && item.leaseId === leaseId);
}

export async function validateExplorationLease(
  runId: string,
  leaseId: string,
  target: string,
  persona: string,
  stateDir: string,
): Promise<void> {
  const run = await readRun(runId, stateDir);
  const item = findLease(run, leaseId);
  if (!item || item.status !== 'leased') throw new Error(`LEASE_UNKNOWN: ${leaseId}`);
  if (item.target !== target || item.persona !== persona) {
    throw new Error(`LEASE_MISMATCH: ${leaseId} ${item.target} ${item.persona}`);
  }
}

async function settleLease(
  runId: string,
  leaseId: string,
  status: 'done' | 'pending',
  stateDir: string,
): Promise<void> {
  const run = await readRun(runId, stateDir);
  const item = findLease(run, leaseId);
  if (!item) throw new Error(`LEASE_UNKNOWN: ${leaseId}`);
  await updateRun(runId, {
    exploreQueue: run.exploreQueue?.map((entry) =>
      entry.id === item.id ? { ...entry, status, leaseId: undefined, leasedAt: undefined } : entry,
    ),
  }, stateDir);
}

export async function completeExplorationLease(runId: string, leaseId: string, stateDir: string): Promise<void> {
  await settleLease(runId, leaseId, 'done', stateDir);
}

export async function releaseExplorationLease(runId: string, leaseId: string, stateDir: string): Promise<void> {
  await settleLease(runId, leaseId, 'pending', stateDir);
}

export async function reclaimExplorationLeases(
  runId: string,
  stateDir: string,
  keepLeaseIds?: ReadonlySet<string>,
): Promise<void> {
  const run = await readRun(runId, stateDir);
  const keep = keepLeaseIds ?? new Set<string>();
  if (!run.exploreQueue?.some((item) => item.status === 'leased' && item.leaseId !== undefined && !keep.has(item.leaseId))) return;
  await updateRun(runId, {
    exploreQueue: run.exploreQueue.map((item) =>
      item.status === 'leased' && item.leaseId !== undefined && !keep.has(item.leaseId)
        ? { ...item, status: 'pending', leaseId: undefined, leasedAt: undefined }
        : item,
    ),
  }, stateDir);
}

/** Имена полей до разреза core/preset: состояние с ними отвергается явно, а не молча теряет стадии. */
const retiredRunFields = ['routeStages', 'routes'] as const;

export async function readRun(runId: string, stateDir: string): Promise<Run> {
  const file = runPath(runId, stateDir);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`RUN_NOT_FOUND: ${runId}`);
    }
    throw error;
  }
  if (value !== null && typeof value === 'object') {
    for (const field of retiredRunFields) {
      if (field in value) throw new Error(`RUN_SCHEMA_INVALID: ${field}`);
    }
  }
  return value as Run;
}

export async function updateRun(runId: string, patch: Partial<Run>, stateDir: string): Promise<Run> {
  const file = runPath(runId, stateDir);
  const current = await readRun(runId, stateDir);
  const updated: Run = { ...current, ...patch, id: current.id, updatedAt: new Date().toISOString() };
  await writeJsonAtomic(file, updated);
  return updated;
}

export async function recordRunStage(
  runId: string,
  stage: keyof Run['stages'],
  status: OperationStage,
  stateDir: string,
): Promise<Run> {
  const run = await readRun(runId, stateDir);
  const stageStatus: Partial<Record<keyof Run['stages'], Run['status']>> = {
    explore: 'exploring', sweep: 'exploring', findings: 'exploring',
    reproduce: 'reproducing', triage: 'reviewing', export: 'writing_tests',
  };
  return updateRun(runId, {
    status: run.status === 'finished' ? 'finished' : stageStatus[stage] ?? run.status,
    stages: { ...run.stages, [stage]: status },
  }, stateDir);
}

/**
 * Цель, которую назвал пресет, приводится к цели из списка прогона: конкретное значение
 * (`/orders/12?x=1`) соответствует настроенной цели (`/orders`), иначе её стадия никогда
 * не закроется и прогон нельзя будет завершить.
 */
function targetName(target: string, configuredTargets: string[]): string {
  if (configuredTargets.includes(target)) return target;
  const withoutQuery = target.split(/[?#]/)[0]!;
  const configured = configuredTargets.find((entry) => entry.split(/[?#]/)[0] === withoutQuery);
  return configured ?? target;
}

export async function recordTargetExploration(
  runId: string,
  target: string,
  status: TargetStage,
  stateDir: string,
): Promise<Run> {
  const run = await readRun(runId, stateDir);
  const targetStages: Record<string, TargetStage> = {
    ...Object.fromEntries(run.targets.map((configuredTarget) => [configuredTarget, 'pending'])),
    ...run.targetStages,
    [targetName(target, run.targets)]: status,
  };
  const selectedStages = run.targets.map((configuredTarget) => targetStages[configuredTarget] ?? 'pending');
  const explore = selectedStages.some((value) => value === 'failed')
    ? 'failed'
    : selectedStages.every((value) => value === 'done') ? 'done' : 'running';
  return updateRun(runId, {
    status: run.status === 'finished' ? 'finished' : 'exploring',
    stages: { ...run.stages, explore },
    targetStages,
  }, stateDir);
}

export type SharedMemoryEntry = {
  id: string;
  signature: string;
  title?: string;
  target?: string;
  reason: string;
  sourceCandidate: string;
  createdAt: string;
  updatedAt: string;
};

export type TriageInput = {
  runId: string;
  candidateId: string;
  verdict: 'confirmed' | 'rejected' | 'duplicate';
  reason: string;
  suppress?: boolean;
  stateDir: string;
};

export function candidatePath(runId: string, candidateId: string, stateDir: string): string {
  validateRunId(runId);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(candidateId) || candidateId === '.' || candidateId === '..') {
    throw new Error(`CANDIDATE_ID_INVALID: ${candidateId}`);
  }
  return join(stateDir, 'runs', runId, 'candidates', `${candidateId}.json`);
}

export async function readCandidate(runId: string, candidateId: string, stateDir: string): Promise<Candidate> {
  try {
    return JSON.parse(await readFile(candidatePath(runId, candidateId, stateDir), 'utf8')) as Candidate;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // Находка детерминированного обхода — не кандидат: у неё нет журнала сессии, поэтому
      // triage или экспорт по её id были бы молчаливой подменой сущности.
      if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(candidateId)) {
        const finding = join(stateDir, 'runs', runId, 'findings', `${candidateId}.json`);
        try {
          await readFile(finding, 'utf8');
        } catch {
          throw new Error(`CANDIDATE_NOT_FOUND: ${candidateId}`);
        }
        throw new Error(`FINDING_NOT_CANDIDATE: ${candidateId}`);
      }
      throw new Error(`CANDIDATE_NOT_FOUND: ${candidateId}`);
    }
    throw error;
  }
}

export function findingPath(runId: string, findingId: string, stateDir: string): string {
  return join(stateDir, 'runs', runId, 'findings', `${findingId}.json`);
}

/** legacy-envelope: имена конверта до нейтрализации — по ним читаются находки старых прогонов. */
type LegacyEnvelope = { widget?: string; responseHashes?: string[] }; // legacy-envelope

type StoredFinding = Omit<Finding, 'subject' | 'evidenceHashes'> & {
  subject?: string;
  evidenceHashes?: string[];
} & LegacyEnvelope;

function normalizeFinding(stored: StoredFinding): Finding {
  const { widget, responseHashes, ...finding } = stored; // legacy-envelope
  const subject = finding.subject ?? widget; // legacy-envelope
  return {
    ...finding,
    ...(subject === undefined ? {} : { subject }),
    evidenceHashes: finding.evidenceHashes ?? responseHashes ?? [],
  };
}

export async function readFindings(runId: string, stateDir: string): Promise<Finding[]> {
  const directory = join(stateDir, 'runs', runId, 'findings');
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const findings = await Promise.all(files.filter((file) => file.endsWith('.json'))
    .map(async (file) => normalizeFinding(JSON.parse(await readFile(join(directory, file), 'utf8')) as StoredFinding)));
  return findings.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function writeFinding(finding: Finding, stateDir: string): Promise<void> {
  await writeJsonAtomic(findingPath(finding.runId, finding.id, stateDir), finding);
}

async function readCandidates(runId: string, stateDir: string): Promise<Candidate[]> {
  const directory = join(stateDir, 'runs', runId, 'candidates');
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const candidates = await Promise.all(files.filter((file) => file.endsWith('.json')).sort().map(async (file) =>
    JSON.parse(await readFile(join(directory, file), 'utf8')) as Candidate,
  ));
  return candidates.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

/**
 * Какой вид теста обязателен для подтверждённого бага, знает пресет (`ExportTarget.kind`):
 * без этого знания core считал бы достаточным любой тест и пропустил прогон без регрессии.
 */
function requiresWork(candidate: Candidate, requiredTestKind?: string): boolean {
  if (candidate.status === 'rejected' || candidate.status === 'duplicate') return false;
  if (candidate.status === 'confirmed') {
    if (requiredTestKind !== undefined) {
      // Записанный тест — ещё не регрессия: нужен явный red verdict от `bh_verify_red`.
      const missingTest = candidate.tests?.[requiredTestKind] === undefined;
      const verdict = candidate.verdicts?.[requiredTestKind];
      return candidate.reproduction?.status !== 'reproduced' || missingTest || verdict !== 'red';
    }
    return candidate.reproduction?.status !== 'reproduced'
      || Object.keys(candidate.tests ?? {}).length === 0;
  }
  return candidate.reproduction?.status !== 'unreproduced' || candidate.reproduction.attempts === 0;
}

export async function resumeRun(
  runId: string,
  stateDir: string,
  requiredTestKind?: string,
): Promise<{ run: Run; pendingCandidates: Candidate[] }> {
  const run = await readRun(runId, stateDir);
  const candidates = await readCandidates(runId, stateDir);
  return { run, pendingCandidates: candidates.filter((candidate) => requiresWork(candidate, requiredTestKind)) };
}

function storedTestPath(file: string, runId: string, stateDir: string): string {
  const root = dirname(runPath(runId, stateDir));
  const absolute = isAbsolute(file)
    ? resolve(file)
    : resolve(file.replaceAll('\\', '/').startsWith(`runs/${runId}/`) ? join(stateDir, file) : join(root, file));
  const relativePath = relative(root, absolute);
  const insideRun = relativePath !== '' && relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
  return (insideRun ? relativePath : absolute).split(sep).join('/');
}

export async function recordCandidateTest(
  runId: string,
  candidateId: string,
  kind: string,
  file: string,
  stateDir: string,
  verdict?: CandidateVerdict,
): Promise<Candidate> {
  const candidate = await readCandidate(runId, candidateId, stateDir);
  if (candidate.runId !== runId) throw new Error(`CANDIDATE_RUN_MISMATCH: ${candidateId}`);
  const updated: Candidate = {
    ...candidate,
    tests: { ...candidate.tests, [kind]: storedTestPath(file, runId, stateDir) },
    ...(verdict === undefined ? {} : { verdicts: { ...candidate.verdicts, [kind]: verdict } }),
  };
  await writeJsonAtomic(candidatePath(runId, candidateId, stateDir), updated);
  return updated;
}

export async function readSharedMemory(name: 'known-bugs.json' | 'suppressions.json', stateDir: string): Promise<SharedMemoryEntry[]> {
  try {
    const value = JSON.parse(await readFile(join(stateDir, name), 'utf8')) as unknown;
    if (!Array.isArray(value)) throw new Error(`SHARED_MEMORY_INVALID: ${name}`);
    return value as SharedMemoryEntry[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function memoryEntry(candidate: Candidate, reason: string, previous?: SharedMemoryEntry): SharedMemoryEntry {
  const now = new Date().toISOString();
  return {
    id: previous?.id ?? candidate.id,
    signature: candidate.signature,
    title: candidate.title,
    target: candidate.target,
    reason,
    sourceCandidate: candidate.id,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
}

export async function triageCandidate(input: TriageInput): Promise<Candidate> {
  await readRun(input.runId, input.stateDir);
  const candidate = await readCandidate(input.runId, input.candidateId, input.stateDir);
  if (candidate.runId !== input.runId) throw new Error(`CANDIDATE_RUN_MISMATCH: ${input.candidateId}`);
  if (candidate.reproduction?.status !== 'reproduced') {
    throw new Error(`CANDIDATE_UNREPRODUCED: ${input.candidateId}`);
  }
  const knownPath = join(input.stateDir, 'known-bugs.json');
  const suppressionsPath = join(input.stateDir, 'suppressions.json');
  let duplicateOf = candidate.duplicateOf;

  if (input.verdict === 'confirmed') {
    const suppressions = await readSharedMemory('suppressions.json', input.stateDir);
    if (suppressions.some((entry) => entry.signature === candidate.signature)) {
      throw new Error(`SIGNATURE_SUPPRESSED: ${candidate.signature}`);
    }
    const known = await readSharedMemory('known-bugs.json', input.stateDir);
    const index = known.findIndex((entry) => entry.signature === candidate.signature);
    const previous = index < 0 ? undefined : known[index];
    const entry = memoryEntry(candidate, input.reason, previous);
    if (index < 0) known.push(entry);
    else known[index] = entry;
    await writeJsonAtomic(knownPath, known);
  } else if (input.verdict === 'duplicate') {
    const known = await readSharedMemory('known-bugs.json', input.stateDir);
    const target = known.find((entry) => entry.signature === candidate.signature);
    if (!target) throw new Error(`DUPLICATE_TARGET_NOT_FOUND: ${candidate.signature}`);
    duplicateOf = target.id;
  } else if (input.suppress === true) {
    const suppressions = await readSharedMemory('suppressions.json', input.stateDir);
    const index = suppressions.findIndex((entry) => entry.signature === candidate.signature);
    const previous = index < 0 ? undefined : suppressions[index];
    const entry = memoryEntry(candidate, input.reason, previous);
    if (index < 0) suppressions.push(entry);
    else suppressions[index] = entry;
    await writeJsonAtomic(suppressionsPath, suppressions);
  }

  const updated: Candidate = {
    ...candidate,
    status: input.verdict,
    review: { status: input.verdict, reason: input.reason },
    ...(duplicateOf === undefined ? {} : { duplicateOf }),
  };
  await writeJsonAtomic(candidatePath(input.runId, input.candidateId, input.stateDir), updated);
  return updated;
}

export function escapeMarkdown(value: string): string {
  return value.replace(/\s+/g, ' ').trim().replace(/[\\`*_{}\[\]<>()#+!|]/g, '\\$&');
}

function portablePath(value: string): string {
  return value.split(sep).join('/');
}

function artifactPath(file: string, runId: string, stateDir: string): string {
  const root = dirname(runPath(runId, stateDir));
  const normalized = file.replaceAll('\\', '/');
  const stored = normalized.startsWith(`runs/${runId}/`) ? normalized.slice(`runs/${runId}/`.length) : file;
  const absolute = isAbsolute(stored) ? resolve(stored) : resolve(root, stored);
  const relativePath = relative(root, absolute);
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`ARTIFACT_PATH_UNSAFE: ${file}`);
  }
  return portablePath(relativePath);
}

function reportTestPath(file: string, runId: string, stateDir: string): string {
  const normalized = file.replaceAll('\\', '/');
  const prefix = `runs/${runId}/`;
  if (normalized.startsWith(prefix)) return normalized.slice(prefix.length);
  if (!isAbsolute(file)) return normalized;
  const root = dirname(runPath(runId, stateDir));
  const relativePath = relative(root, resolve(file));
  return relativePath && relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)
    ? portablePath(relativePath)
    : portablePath(resolve(file));
}

function candidateHeader(candidate: Candidate): string[] {
  return [
    `### ${escapeMarkdown(candidate.title)}`,
    '',
    `- Candidate: ${escapeMarkdown(candidate.id)}`,
    `- Target: ${escapeMarkdown(candidate.target)}`,
  ];
}

function confirmedReport(candidate: Candidate, runId: string, stateDir: string, format: ReportFormat): string {
  const lines = candidateHeader(candidate);
  lines.push(`- Expected: ${escapeMarkdown(candidate.expected)}`);
  lines.push(`- Actual: ${escapeMarkdown(candidate.actual)}`);
  if (candidate.review) lines.push(`- Review: ${escapeMarkdown(candidate.review.reason)}`);
  lines.push('', '#### Steps', '');
  const stepLines = format.candidate(candidate);
  if (stepLines.length === 0) lines.push('None.');
  else lines.push(...stepLines);
  lines.push('', '- Artifacts:');
  if (candidate.artifacts.length === 0) lines.push('  - None.');
  else lines.push(...candidate.artifacts.map((file) => `  - ${escapeMarkdown(artifactPath(file, runId, stateDir))}`));
  lines.push('- Created tests:');
  // Виды тестов — словарь пресета, поэтому отчёт перебирает записи, а не печатает свои имена.
  const createdTests = Object.entries(candidate.tests ?? {});
  if (createdTests.length === 0) lines.push('  - None.');
  for (const [kind, file] of createdTests) {
    lines.push(`  - ${kind}: ${escapeMarkdown(reportTestPath(file, runId, stateDir))}`);
  }
  return lines.join('\n');
}

function reviewedReport(candidate: Candidate): string {
  const lines = candidateHeader(candidate);
  lines.push(`- Reason: ${escapeMarkdown(candidate.review?.reason ?? 'No reason recorded')}`);
  if (candidate.duplicateOf) lines.push(`- Duplicate of: ${escapeMarkdown(candidate.duplicateOf)}`);
  return lines.join('\n');
}

function pendingReport(candidate: Candidate): string {
  const lines = candidateHeader(candidate);
  lines.push(`- Status: ${candidate.status}`);
  lines.push(`- Reproduction: ${candidate.reproduction?.status ?? 'unreproduced'} (${candidate.reproduction?.attempts ?? 0} attempts)`);
  return lines.join('\n');
}

function reportSection(title: string, entries: string[]): string {
  return [`## ${title}`, '', entries.length > 0 ? entries.join('\n\n') : 'None.', ''].join('\n');
}

function renderReport(run: Run, candidates: Candidate[], findings: Finding[], stateDir: string, format: ReportFormat, requiredTestKind?: string): string {
  const confirmed = candidates.filter((candidate) => candidate.status === 'confirmed');
  const rejected = candidates.filter((candidate) => candidate.status === 'rejected');
  const duplicates = candidates.filter((candidate) => candidate.status === 'duplicate');
  const unreproduced = candidates.filter((candidate) =>
    candidate.status !== 'confirmed' && candidate.status !== 'rejected' && candidate.status !== 'duplicate'
    && candidate.reproduction?.status === 'unreproduced' && candidate.reproduction.attempts > 0,
  );
  const pending = candidates.filter((candidate) => requiresWork(candidate, requiredTestKind));
  return [
    '# Bughunter report', '', `- Run: ${run.id}`, `- Scope: ${run.scope}`, '',
    reportSection('Confirmed', confirmed.map((candidate) => confirmedReport(candidate, run.id, stateDir, format))),
    reportSection('Rejected', rejected.map(reviewedReport)),
    reportSection('Duplicates', duplicates.map(reviewedReport)),
    reportSection('Unreproduced', unreproduced.map(pendingReport)),
    reportSection('Pending', pending.map(pendingReport)),
    // Секция появляется только у прогонов с находками: отчёты существующих областей не меняются.
    ...(findings.length === 0 ? [] : [reportSection('Findings', findings.map((finding) => format.finding(finding).join('\n')))]),
  ].join('\n');
}

export async function finishRun(runId: string, stateDir: string, format: ReportFormat, requiredTestKind?: string): Promise<{ report: string }> {
  const { pendingCandidates } = await resumeRun(runId, stateDir, requiredTestKind);
  if (pendingCandidates.length > 0) {
    throw new Error(`RUN_INCOMPLETE: ${pendingCandidates.map((candidate) => candidate.id).join(',')}`);
  }
  const run = await readRun(runId, stateDir);
  // Завершённость проверяется по фактической области: у детерминированного обхода нет стадий
  // исследования на весь список целей, но незакрытый sweep означал бы отчёт по неполному инвентарю.
  if (run.scope === 'sweep' && run.stages.sweep !== 'done') {
    throw new Error('RUN_INCOMPLETE: sweep');
  }
  // Очередь точнее `targetStages`: цель помечается готовой закрытием любой её сессии, а задача
  // очереди есть на каждую пару цель×персона. Без этой проверки прогон, исследовавший по одной
  // персоне на цель, завершался с `finished` и `Pending: None`.
  const queue = run.exploreQueue ?? [];
  const unfinishedTasks = queue.filter((item) => item.status !== 'done');
  if (unfinishedTasks.length > 0) {
    throw new Error(`RUN_INCOMPLETE: queue ${unfinishedTasks.length} of ${queue.length}`);
  }
  const incompleteTargets = run.targets.filter((target) => run.targetStages[target] !== 'done');
  if (incompleteTargets.length > 0) {
    throw new Error(`RUN_INCOMPLETE: targets ${incompleteTargets.join(',')}`);
  }
  if (run.scope !== 'sweep') {
    // `pending` — этап, на который не было работы: очередь, цели и кандидаты уже проверены выше.
    // Завершению мешает только упавший или прерванный этап.
    const unfinishedStages = Object.entries(run.stages)
      .filter(([, status]) => status === 'failed' || status === 'running')
      .map(([name]) => name);
    if (unfinishedStages.length > 0) {
      throw new Error(`RUN_INCOMPLETE: stages ${unfinishedStages.join(',')}`);
    }
  }
  const [candidates, findings] = await Promise.all([readCandidates(runId, stateDir), readFindings(runId, stateDir)]);
  const contents = renderReport(run, candidates, findings, stateDir, format, requiredTestKind);
  const report = join(dirname(runPath(runId, stateDir)), 'report.md');
  await writeAtomic(report, contents);
  if (run.status !== 'finished') await updateRun(runId, { status: 'finished' }, stateDir);
  return { report };
}
