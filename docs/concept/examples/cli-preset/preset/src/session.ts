import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { appendFile, mkdir, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { reportCandidate as reportCoreCandidate, writeJsonAtomic } from '@bughunter/core';
import type { Check, Journal, Session, SessionHandle, Signal } from '@bughunter/core';

import { loadCliConfig } from './config.ts';
import type { CliConfig } from './config.ts';
import { scanExecution } from './detectors.ts';
import { loadCliProfile, appDirectory } from './profile.ts';
import { cliCheckSignature } from './signature.ts';
import type { CliCommand, CliStep } from './types.ts';

export type CliActInput = {
  argv: string[];
  /** Команды подготовки перед основной: журнал хранит их вместе с шагом. */
  setup?: string[][];
};

export type CommandExecution = {
  argv: string[];
  /** `null` — процесс завершён сигналом или не запустился. */
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  spawnError?: string;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export type CliSessionHandle = Omit<SessionHandle, 'act' | 'steps'> & {
  executions: CommandExecution[];
  act(input: CliActInput): Promise<{ execution: CommandExecution; signals: Signal[] }>;
  steps(): CliStep[];
  drainSignals(): Signal[];
};

export type CliSessionView = {
  readonly config: CliConfig;
  readonly commands: readonly CliCommand[];
  readonly executions: readonly CommandExecution[];
  readonly databaseFile: string;
  readonly appDir: string;
};

export const maximumStreamBytes = 65_536;
export const defaultCommandTimeoutMs = 10_000;

type CliSessionState = {
  id: string;
  runId: string;
  target: string;
  persona: string;
  stateDir: string;
  config: CliConfig;
  commands: CliCommand[];
  appDir: string;
  databaseFile: string;
  journal: Journal;
  executions: CommandExecution[];
  pendingSignals: Signal[];
  signals: Map<string, Signal>;
  handle?: CliSessionHandle;
};

const sessions = new Map<string, CliSessionState>();

function stateOf(handle: SessionHandle): CliSessionState {
  const state = sessions.get(handle.id);
  if (state === undefined) throw new Error(`SESSION_NOT_FOUND: ${handle.id}`);
  return state;
}

export function sessionView(handle: SessionHandle): CliSessionView {
  const state = stateOf(handle);
  return {
    config: state.config,
    commands: state.commands,
    executions: state.executions,
    databaseFile: state.databaseFile,
    appDir: state.appDir,
  };
}

function journalPath(state: CliSessionState): string {
  return join(state.stateDir, 'runs', state.runId, 'journals', `${state.id}.json`);
}

function artifactFile(state: CliSessionState): string {
  return join(state.stateDir, 'runs', state.runId, 'artifacts', state.id, 'commands.jsonl');
}

function sandboxDirectory(state: Pick<CliSessionState, 'stateDir' | 'runId' | 'id'>): string {
  return join(state.stateDir, 'runs', state.runId, 'sandboxes', state.id);
}

export async function openCliSession(input: {
  runId: string;
  target: string;
  persona: string;
  stateDir: string;
}): Promise<CliSessionHandle> {
  const config = await loadCliConfig(input.stateDir);
  const profile = await loadCliProfile(input.stateDir, config.profile);
  const id = randomUUID();
  const appDir = appDirectory(config.appDir, input.stateDir);
  const sandbox = sandboxDirectory({ stateDir: input.stateDir, runId: input.runId, id });
  const databaseFile = safeJoin(sandbox, config.databaseFile, 'DATABASE_PATH_UNSAFE');
  const state: CliSessionState = {
    id,
    runId: input.runId,
    target: input.target,
    persona: input.persona,
    stateDir: input.stateDir,
    config,
    commands: profile.commands,
    appDir,
    databaseFile,
    journal: {
      sessionId: id,
      runId: input.runId,
      target: input.target,
      persona: input.persona,
      steps: [],
      createdAt: new Date().toISOString(),
    },
    executions: [],
    pendingSignals: [],
    signals: new Map(),
  };
  sessions.set(id, state);
  try {
    await mkdir(sandbox, { recursive: true });
    await mkdir(dirname(journalPath(state)), { recursive: true });
    // Журнал существует с первой секунды: кандидат без шагов всё равно обязан читаться с диска.
    await writeJsonAtomic(journalPath(state), state.journal);
  } catch (error) {
    sessions.delete(id);
    throw error;
  }
  const handle = handleFor(state);
  state.handle = handle;
  return handle;
}

export function sessionHandle(sessionId: string): CliSessionHandle {
  const handle = sessions.get(sessionId)?.handle;
  if (handle === undefined) throw new Error(`SESSION_NOT_FOUND: ${sessionId}`);
  return handle;
}

export async function closeCliSession(sessionId: string): Promise<void> {
  const handle = sessions.get(sessionId)?.handle;
  if (handle === undefined) return;
  await handle.close();
}

function handleFor(state: CliSessionState): CliSessionHandle {
  const handle: CliSessionHandle = {
    id: state.id,
    get executions() {
      return state.executions;
    },
    async snapshot() {
      return {
        target: state.target,
        persona: state.persona,
        appDir: state.appDir,
        databaseFile: state.databaseFile,
        commands: state.commands,
        scenarios: scenariosFor(state),
        stepsLeft: Math.max(0, state.config.limits.stepsPerSession - state.journal.steps.length),
        executions: [...state.executions],
        signals: state.pendingSignals.splice(0, state.pendingSignals.length),
      };
    },
    async act(payload: unknown) {
      return performCommand(handle, payload as CliActInput, state.config);
    },
    steps: () => [...state.journal.steps] as CliStep[],
    artifacts: () => (state.executions.length === 0
      ? []
      : [relative(state.stateDir, artifactFile(state)).split(sep).join('/')]),
    drainSignals: () => state.pendingSignals.splice(0, state.pendingSignals.length),
    close: async () => {
      await writeJsonAtomic(journalPath(state), state.journal);
      sessions.delete(state.id);
    },
  };
  return handle;
}

export const cliSession: Session = { open: openCliSession };

/**
 * Один запуск процесса — единственный способ действовать в CLI-пресете. Аргументы передаются
 * массивом без оболочки, база изолирована в песочнице сессии, поэтому команды не задевают
 * приложение и друг друга. `options.journal: false` — подготовка обхода или сброса.
 */
export async function performCommand(
  handle: CliSessionHandle,
  input: CliActInput,
  config: CliConfig,
  options: { journal?: boolean } = {},
): Promise<{ execution: CommandExecution; signals: Signal[] }> {
  const state = stateOf(handle);
  const journaled = options.journal !== false;
  if (journaled && state.journal.steps.length >= config.limits.stepsPerSession) throw new Error('LIMIT_REACHED');
  const argv = normalizeArgv(input.argv);
  const command = state.commands.find((entry) => entry.command === argv[0]);
  if (command === undefined) throw new Error(`COMMAND_NOT_FOUND: ${argv[0] ?? '<пусто>'}`);
  for (const setupArgv of input.setup ?? []) {
    await performCommand(handle, { argv: setupArgv }, config, { journal: false });
  }
  const setup = input.setup ?? [];
  assertSafety(config, command, argv, setup);
  const entry = safeJoin(state.appDir, config.appEntry, 'APP_ENTRY_UNSAFE');
  const execution = await execute(argv, entry, state.appDir, state.databaseFile, config.timeoutMs ?? defaultCommandTimeoutMs);
  const signals = scanExecution(execution, command.template, config);
  if (journaled) {
    state.executions.push(execution);
    state.pendingSignals.push(...signals);
    for (const signal of signals) state.signals.set(signal.id, signal);
    await appendStep(state, execution, command.template, signals, setup);
  }
  return { execution, signals };
}

function normalizeArgv(argv: unknown): string[] {
  if (!Array.isArray(argv) || argv.length === 0) throw new Error('TARGET_REQUIRED: argv');
  return argv.map((value) => {
    if (typeof value !== 'string') throw new Error(`TARGET_REQUIRED: аргумент не строка: ${String(value)}`);
    return value;
  });
}

function assertSafety(config: CliConfig, command: CliCommand, argv: string[], setup: string[][]): void {
  const { forbiddenActionText, readOnly } = config.safety;
  if (readOnly && command.mutates === true) {
    throw new Error(`FORBIDDEN_ACTION: ${command.command} при readOnly`);
  }
  const haystack = [command.command, ...argv, ...setup.flat()].join(' ');
  const forbidden = forbiddenActionText.find((token) => token.length > 0 && haystack.includes(token));
  if (forbidden !== undefined) throw new Error(`FORBIDDEN_ACTION: ${forbidden}`);
}

function safeJoin(root: string, path: string, code: string): string {
  const resolvedRoot = resolve(root);
  const target = isAbsolute(path) ? resolve(path) : resolve(resolvedRoot, path);
  const relativePath = relative(resolvedRoot, target);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`${code}: ${path}`);
  }
  return target;
}

