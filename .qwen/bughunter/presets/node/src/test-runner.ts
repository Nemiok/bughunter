import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { detectTests, shellArgument, verifyRed } from '@bughunter/core';
import type { PackageJson, TestFramework, TestRunSummary, TestRunner } from '@bughunter/core';

/** Вид теста, который заявляет вызывающий: `api` всегда означает Vitest. */
export const apiKind = 'api';

/** Словарь видов тестов пресета: из него собираются `testRunner.kinds` и схема `bh_verify_red`. */
export const nodeTestKinds = [apiKind, 'unit'] as const;

const vitestKind = 'vitest';
const jestKind = 'jest';
const vitestDependency = 'vitest';

const frameworks: TestFramework[] = [
  {
    name: vitestKind,
    dependency: vitestDependency,
    command: 'npm exec -- vitest run',
    configFiles: [
      'vitest.config.js', 'vitest.config.cjs', 'vitest.config.mjs',
      'vitest.config.ts', 'vitest.config.cts', 'vitest.config.mts',
      'vite.config.js', 'vite.config.cjs', 'vite.config.mjs',
      'vite.config.ts', 'vite.config.cts', 'vite.config.mts',
    ],
  },
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
];

const testFilePattern = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

type AssertionResult = {
  fullName?: string;
  title?: string;
  status?: string;
  failureMessages?: string[];
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

export function detectNodeTests(inputPath: string, options?: { unitCommand?: string | null }) {
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

/**
 * Отчёт Vitest и Jest — один формат (Jest-совместимый JSON). Вердикт red/green/broken выносит core
 * по этой сводке, поэтому здесь только честный пересчёт: один выбранный файл, падения — обычные
 * ассерты, чистый прогон — без пропущенных и оборванных тестов.
 */
function unitSummary(raw: unknown, testFile: string): TestRunSummary {
  const report = raw as TestReport | null;
  if (report === null || typeof report !== 'object') return summary({});
  const selected = (report.testResults ?? [])
    .filter((suite) => suite.name !== undefined && resolve(suite.name) === resolve(testFile));
  if (report.numTotalTestSuites !== 1 || report.testResults?.length !== 1 || selected.length !== 1) {
    return summary({});
  }
  const suite = selected[0]!;
  const assertions = suite.assertionResults ?? [];
  const diagnostic = [suite.message, ...assertions.flatMap((assertion) => assertion.failureMessages ?? [])]
    .filter(Boolean)
    .join('\n');
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
        && failed.every((assertion) => (assertion.failureMessages ?? [])
          .every((message) => /^\s*AssertionError:/m.test(message))),
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

function vitestProject(packageJson: unknown): boolean {
  const manifest = packageJson as PackageJson | null | undefined;
  return manifest?.dependencies?.[vitestDependency] !== undefined
    || manifest?.devDependencies?.[vitestDependency] !== undefined;
}

export const nodeTestRunner: TestRunner = {
  /** Значения, которые принимает вызывающий; `resolveKind` переводит их в конкретный раннер. */
  kinds: [...nodeTestKinds],
  async resolveKind({ testFile, requested, unitCommand }) {
    if (requested === apiKind) return vitestKind;
    const detected = await detectNodeTests(testFile, { unitCommand });
    return detected.framework;
  },
  async command(kind, { projectRoot, testFile, reportFile, unitCommand }) {
    const selection = runnerSelection(projectRoot, testFile);
    if (kind === vitestKind) {
      await stat(join(projectRoot, `node_modules/${vitestDependency}/package.json`));
      const args = [selection, '--reporter=json', `--outputFile=${reportFile}`].map((value) => shellArgument(value)).join(' ');
      return { command: `npx vitest run ${args}` };
    }
    const detected = await detectNodeTests(testFile, { unitCommand });
    if (detected.command === null) throw new Error('No supported Jest or Vitest command was detected');
    const reporterArguments = kind === jestKind
      ? ['--runTestsByPath', selection, '--runInBand', '--json', `--outputFile=${reportFile}`]
      : [selection, '--reporter=json', `--outputFile=${reportFile}`];
    return { command: [detected.command, ...reporterArguments.map((value) => shellArgument(value))].join(' ') };
  },
  parseReport: (_kind, raw, { testFile }) => unitSummary(JSON.parse(raw) as unknown, testFile),
  ownsProject: vitestProject,
};

/**
 * Раннер выбирает файлы сопоставлением с путём внутри проекта, поэтому абсолютный путь может не
 * совпасть: на macOS `/var` — симлинк на `/private/var`, и каталог состояния в tmpdir даёт фильтр,
 * которого в отчёте нет. Относительный путь от корня проекта совпадает всегда.
 */
function runnerSelection(projectRoot: string, testFile: string): string {
  const relativePath = relative(projectRoot, testFile);
  return relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath) ? testFile : relativePath;
}

/** Вердикт с уже подставленным раннером пресета. */
export async function verifyNodeRed(
  testFile: string,
  options?: { timeoutMs?: number; unitCommand?: string | null; kind?: string },
) {
  // Отчёт раннера содержит настоящий путь файла, а `verifyRed` сравнивает его со своим аргументом:
  // без realpath тот же симлинк `/var` ломает сравнение и вердикт становится `broken`.
  let target = testFile;
  try {
    target = await realpath(testFile);
  } catch {
    target = testFile;
  }
  return verifyRed(target, { runner: nodeTestRunner, ...options });
}
