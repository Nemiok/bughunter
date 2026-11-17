import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';

import type { TestRunSummary, TestRunner } from './preset.ts';

export type { TestRunSummary };

export type Verdict = { status: 'red' | 'green' | 'broken'; message: string };

export type Execution = {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
  timedOut: boolean;
  stdout: string;
  stderr: string;
};

const defaultTimeoutMs = 120_000;
const maximumMessageLength = 1500;
const nulCharacter = String.fromCharCode(0);

function verdict(status: Verdict['status'], diagnostic: string): Verdict {
  const normalized = diagnostic.replaceAll(nulCharacter, '').trim() || `${status}: no diagnostic was produced`;
  return {
    status,
    message: normalized.length <= maximumMessageLength
      ? normalized
      : `${normalized.slice(0, maximumMessageLength - 3)}...`,
  };
}

/** Экранирование одного аргумента командной оболочки: пресеты собирают из него команду запуска. */
export function shellArgument(value: string): string {
  if (process.platform === 'win32') return `"${value.replaceAll('"', '\\"')}"`;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
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

async function nearestPackageRoot(testFile: string): Promise<string | null> {
  let directory = dirname(resolve(testFile));
  const filesystemRoot = parse(directory).root;
  while (true) {
    try {
      if ((await stat(join(directory, 'package.json'))).isFile()) return directory;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    if (directory === filesystemRoot) return null;
    directory = dirname(directory);
  }
}

async function execute(command: string, cwd: string, timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<Execution> {
  return new Promise((resolveExecution) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnError: Error | undefined;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { spawnError = error; });
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolveExecution({ code, signal, ...(spawnError ? { error: spawnError } : {}), timedOut, stdout, stderr });
    });
  });
}

/**
 * Вердикт определяется только нейтральной сводкой и исходом процесса: core не знает,
 * какой раннер запущен и в каком формате он отчитался.
 */
export function classifyVerdict(summary: TestRunSummary | null, execution: Execution): Verdict {
  const processDiagnostic = [execution.stderr, execution.stdout].filter(Boolean).join('\n');
  if (execution.timedOut) return verdict('broken', `Test run timed out\n${processDiagnostic}`);
  if (execution.error) return verdict('broken', `Test runner failed: ${execution.error.message}\n${processDiagnostic}`);
  if (summary === null) {
    return verdict('broken', `No readable test report (exit ${execution.code ?? execution.signal ?? 'unknown'})\n${processDiagnostic}`);
  }
  const diagnostic = [summary.diagnostic, processDiagnostic].filter(Boolean).join('\n');
  if (!summary.singleFile) {
    return verdict('broken', `The runner did not report exactly one selected test file\n${diagnostic}`);
  }
  if (summary.runtimeErrors || summary.tests === 0) {
    return verdict('broken', diagnostic || 'No tests were discovered in the selected file');
  }
  if (summary.failed > 0) {
    if (summary.assertionFailuresOnly) return verdict('red', `${summary.names.join(', ')}\n${diagnostic}`);
    return verdict('broken', diagnostic);
  }
  if (execution.code === 0 && execution.signal === null && summary.cleanPass && summary.passed === summary.tests) {
    return verdict('green', `${summary.names.join(', ')}: all ${summary.tests} test(s) passed`);
  }
  return verdict('broken', diagnostic || 'The selected file did not complete with all tests passed');
}

export async function verifyRed(
  testFile: string,
  options: { runner: TestRunner; timeoutMs?: number; unitCommand?: string | null; kind?: string },
): Promise<Verdict> {
  const target = resolve(testFile);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'bh-verify-red-'));
  const outputFile = join(temporaryDirectory, 'report.json');
  try {
    const projectRoot = await nearestPackageRoot(target);
    if (projectRoot === null) return verdict('broken', 'No project package.json was found for the selected test file');
    const selection = { projectRoot, testFile: target, ...(options.unitCommand === undefined ? {} : { unitCommand: options.unitCommand }) };
    const kind = await options.runner.resolveKind({ ...selection, ...(options.kind === undefined ? {} : { requested: options.kind }) });
    if (kind === null) return verdict('broken', 'No supported test runner was detected');
    const launched = await options.runner.command(kind, { ...selection, reportFile: outputFile });
    const execution = await execute(launched.command, projectRoot, options.timeoutMs ?? defaultTimeoutMs, launched.env);
    let summary: TestRunSummary | null = null;
    try {
      const raw = await readFile(outputFile, 'utf8');
      summary = options.runner.parseReport(kind, raw, { testFile: target, exitCode: execution.code });
    } catch {
      summary = null;
    }
    return classifyVerdict(summary, execution);
  } catch (error) {
    return verdict('broken', error instanceof Error ? error.message : String(error));
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