function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      return;
    }
  }
}

async function execute(
  argv: string[],
  entry: string,
  cwd: string,
  databaseFile: string,
  timeoutMs: number,
): Promise<CommandExecution> {
  return new Promise((resolveExecution) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnError: string | undefined;
    const child = spawn(process.execPath, [entry, ...argv], {
      cwd,
      env: { ...process.env, DB_FILE: databaseFile },
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < maximumStreamBytes) stdout += chunk.slice(0, maximumStreamBytes - stdout.length);
    });
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < maximumStreamBytes) stderr += chunk.slice(0, maximumStreamBytes - stderr.length);
    });
    child.once('error', (error) => {
      spawnError = error.message;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolveExecution({
        argv,
        exitCode,
        signal,
        timedOut,
        ...(spawnError === undefined ? {} : { spawnError }),
        stdout,
        stderr,
        durationMs: Date.now() - started,
      });
    });
  });
}

export async function reportCliCandidate(
  handle: CliSessionHandle,
  input: { title: string; expected: string; actual: string; signalIds: string[]; check?: Check & { pointer?: string } },
): Promise<{ candidateId: string; duplicateOf?: string }> {
  const state = stateOf(handle);
  const referenced = input.signalIds.map((id) => {
    const signal = state.signals.get(id);
    if (signal === undefined) throw new Error(`SIGNAL_NOT_FOUND: ${id}`);
    return signal;
  });
  return reportCoreCandidate({
    runId: state.runId,
    sessionId: state.id,
    target: state.target,
    title: input.title,
    expected: input.expected,
    actual: input.actual,
    steps: [...state.journal.steps],
    signalIds: [...input.signalIds],
    ...(referenced.length > 0 ? { signalSignature: referenced[0]!.signature } : {}),
    ...(input.check === undefined ? {} : { checkSignature: cliCheckSignature(input.check, state.target) }),
    ...(input.check === undefined ? {} : { check: input.check }),
    stateDir: state.stateDir,
  });
}

