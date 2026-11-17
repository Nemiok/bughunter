import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

import { nearestPackage, neighboringTests, shellArgument, verifyRed } from '@bughunter/core';
import type { TestRunSummary, TestRunner } from '@bughunter/core';

/** Вид теста, который заявляет вызывающий: `cli` — тест поведения командной строки. */
export const cliKind = 'cli';

/** Словарь видов тестов пресета: из него собираются `testRunner.kinds` и схема `bh_verify_red`. */
export const cliTestKinds = [cliKind, 'node-test'] as const;

const nodeTestKind = 'node-test';

/** Отчёт самописного репортёра: TAP переводится в JSON, потому что `verifyRed` читает JSON. */
type CliTestReport = {
  file?: unknown;
  exitCode?: unknown;
  signal?: unknown;
  spawnError?: unknown;
  tests?: Array<{
    name?: unknown;
    ok?: unknown;
    failureType?: unknown;
    code?: unknown;
    error?: unknown;
    stack?: unknown;
  }>;
  totals?: {
    tests?: unknown;
    passed?: unknown;
    failed?: unknown;
    cancelled?: unknown;
    skipped?: unknown;
    todo?: unknown;
  };
  diagnostic?: unknown;
};

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

function number(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * Сводка по JSON-отчёту репортёра. Ассерты отличаются от аварии раннера по `code` TAP:
 * `ERR_ASSERTION` — обычное падение теста, `ERR_TEST_FAILURE` — загрузка модуля, таймаут
 * или другой сбой вне утверждений.
 */
export function parseCliReport(raw: unknown, testFile: string): TestRunSummary {
  if (raw === null || typeof raw !== 'object') return summary({});
  const report = raw as CliTestReport;
  const totals = report.totals ?? {};
  const tests = Array.isArray(report.tests) ? report.tests : [];
  const singleFile = typeof report.file === 'string' && resolve(report.file) === resolve(testFile);
  const diagnostics = typeof report.diagnostic === 'string' ? report.diagnostic : '';
  const failures = tests.filter((test) => test.ok !== true);
  const failed = totals.failed === undefined ? failures.length : number(totals.failed);
  const totalTests = totals.tests === undefined ? tests.length : number(totals.tests);
  const passed = totals.passed === undefined ? totalTests - failed : number(totals.passed);
  const skipped = number(totals.skipped);
  const cancelled = number(totals.cancelled);
  const todo = number(totals.todo);
  const exitCode = typeof report.exitCode === 'number' ? report.exitCode : null;
  const infrastructure = report.spawnError !== undefined
    || (report.signal !== undefined && report.signal !== null)
    || (exitCode !== null && exitCode !== 0 && failed === 0);
  const assertionFailuresOnly = failed > 0
    && failures.length === failed
    && failures.every((test) => test.code === 'ERR_ASSERTION');
  const runtimeErrors = totalTests === 0
    || infrastructure
    || (failed > 0 && !assertionFailuresOnly)
    || tests.some((test) => test.code === 'ERR_TEST_FAILURE');
  return summary({
    singleFile,
    tests: totalTests,
    passed,
    failed,
    runtimeErrors,
    assertionFailuresOnly,
    cleanPass: exitCode === 0
      && failed === 0
      && !runtimeErrors
      && totalTests > 0
      && skipped === 0
      && cancelled === 0
      && todo === 0,
    names: tests.map((test) => typeof test.name === 'string' ? test.name : 'test'),
    diagnostic: diagnostics,
  });
}

const testFilePattern = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/**
 * Обнаружение раннера: у мини-фикстуры нет тестовой зависимости, поэтому признак проекта —
 * маркер `bughunter.target === "cli"`, а не пакет в зависимостях. Соседние примеры нужны
 * генератору как образец стиля.
 */
export async function detectCliTests(
  inputPath: string,
  options?: { unitCommand?: string | null },
): Promise<{ framework: string | null; command: string | null; examples: string[] }> {
  const project = await nearestPackage(inputPath);
  if (project === null) return { framework: null, command: options?.unitCommand ?? null, examples: [] };
  const marker = project.packageJson.bughunter;
  const isCli = marker !== null && typeof marker === 'object'
    && (marker as { target?: unknown }).target === 'cli';
  if (!isCli) return { framework: null, command: options?.unitCommand ?? null, examples: [] };
  return {
    framework: nodeTestKind,
    command: options?.unitCommand ?? `${process.execPath} --test`,
    examples: await neighboringTests(project.root, inputPath, testFilePattern),
  };
}

/**
 * Раннер запускает файл как `node:test` и переводит TAP в JSON отдельным процессом.
 * Скрипт-переводчик лежит рядом с точкой входа пресета, поэтому путь абсолютный: тест
 * исполняется с `cwd` проекта приложения.
 */
export const cliTestRunner: TestRunner = {
  kinds: [...cliTestKinds],
  async resolveKind({ requested }) {
    if (requested === undefined || requested === cliKind || requested === nodeTestKind) return nodeTestKind;
    return null;
  },
  async command(_kind, { testFile, reportFile }) {
    const reporter = resolve(import.meta.dirname, 'test-report.ts');
    return {
      command: [process.execPath, reporter, testFile, reportFile].map(shellArgument).join(' '),
    };
  },
  parseReport(_kind, raw, { testFile }) {
    return parseCliReport(JSON.parse(raw) as unknown, testFile);
  },
  ownsProject(packageJson) {
    if (packageJson === null || typeof packageJson !== 'object') return false;
    const marker = (packageJson as { bughunter?: unknown }).bughunter;
    return marker !== null && typeof marker === 'object'
      && (marker as { target?: unknown }).target === 'cli';
  },
};

/**
 * Вердикт с уже подставленным раннером пресета. `realpath` снимает расхождение `/var` →
 * `/private/var` на macOS: отчёт и аргумент `verifyRed` должны указывать на один файл.
 */
export async function verifyCliRed(
  testFile: string,
  options?: { timeoutMs?: number; unitCommand?: string | null; kind?: string },
) {
  let target = testFile;
  try {
    target = await realpath(testFile);
  } catch {
    target = testFile;
  }
  return verifyRed(target, { runner: cliTestRunner, ...options });
}
