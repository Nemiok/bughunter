import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { detectTests, shellArgument, verifyRed } from '@bughunter/core';
import type { PackageJson, TestFramework, TestRunSummary, TestRunner } from '@bughunter/core';

type AssertionResult = {
  fullName?: string;
  title?: string;
  status?: string;
  failureMessages?: string[];
  failureDetails?: Array<{ matcherResult?: { pass?: boolean } }>;
};
type SuiteResult = { name?: string; status?: string; message?: string; assertionResults?: AssertionResult[] };
type TestReport = {
  success?: boolean;
  numTotalTestSuites?: number;
  numTotalTests?: number;
  numPassedTests?: number;
  numFailedTests?: number;
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

/** Вид теста, который заявляет вызывающий: e2e всегда означает Playwright. */
export const e2eKind = 'e2e';

/** Словарь видов тестов пресета: из него собираются `testRunner.kinds` и схема `bh_verify_red`. */
export const webTestKinds = [e2eKind, 'unit'] as const;
const playwrightKind = 'playwright';
const jestKind = 'jest';
const vitestKind = 'vitest';
const playwrightDependency = '@playwright/test';

const frameworks: TestFramework[] = [
  {
    name: jestKind,
    dependency: jestKind,
    packageJsonKey: jestKind,
    command: 'npm exec -- jest',
    configFiles: [
      'jest.config.js', 'jest.config.cjs', 'jest.config.mjs',
      'jest.config.ts', 'jest.config.cts', 'jest.config.mts', 'jest.config.json',
    ],
  },
  {
    name: vitestKind,
    dependency: vitestKind,
    command: 'npm exec -- vitest run',
    configFiles: [
      'vitest.config.js', 'vitest.config.cjs', 'vitest.config.mjs',
      'vitest.config.ts', 'vitest.config.cts', 'vitest.config.mts',
      'vite.config.js', 'vite.config.cjs', 'vite.config.mjs',
      'vite.config.ts', 'vite.config.cts', 'vite.config.mts',
    ],
  },
];

const testFilePattern = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** ANSI-подсветка в сообщении Playwright мешает узнать провал ассерта по префиксу. */
const ansiEscape = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

export function detectWebTests(inputPath: string, options?: { unitCommand?: string | null }) {
  return detectTests(inputPath, { frameworks, testFilePattern, unitCommand: options?.unitCommand });
}

function summary(patch: Partial<TestRunSummary>): TestRunSummary {
  return {
    singleFile: false,
    tests: 0,
    passed: 0,
    failed: 0,
    runtimeErrors: false,
    assertionFailuresOnly: false,
    cleanPass: false,
    names: [],
    diagnostic: '',
    ...patch,
  };
}

function ordinaryAssertionFailure(kind: string, assertion: AssertionResult): boolean {
  const messages = assertion.failureMessages ?? [];
  if (kind === vitestKind) {
    return messages.length > 0 && messages.every((message) => /^\s*AssertionError:/m.test(message));
  }
  const details = assertion.failureDetails ?? [];
  return details.length > 0 && details.every((detail) => detail.matcherResult?.pass === false);
}

function unitSummary(kind: string, raw: unknown, testFile: string): TestRunSummary {
  const report = raw as TestReport | null;
  if (report === null || typeof report !== 'object') return summary({});
  const selected = (report.testResults ?? []).filter((suite) => suite.name !== undefined && resolve(suite.name) === resolve(testFile));
  if (report.numTotalTestSuites !== 1 || report.testResults?.length !== 1 || selected.length !== 1) return summary({});
  const suite = selected[0]!;
  const assertions = suite.assertionResults ?? [];
  const diagnostic = [suite.message, ...assertions.flatMap((assertion) => assertion.failureMessages ?? [])]
    .filter(Boolean).join('\n');
  if ((report.numRuntimeErrorTestSuites ?? 0) > 0 || assertions.length === 0 || report.numTotalTests !== assertions.length) {
    return summary({ singleFile: true, tests: assertions.length, runtimeErrors: true, diagnostic });
  }
  const failed = assertions.filter((assertion) => assertion.status === 'failed');
  if (failed.length > 0) {
    return summary({
      singleFile: true,
      tests: assertions.length,
      passed: assertions.length - failed.length,
      failed: failed.length,
      assertionFailuresOnly: report.numFailedTests === failed.length
        && failed.every((assertion) => ordinaryAssertionFailure(kind, assertion)),
      names: failed.map((assertion) => assertion.fullName ?? assertion.title ?? 'failed assertion'),
      diagnostic,
    });
  }
  return summary({
    singleFile: true,
    tests: assertions.length,
    passed: assertions.filter((assertion) => assertion.status === 'passed').length,
    assertionFailuresOnly: true,
    cleanPass: report.success === true
      && suite.status === 'passed'
      && !suite.message
      && report.numPassedTests === assertions.length
      && report.numFailedTests === 0
      && assertions.every((assertion) => assertion.status === 'passed'),
    names: assertions.map((assertion) => assertion.fullName ?? assertion.title ?? 'test'),
    diagnostic,
  });
}

function playwrightSummary(raw: unknown, testFile: string, exitCode: number | null): TestRunSummary {
  const report = raw as PlaywrightReport | null;
  if (report === null || typeof report !== 'object') return summary({});
  const specs: PlaywrightSpec[] = [];
  const visit = (suite: PlaywrightSuite, inheritedFile?: string): void => {
    const file = suite.file ?? inheritedFile;
    for (const spec of suite.specs ?? []) specs.push({ ...spec, file });
    for (const child of suite.suites ?? []) visit(child, file);
  };
  for (const suite of report.suites ?? []) visit(suite);
  const rootDir = report.config?.rootDir;
  if (rootDir === undefined || specs.length === 0
    || specs.some((spec) => spec.file === undefined || resolve(rootDir, spec.file) !== resolve(testFile))) {
    return summary({});
  }
  const tests = specs.flatMap((spec) => (spec.tests ?? []).map((test) => ({ spec, test })));
  if (tests.length !== specs.length || tests.some(({ test }) => test.results?.length !== 1)) {
    return summary({ diagnostic: 'Every selected test must complete exactly once' });
  }
  const rows = tests.map(({ spec, test }) => ({ spec, test, result: test.results![0]! }));
  const globalDiagnostic = (report.errors ?? []).map((error) => error.message ?? '').filter(Boolean).join('\n');
  const diagnostic = [
    globalDiagnostic,
    ...rows.map(({ result }) => result.error?.message ?? '').filter(Boolean),
  ].filter(Boolean).join('\n');
  if (globalDiagnostic !== '') {
    return summary({ singleFile: true, tests: rows.length, runtimeErrors: true, diagnostic });
  }
  const failed = rows.filter(({ result }) => result.status !== 'passed');
  if (failed.length > 0) {
    const ordinary = failed.every(({ result }) => {
      const message = (result.error?.message ?? '').replace(ansiEscape, '');
      return message.startsWith('Error: expect(');
    });
    return summary({
      singleFile: true,
      tests: rows.length,
      passed: rows.length - failed.length,
      failed: failed.length,
      assertionFailuresOnly: ordinary && report.stats?.unexpected === failed.length && exitCode !== 0,
      names: failed.map(({ spec }) => spec.title),
      diagnostic,
    });
  }
  return summary({
    singleFile: true,
    tests: rows.length,
    passed: rows.filter(({ test }) => test.status === 'expected').length,
    assertionFailuresOnly: true,
    cleanPass: report.stats?.expected === rows.length
      && report.stats.unexpected === 0
      && report.stats.flaky === 0
      && report.stats.skipped === 0
      && rows.every(({ test }) => test.status === 'expected'),
    names: rows.map(({ spec }) => spec.title),
    diagnostic,
  });
}

export function playwrightProject(packageJson: unknown): boolean {
  const manifest = packageJson as PackageJson | null | undefined;
  return manifest?.dependencies?.[playwrightDependency] !== undefined
    || manifest?.devDependencies?.[playwrightDependency] !== undefined;
}

export const webTestRunner: TestRunner = {
  /** Значения, которые принимает вызывающий; `resolveKind` переводит их в конкретный раннер. */
  kinds: [...webTestKinds],
  async resolveKind({ testFile, requested, unitCommand }) {
    if (requested === e2eKind) return playwrightKind;
    const detected = await detectWebTests(testFile, { unitCommand });
    return detected.framework;
  },
  async command(kind, { projectRoot, testFile, reportFile, unitCommand }) {
    if (kind === playwrightKind) {
      await stat(join(projectRoot, `node_modules/${playwrightDependency}/package.json`));
      const args = [testFile, '--reporter=json', '--workers=1'].map((value) => shellArgument(value)).join(' ');
      return { command: `npm exec -- playwright test ${args}`, env: { PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile } };
    }
    const detected = await detectWebTests(testFile, { unitCommand });
    if (detected.command === null) throw new Error('No supported Jest or Vitest command was detected');
    const reporterArguments = kind === jestKind
      ? ['--runTestsByPath', testFile, '--runInBand', '--json', `--outputFile=${reportFile}`]
      : [testFile, '--reporter=json', `--outputFile=${reportFile}`];
    return { command: [detected.command, ...reporterArguments.map((value) => shellArgument(value))].join(' ') };
  },
  parseReport(kind, raw, { testFile, exitCode }) {
    const report = JSON.parse(raw) as unknown;
    return kind === playwrightKind ? playwrightSummary(report, testFile, exitCode) : unitSummary(kind, report, testFile);
  },
  ownsProject: playwrightProject,
};

/** Вердикт с уже подставленным раннером пресета: сигнатура совпадает с прежней. */
export function verifyWebRed(testFile: string, options?: { timeoutMs?: number; unitCommand?: string | null; kind?: string }) {
  return verifyRed(testFile, { runner: webTestRunner, ...options });
}