/** Сценарии своей цели: контракт приложения, который модель читает вместо догадок. */
function scenariosFor(state: CliSessionState) {
  return state.config.scenarios.filter((scenario) => {
    const command = state.commands.find((entry) => entry.command === scenario.argv[0]);
    return command?.template === state.target;
  });
}

async function appendStep(
  state: CliSessionState,
  execution: CommandExecution,
  targetRef: string,
  signals: Signal[],
  setup: string[][] | undefined,
): Promise<void> {
  const step: CliStep = {
    id: randomUUID(),
    kind: 'command',
    timestamp: new Date().toISOString(),
    targetRef,
    ...(signals.length === 0 ? {} : { signalIds: signals.map((signal) => signal.id) }),
    responseHashes: [executionHash(execution)],
    argv: execution.argv,
    ...(setup === undefined || setup.length === 0 ? {} : { setup }),
    exitCode: execution.exitCode,
    signal: execution.signal,
    durationMs: execution.durationMs,
  };
  state.journal.steps.push(step);
  await writeJsonAtomic(journalPath(state), state.journal);
  const log = artifactFile(state);
  await mkdir(dirname(log), { recursive: true });
  await appendFile(log, `${JSON.stringify({ step: step.id, execution })}\n`, 'utf8');
}

/** Отпечаток запуска: им находки обхода ссылаются на конкретный исход приложения. */
export function executionHash(execution: CommandExecution): string {
  return createHash('sha256')
    .update(`${execution.exitCode}\n${execution.signal ?? ''}\n${execution.timedOut}\n${execution.stdout}\n${execution.stderr}`)
    .digest('hex');
}

/** Сброс базы сессии: удаление файла возвращает приложение в исходное состояние. */
export async function deleteSessionDatabase(handle: SessionHandle): Promise<void> {
  await rm(sessionView(handle).databaseFile, { force: true });
}
