import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { detectTests } from './detect.ts';

type Framework = 'jest' | 'vitest' | 'playwright';
type Verdict = { status: 'red' | 'green' | 'broken'; message: string };
type AssertionResult = {
  fullName?: string;
  title?: string;
  status?: string;
  failureMessages?: string[];
  failureDetails?: Array<{ matcherResult?: { pass?: boolean } }>;
};
type SuiteResult = {
  name?: string;
  status?: string;
  message?: string;
  assertionResults?: AssertionResult[];
};
type TestReport = {
  success?: boolean;
  numTotalTestSuites?: number;
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
  numPendingTests?: number;
  numTodoTests?: number;
  numRuntimeErrorTestSuites?: number;
  testResults?: SuiteResult[];
};
type PlaywrightResult = { status?: string; error?: { message?: string } };
type PlaywrightTest = { status?: string; results?: PlaywrightResult[] };
type PlaywrightSpec = { title: string; file?: string; tests?: PlaywrightTest[] };
type PlaywrightSuite = { file?: string; specs?: PlaywrightSpec[]; suites?: PlaywrightSuite[] };
type PlaywrightReport = {
  config?: { rootDir?: string };
  suites?: PlaywrightSuite[];
  errors?: Array<{ message?: string }>;
  stats?: { expected?: number; unexpected?: number; flaky?: number; skipped?: number };
};
type Execution = {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
  timedOut: boolean;
  stdout: string;
  stderr: string;
};

const defaultTimeoutMs = 120000;
const maximumMessageLength = 1500;

