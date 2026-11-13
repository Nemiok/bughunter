import { execFile as execFileCallback } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { Candidate, Config, ExploreQueueItem, Finding, OperationStage, RouteStage, Run, Scope, Step } from '@bughunter/core';

const execFile = promisify(execFileCallback);
import { defaultStateDir } from './paths.ts';

function validateRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) || runId === '.' || runId === '..') {
    throw new Error(`RUN_ID_INVALID: ${runId}`);
  }
}

function runPath(runId: string, stateDir: string | undefined): string {
  validateRunId(runId);
  return join(stateDir ?? defaultStateDir, 'runs', runId, 'run.json');
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

async function diffRoutes(config: Config, projectRoot: string): Promise<string[]> {
  const { stdout } = await execFile('git', ['diff', '--name-only', `${config.baseBranch}...HEAD`], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  const files = stdout.split(/\r?\n/).filter(Boolean).map((file) => file.replace(/\\/g, '/'));
  const routes = config.routes.filter((route) =>
    Object.entries(config.routeMap).some(([pattern, mappedRoutes]) =>
      mappedRoutes.includes(route) && files.some((file) => globMatches(pattern, file)),
    ),
  );
  return routes.length > 0 ? routes : [...config.routes];
}

export async function createRun(
  scope: Scope,
  route: string | undefined,
  deps: { config: Config; projectRoot: string; stateDir: string },
): Promise<Run> {
  let routes: string[];
  if (scope === 'route') {
    if (route === undefined) {
      throw new Error('ROUTE_REQUIRED');
    }
    if (!deps.config.routes.includes(route)) {
      throw new Error(`ROUTE_NOT_ALLOWED: ${route}`);
    }
    routes = [route];
  } else if (scope === 'screen') {
    // Шаблон экрана не обязан быть в config.routes: инвентарь шире списка настроенных маршрутов.
    // Наличие шаблона проверяет обход — он единственный, кто читает screens.json.
    if (route === undefined || !route.startsWith('/')) {
      throw new Error('ROUTE_REQUIRED');
    }
    routes = [route];
  } else if (scope === 'sweep') {
    routes = [];
  } else if (scope === 'diff') {
    routes = await diffRoutes(deps.config, deps.projectRoot);
  } else {
    routes = [...deps.config.routes];
  }

  // Детерминированные области не дают модели очередь исследования: экраны обходит bh_sweep.
  const deterministic = scope === 'sweep' || scope === 'screen';
  const timestamp = new Date();
  const id = `${timestamp.toISOString().replace(/[-:]/g, '')}-${randomBytes(6).toString('hex')}`;
  const run: Run = {
    id,
    scope,
    routes,
    status: 'created',
    stages: deterministic
      ? { sweep: 'pending', findings: 'pending', reproduce: 'pending', triage: 'pending', export: 'pending' }
      : { explore: 'pending', reproduce: 'pending', triage: 'pending', export: 'pending' },
    routeStages: Object.fromEntries(routes.map((route) => [route, 'pending'])),
    ...(deterministic ? {} : { exploreQueue: buildExploreQueue(routes) }),
    createdAt: timestamp.toISOString(),
    updatedAt: timestamp.toISOString(),
  };
  await writeJsonAtomic(runPath(id, deps.stateDir), run);
  return run;
}

export const EXPLORER_PERSONAS = ['новичок', 'нетерпеливый', 'граничный ввод'] as const;

function buildExploreQueue(routes: string[]): ExploreQueueItem[] {
  return routes.flatMap((route) =>
    EXPLORER_PERSONAS.map((persona) => ({
      id: `${route}::${persona}`,
      route,
      persona,
      status: 'pending' as const,
    })),
  );
}

export type ExploreNextResult =
  | { status: 'done' }
  | { status: 'busy'; activeRoute: string }
  | { status: 'task'; leaseId: string; route: string; persona: string };

const defaultStaleLeaseMs = 30 * 60 * 1000;

function queueFor(run: Run): ExploreQueueItem[] {
  // Прогоны, созданные до появления очереди, получают её лениво: уже завершённые маршруты не переисследуются.
  return run.exploreQueue ?? buildExploreQueue(run.routes.filter((route) => run.routeStages[route] !== 'done'));
}

export async function leaseNextExploration(
  runId: string,
  options: { route?: string; staleLeaseMs?: number; now?: () => number; keepLeaseIds?: ReadonlySet<string> },
  stateDir?: string,
): Promise<ExploreNextResult> {
  const run = await readRun(runId, stateDir);
  const now = options.now?.() ?? Date.now();
  const staleLeaseMs = options.staleLeaseMs ?? defaultStaleLeaseMs;
  const keep = options.keepLeaseIds ?? new Set<string>();
  let changed = run.exploreQueue === undefined;
  const queue = queueFor(run).map((item) => {
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
    return { status: 'busy', activeRoute: active.route };
  }
  const next = queue.find((item) =>
    item.status === 'pending' && (options.route === undefined || item.route === options.route),
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
  return { status: 'task', leaseId: leased.leaseId!, route: leased.route, persona: leased.persona };
}

function findLease(run: Run, leaseId: string): ExploreQueueItem | undefined {
  return run.exploreQueue?.find((item) => item.leaseId !== undefined && item.leaseId === leaseId);
}

export async function validateExplorationLease(
  runId: string,
  leaseId: string,
  route: string,
  persona: string,
  stateDir?: string,
): Promise<void> {
  const run = await readRun(runId, stateDir);
  const item = findLease(run, leaseId);
  if (!item || item.status !== 'leased') throw new Error(`LEASE_UNKNOWN: ${leaseId}`);
  if (item.route !== route || item.persona !== persona) {
    throw new Error(`LEASE_MISMATCH: ${leaseId} ${item.route} ${item.persona}`);
  }
}

async function settleLease(
  runId: string,
  leaseId: string,
  status: 'done' | 'pending',
  stateDir?: string,
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

export async function completeExplorationLease(runId: string, leaseId: string, stateDir?: string): Promise<void> {
  await settleLease(runId, leaseId, 'done', stateDir);
}

export async function releaseExplorationLease(runId: string, leaseId: string, stateDir?: string): Promise<void> {
  await settleLease(runId, leaseId, 'pending', stateDir);
}

export async function reclaimExplorationLeases(
  runId: string,
  stateDir?: string,
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

export async function readRun(runId: string, stateDir?: string): Promise<Run> {
  const file = runPath(runId, stateDir);
  try {
    return JSON.parse(await readFile(file, 'utf8')) as Run;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`RUN_NOT_FOUND: ${runId}`);
    }
    throw error;
  }
}

export async function updateRun(runId: string, patch: Partial<Run>, stateDir?: string): Promise<Run> {
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
  stateDir?: string,
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

function routeName(route: string, configuredRoutes: string[]): string {
  if (configuredRoutes.includes(route)) return route;
  try {
    const target = new URL(route, 'https://bughunter.invalid');
    const parsedRoutes = configuredRoutes.map((configuredRoute) => ({
      configuredRoute,
      url: new URL(configuredRoute, 'https://bughunter.invalid'),
    }));
    const exact = parsedRoutes.find(({ url }) => url.pathname === target.pathname && url.search === target.search);
    const pathOnly = parsedRoutes.find(({ url }) => url.pathname === target.pathname && url.search === '');
    return exact?.configuredRoute ?? pathOnly?.configuredRoute ?? `${target.pathname}${target.search}`;
  } catch {
    return route;
  }
}

export async function recordRouteExploration(
  runId: string,
  route: string,
  status: RouteStage,
  stateDir?: string,
): Promise<Run> {
  const run = await readRun(runId, stateDir);
  const routeStages: Record<string, RouteStage> = {
    ...Object.fromEntries(run.routes.map((configuredRoute) => [configuredRoute, 'pending'])),
    ...run.routeStages,
    [routeName(route, run.routes)]: status,
  };
  const selectedStages = run.routes.map((configuredRoute) => routeStages[configuredRoute] ?? 'pending');
  const explore = selectedStages.some((value) => value === 'failed')
    ? 'failed'
    : selectedStages.every((value) => value === 'done') ? 'done' : 'running';
  return updateRun(runId, {
    status: run.status === 'finished' ? 'finished' : 'exploring',
    stages: { ...run.stages, explore },
    routeStages,
  }, stateDir);
}

export type SharedMemoryEntry = {
  id: string;
  signature: string;
  title?: string;
  route?: string;
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
  stateDir?: string;
};

function candidatePath(runId: string, candidateId: string, stateDir: string | undefined): string {
  validateRunId(runId);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(candidateId) || candidateId === '.' || candidateId === '..') {
    throw new Error(`CANDIDATE_ID_INVALID: ${candidateId}`);
  }
  return join(stateDir ?? defaultStateDir, 'runs', runId, 'candidates', `${candidateId}.json`);
}

export async function readCandidate(runId: string, candidateId: string, stateDir?: string): Promise<Candidate> {
  try {
    return JSON.parse(await readFile(candidatePath(runId, candidateId, stateDir), 'utf8')) as Candidate;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // Находка детерминированного обхода — не кандидат: у неё нет журнала сессии, поэтому
      // triage или экспорт по её id были бы молчаливой подменой сущности.
      if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(candidateId)) {
        const finding = join(stateDir ?? defaultStateDir, 'runs', runId, 'findings', `${candidateId}.json`);
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

export function findingPath(runId: string, findingId: string, stateDir?: string): string {
  return join(stateDir ?? defaultStateDir, 'runs', runId, 'findings', `${findingId}.json`);
}

export async function readFindings(runId: string, stateDir?: string): Promise<Finding[]> {
  const directory = join(stateDir ?? defaultStateDir, 'runs', runId, 'findings');
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const findings = await Promise.all(files.filter((file) => file.endsWith('.json'))
    .map(async (file) => JSON.parse(await readFile(join(directory, file), 'utf8')) as Finding));
  return findings.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export async function writeFinding(finding: Finding, stateDir?: string): Promise<void> {
  await writeJsonAtomic(findingPath(finding.runId, finding.id, stateDir), finding);
}

async function readCandidates(runId: string, stateDir?: string): Promise<Candidate[]> {
  const directory = join(stateDir ?? defaultStateDir, 'runs', runId, 'candidates');
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

function requiresWork(candidate: Candidate): boolean {
  if (candidate.status === 'rejected' || candidate.status === 'duplicate') return false;
  if (candidate.status === 'confirmed') {
    return candidate.reproduction?.status !== 'reproduced' || candidate.tests?.e2e === undefined;
  }
  return candidate.reproduction?.status !== 'unreproduced' || candidate.reproduction.attempts === 0;
}

export async function resumeRun(runId: string, stateDir?: string): Promise<{ run: Run; pendingCandidates: Candidate[] }> {
  const run = await readRun(runId, stateDir);
  const candidates = await readCandidates(runId, stateDir);
  return { run, pendingCandidates: candidates.filter(requiresWork) };
}

function storedTestPath(file: string, runId: string, stateDir?: string): string {
  const root = dirname(runPath(runId, stateDir));
  const absolute = isAbsolute(file)
    ? resolve(file)
    : resolve(file.replaceAll('\\', '/').startsWith(`runs/${runId}/`) ? join(stateDir ?? defaultStateDir, file) : join(root, file));
  const relativePath = relative(root, absolute);
  const insideRun = relativePath !== '' && relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath);
  return (insideRun ? relativePath : absolute).split(sep).join('/');
}

export async function recordCandidateTest(
  runId: string,
  candidateId: string,
  kind: 'e2e' | 'unit',
  file: string,
  stateDir?: string,
): Promise<Candidate> {
  const candidate = await readCandidate(runId, candidateId, stateDir);
  if (candidate.runId !== runId) throw new Error(`CANDIDATE_RUN_MISMATCH: ${candidateId}`);
  const updated: Candidate = {
    ...candidate,
    tests: { ...candidate.tests, [kind]: storedTestPath(file, runId, stateDir) },
  };
  await writeJsonAtomic(candidatePath(runId, candidateId, stateDir), updated);
  return updated;
}

export async function readSharedMemory(name: 'known-bugs.json' | 'suppressions.json', stateDir?: string): Promise<SharedMemoryEntry[]> {
  try {
    const value = JSON.parse(await readFile(join(stateDir ?? defaultStateDir, name), 'utf8')) as unknown;
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
    route: candidate.route,
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
  const knownPath = join(input.stateDir ?? defaultStateDir, 'known-bugs.json');
  const suppressionsPath = join(input.stateDir ?? defaultStateDir, 'suppressions.json');
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

function escapeMarkdown(value: string): string {
  return value.replace(/\s+/g, ' ').trim().replace(/[\\`*_{}\[\]<>()#+!|]/g, '\\$&');
}

function portablePath(value: string): string {
  return value.split(sep).join('/');
}

function artifactPath(file: string, runId: string, stateDir?: string): string {
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

function reportTestPath(file: string, runId: string, stateDir?: string): string {
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

function stepText(step: Step): string {
  if (step.kind === 'act') {
    const target = step.locator ?? step.elementId ?? 'unknown element';
    return `${step.action ?? 'act'} ${target}${step.value === undefined ? '' : ` value=${step.value}`}`;
  }
  if (step.kind === 'navigate') return `navigate ${step.path ?? 'unknown path'}`;
  return `probe ${step.probe ?? 'unknown probe'}`;
}

function candidateHeader(candidate: Candidate): string[] {
  return [
    `### ${escapeMarkdown(candidate.title)}`,
    '',
    `- Candidate: ${escapeMarkdown(candidate.id)}`,
    `- Route: ${escapeMarkdown(candidate.route)}`,
  ];
}

function confirmedReport(candidate: Candidate, runId: string, stateDir?: string): string {
  const lines = candidateHeader(candidate);
  lines.push(`- Expected: ${escapeMarkdown(candidate.expected)}`);
  lines.push(`- Actual: ${escapeMarkdown(candidate.actual)}`);
  if (candidate.review) lines.push(`- Review: ${escapeMarkdown(candidate.review.reason)}`);
  lines.push('', '#### Steps', '');
  const steps = candidate.minimalSteps ?? candidate.steps;
  if (steps.length === 0) lines.push('None.');
  else lines.push(...steps.map((step, index) => `${index + 1}. ${escapeMarkdown(stepText(step))}`));
  lines.push('', '- Artifacts:');
  if (candidate.artifacts.length === 0) lines.push('  - None.');
  else lines.push(...candidate.artifacts.map((file) => `  - ${escapeMarkdown(artifactPath(file, runId, stateDir))}`));
  lines.push('- Created tests:');
  if (!candidate.tests?.e2e && !candidate.tests?.unit) lines.push('  - None.');
  if (candidate.tests?.e2e) lines.push(`  - E2E: ${escapeMarkdown(reportTestPath(candidate.tests.e2e, runId, stateDir))}`);
  if (candidate.tests?.unit) lines.push(`  - Unit: ${escapeMarkdown(reportTestPath(candidate.tests.unit, runId, stateDir))}`);
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

function findingReport(finding: Finding): string {
  return [
    `### ${finding.kind}: ${finding.screenTemplate}`, '',
    `- Finding: ${finding.id}`,
    ...(finding.widget === undefined ? [] : [`- Widget: ${finding.widget}`]),
    `- Detail: ${finding.detail.replaceAll('\n', ' ')}`,
    `- Status: ${finding.status}`,
    ...(finding.candidateId === undefined ? [] : [`- Candidate: ${finding.candidateId}`]),
    `- Responses: ${finding.responseHashes.length}`,
  ].join('\n');
}

function renderReport(run: Run, candidates: Candidate[], findings: Finding[], stateDir?: string): string {
  const confirmed = candidates.filter((candidate) => candidate.status === 'confirmed');
  const rejected = candidates.filter((candidate) => candidate.status === 'rejected');
  const duplicates = candidates.filter((candidate) => candidate.status === 'duplicate');
  const unreproduced = candidates.filter((candidate) =>
    candidate.status !== 'confirmed' && candidate.status !== 'rejected' && candidate.status !== 'duplicate'
    && candidate.reproduction?.status === 'unreproduced' && candidate.reproduction.attempts > 0,
  );
  const pending = candidates.filter(requiresWork);
  return [
    '# Bughunter report', '', `- Run: ${run.id}`, `- Scope: ${run.scope}`, '',
    reportSection('Confirmed', confirmed.map((candidate) => confirmedReport(candidate, run.id, stateDir))),
    reportSection('Rejected', rejected.map(reviewedReport)),
    reportSection('Duplicates', duplicates.map(reviewedReport)),
    reportSection('Unreproduced', unreproduced.map(pendingReport)),
    reportSection('Pending', pending.map(pendingReport)),
    // Секция появляется только у прогонов с находками: отчёты существующих областей не меняются.
    ...(findings.length === 0 ? [] : [reportSection('Findings', findings.map(findingReport))]),
  ].join('\n');
}

export async function finishRun(runId: string, stateDir?: string): Promise<{ report: string }> {
  const { pendingCandidates } = await resumeRun(runId, stateDir);
  if (pendingCandidates.length > 0) {
    throw new Error(`RUN_INCOMPLETE: ${pendingCandidates.map((candidate) => candidate.id).join(',')}`);
  }
  const run = await readRun(runId, stateDir);
  // Завершённость проверяется по фактической области: у детерминированного обхода нет маршрутных
  // стадий на весь список routes, но незакрытый sweep означал бы отчёт по неполному инвентарю.
  if ((run.scope === 'sweep' || run.scope === 'screen') && run.stages.sweep !== 'done') {
    throw new Error('RUN_INCOMPLETE: sweep');
  }
  const incompleteRoutes = run.routes.filter((route) => run.routeStages[route] !== 'done');
  if (incompleteRoutes.length > 0) {
    throw new Error(`RUN_INCOMPLETE: routes ${incompleteRoutes.join(',')}`);
  }
  const [candidates, findings] = await Promise.all([readCandidates(runId, stateDir), readFindings(runId, stateDir)]);
  const contents = renderReport(run, candidates, findings, stateDir);
  const report = join(dirname(runPath(runId, stateDir)), 'report.md');
  await writeAtomic(report, contents);
  if (run.status !== 'finished') await updateRun(runId, { status: 'finished' }, stateDir);
  return { report };
}