function verdict(status: Verdict['status'], diagnostic: string): Verdict {
  const normalized = diagnostic.replaceAll('\u0000', '').trim() || `${status}: no diagnostic was produced`;
  return {
    status,
    message: normalized.length <= maximumMessageLength
      ? normalized
      : `${normalized.slice(0, maximumMessageLength - 3)}...`,
  };
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

function shellArgument(value: string): string {
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

function ordinaryAssertionFailure(framework: Framework, assertion: AssertionResult): boolean {
  const messages = assertion.failureMessages ?? [];
  if (framework === 'vitest') {
    return messages.length > 0 && messages.every((message) => /^\s*AssertionError:/m.test(message));
  }
  const details = assertion.failureDetails ?? [];
  return details.length > 0 && details.every((detail) => detail.matcherResult?.pass === false);
}

function classifyReport(
  framework: Framework,
  testFile: string,
  report: TestReport | null,
  execution: Execution,
): Verdict {
  const processDiagnostic = [execution.stderr, execution.stdout].filter(Boolean).join('\n');
  if (execution.timedOut) return verdict('broken', `Test run timed out\n${processDiagnostic}`);
  if (execution.error) return verdict('broken', `Test runner failed: ${execution.error.message}\n${processDiagnostic}`);
  if (!report) {
    return verdict('broken', `No readable JSON test report (exit ${execution.code ?? execution.signal ?? 'unknown'})\n${processDiagnostic}`);
  }

  const selected = (report.testResults ?? []).filter((suite) => suite.name && resolve(suite.name) === resolve(testFile));
  if (report.numTotalTestSuites !== 1 || report.testResults?.length !== 1 || selected.length !== 1) {
    return verdict('broken', `The runner did not report exactly one selected test file\n${processDiagnostic}`);
  }
  const suite = selected[0]!;
  const assertions = suite.assertionResults ?? [];
  const diagnostic = [suite.message, ...assertions.flatMap((assertion) => assertion.failureMessages ?? []), processDiagnostic]
    .filter(Boolean).join('\n');
  if (report.numRuntimeErrorTestSuites || assertions.length === 0 || report.numTotalTests !== assertions.length) {
    return verdict('broken', diagnostic || 'No tests were discovered in the selected file');
  }

  const failed = assertions.filter((assertion) => assertion.status === 'failed');
  if (failed.length > 0) {
    if (report.numFailedTests === failed.length && failed.every((assertion) => ordinaryAssertionFailure(framework, assertion))) {
      const failedNames = failed.map((assertion) => assertion.fullName ?? assertion.title ?? 'failed assertion').join(', ');
      return verdict('red', `${failedNames}\n${diagnostic}`);
    }
    return verdict('broken', diagnostic);
  }

  if (
    execution.code === 0
    && execution.signal === null
    && report.success === true
    && suite.status === 'passed'
    && !suite.message
    && report.numPassedTests === assertions.length
    && report.numFailedTests === 0
    && assertions.every((assertion) => assertion.status === 'passed')
  ) {
    const passedNames = assertions.map((assertion) => assertion.fullName ?? assertion.title ?? 'test').join(', ');
    return verdict('green', `${passedNames}: all ${assertions.length} test(s) passed`);
  }
  return verdict('broken', diagnostic || 'The selected file did not complete with all tests passed');
}

function classifyPlaywrightReport(
  testFile: string,
  report: PlaywrightReport | null,
  execution: Execution,
): Verdict {
  const processDiagnostic = [execution.stderr, execution.stdout].filter(Boolean).join('\n');
  if (execution.timedOut) return verdict('broken', `Test run timed out\n${processDiagnostic}`);
  if (execution.error) return verdict('broken', `Test runner failed: ${execution.error.message}\n${processDiagnostic}`);
  if (!report) {
    return verdict('broken', `No readable JSON test report (exit ${execution.code ?? execution.signal ?? 'unknown'})\n${processDiagnostic}`);
  }

  const specs: PlaywrightSpec[] = [];
  const visit = (suite: PlaywrightSuite, inheritedFile?: string): void => {
    const file = suite.file ?? inheritedFile;
    for (const spec of suite.specs ?? []) specs.push({ ...spec, file });
    for (const child of suite.suites ?? []) visit(child, file);
  };
  for (const suite of report.suites ?? []) visit(suite);
  const rootDir = report.config?.rootDir;
  if (!rootDir || specs.length === 0 || specs.some((spec) => !spec.file || resolve(rootDir, spec.file) !== resolve(testFile))) {
    return verdict('broken', `The runner did not report exactly one selected test file\n${processDiagnostic}`);
  }
  const tests = specs.flatMap((spec) => (spec.tests ?? []).map((test) => ({ spec, test })));
  if (tests.length !== specs.length || tests.some(({ test }) => test.results?.length !== 1)) {
    return verdict('broken', `Every selected test must complete exactly once\n${processDiagnostic}`);
  }
  const globalDiagnostic = (report.errors ?? []).map((error) => error.message ?? '').filter(Boolean).join('\n');
  if (globalDiagnostic) return verdict('broken', `${globalDiagnostic}\n${processDiagnostic}`);

  const rows = tests.map(({ spec, test }) => ({ spec, test, result: test.results![0]! }));
  const diagnostic = [
    ...rows.map(({ result }) => result.error?.message ?? '').filter(Boolean),
    processDiagnostic,
  ].filter(Boolean).join('\n');
  const failed = rows.filter(({ result }) => result.status !== 'passed');
  if (failed.length > 0) {
    const ordinary = failed.every(({ result }) => {
      const message = (result.error?.message ?? '').replace(/\u001b\[[0-9;]*m/g, '');
      return message.startsWith('Error: expect(');
    });
    if (execution.code !== 0 && report.stats?.unexpected === failed.length && ordinary) {
      const names = failed.map(({ spec }) => spec.title).join(', ');
      return verdict('red', `${names}\n${diagnostic}`);
    }
    return verdict('broken', diagnostic);
  }

  if (
    execution.code === 0
    && execution.signal === null
    && report.stats?.expected === rows.length
    && report.stats.unexpected === 0
    && report.stats.flaky === 0
    && report.stats.skipped === 0
    && rows.every(({ test }) => test.status === 'expected')
  ) {
    const names = rows.map(({ spec }) => spec.title).join(', ');
    return verdict('green', `${names}: all ${rows.length} test(s) passed`);
  }
  return verdict('broken', diagnostic || 'The selected file did not complete with all tests passed');
}

export async function verifyRed(
  testFile: string,
  options?: { timeoutMs?: number; unitCommand?: string | null; kind?: 'e2e' | 'unit' },
): Promise<Verdict> {
  const target = resolve(testFile);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'bh-verify-red-'));
  const outputFile = join(temporaryDirectory, 'report.json');
  let report: TestReport | PlaywrightReport | null = null;
  let execution: Execution;
  let framework: Framework;

  try {
    const projectRoot = await nearestPackageRoot(target);
    if (!projectRoot) return verdict('broken', 'No project package.json was found for the selected test file');
    if (options?.kind === 'e2e') {
      framework = 'playwright';
      await stat(join(projectRoot, 'node_modules/@playwright/test/package.json'));
      const args = [target, '--reporter=json', '--workers=1'].map(shellArgument).join(' ');
      execution = await execute(
        `npm exec -- playwright test ${args}`,
        projectRoot,
        options?.timeoutMs ?? defaultTimeoutMs,
        { PLAYWRIGHT_JSON_OUTPUT_FILE: outputFile },
      );
    } else {
      const detected = await detectTests(target, { unitCommand: options?.unitCommand });
      if (!detected.framework || !detected.command) return verdict('broken', 'No supported Jest or Vitest command was detected');
      framework = detected.framework;
      const reporterArguments = framework === 'jest'
        ? ['--runTestsByPath', target, '--runInBand', '--json', `--outputFile=${outputFile}`]
        : [target, '--reporter=json', `--outputFile=${outputFile}`];
      const command = [detected.command, ...reporterArguments.map(shellArgument)].join(' ');
      execution = await execute(command, projectRoot, options?.timeoutMs ?? defaultTimeoutMs);
    }
  } catch (error) {
    return verdict('broken', error instanceof Error ? error.message : String(error));
  } finally {
    try {
      report = JSON.parse(await readFile(outputFile, 'utf8')) as TestReport | PlaywrightReport;
    } catch {
      report = null;
    }
    await rm(temporaryDirectory, { recursive: true, force: true });
  }

  return framework === 'playwright'
    ? classifyPlaywrightReport(target, report as PlaywrightReport | null, execution)
    : classifyReport(framework, target, report as TestReport | null, execution);
}
