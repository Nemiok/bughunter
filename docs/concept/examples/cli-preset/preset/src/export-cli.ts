import { exportTest as exportCoreTest } from '@bughunter/core';
import type { Candidate, ExportTarget, TestGenerator } from '@bughunter/core';

import { loadCliConfig } from './config.ts';
import type { CliConfig } from './config.ts';
import type { CliCheck } from './checks.ts';
import { appDirectory } from './profile.ts';
import { cliKind, cliTestRunner } from './test-runner.ts';
import type { CliScenario, CliStep } from './types.ts';

export { cliKind };

export const cliExportTarget: ExportTarget = {
  kind: cliKind,
  dir: (config) => config.tests.generated.dir,
  fileName: (bugId) => `${bugId}.test.ts`,
};

export const cliTestGenerator: TestGenerator = {
  async generate({ candidate, stateDir }) {
    return generateCliTest(candidate, await loadCliConfig(stateDir), stateDir);
  },
};

/**
 * `exportTest` ищет проект от `process.cwd()`, а сервер запущен из корня копии, где нет
 * `package.json`. Временный `chdir` в каталог приложения — обход без правки core; каталог
 * восстанавливается в `finally`, поэтому ошибка экспорта не оставляет сервер в чужом cwd.
 */
export async function exportCliTest(input: { runId: string; bugId: string; stateDir: string }) {
  const config = await loadCliConfig(input.stateDir);
  const appDir = appDirectory(config.appDir, input.stateDir);
  const previous = process.cwd();
  process.chdir(appDir);
  try {
    return await exportCoreTest({
      ...input,
      config,
      generate: cliTestGenerator,
      target: cliExportTarget,
      runner: cliTestRunner,
    });
  } finally {
    process.chdir(previous);
  }
}

function oneLine(value: string): string {
  return value.replaceAll('\n', ' ').trim();
}

function countHelper(): string {
  return `function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const found = haystack.indexOf(needle, offset);
    if (found < 0) return count;
    count += 1;
    offset = found + needle.length;
  }
}`;
}

/**
 * Регрессионный тест на подтверждённый баг: последовательность запусков из журнала и утверждения
 * из оракула либо из объявленного сценария. База создаётся во временном каталоге, поэтому тест
 * не зависит от данных приложения и не оставляет следов.
 */
export function generateCliTest(candidate: Candidate, config: CliConfig, stateDir: string): string {
  const steps = (candidate.minimalSteps ?? candidate.steps) as CliStep[];
  if (steps.length === 0) throw new Error(`TEST_GENERATION_UNSUPPORTED: ${candidate.id}: в кандидате нет шагов`);
  const check = candidate.check as CliCheck | undefined;
  const assertions = check === undefined
    ? assertionsFromScenario(candidate, steps, config)
    : assertionsFromCheck(check);
  if (assertions.length === 0) {
    throw new Error(`TEST_GENERATION_UNSUPPORTED: ${candidate.id}: нет ни оракула, ни объявленного сценария`);
  }
  const appDir = appDirectory(config.appDir, stateDir);
  return [
    '// Сгенерировано Bughunter: регрессионный тест на подтверждённый баг.',
    `// Ожидалось: ${oneLine(candidate.expected)}`,
    `// Фактически: ${oneLine(candidate.actual)}`,
    "import { spawnSync } from 'node:child_process';",
    "import { mkdtempSync, rmSync } from 'node:fs';",
    "import { tmpdir } from 'node:os';",
    "import { join } from 'node:path';",
    "import assert from 'node:assert/strict';",
    "import { test } from 'node:test';",
    '',
    `const appDir = ${JSON.stringify(appDir)};`,
    `const appEntry = ${JSON.stringify(appDir + '/' + config.appEntry)};`,
    '',
    runHelper(),
    '',
    countHelper(),
    '',
    `test(${JSON.stringify(candidate.title)}, { timeout: 60_000 }, () => {`,
    `  const directory = mkdtempSync(join(tmpdir(), 'bh-cli-'));`,
    `  const env = { ...process.env, DB_FILE: join(directory, ${JSON.stringify(config.databaseFile)}) };`,
    '  try {',
    ...runLines(steps),
    `    const last = result${steps.length - 1};`,
    ...assertions.map((assertion) => `    ${assertion}`),
    '  } finally {',
    '    rmSync(directory, { recursive: true, force: true });',
    '  }',
    '});',
    '',
  ].join('\n');
}

function runHelper(): string {
  return `function run(env: NodeJS.ProcessEnv, argv: string[], setup: string[][] = []): {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
} {
  for (const args of setup) {
    const prepared = spawnSync(process.execPath, [appEntry, ...args], { cwd: appDir, env, encoding: 'utf8' });
    if (prepared.error !== undefined) throw prepared.error;
  }
  const result = spawnSync(process.execPath, [appEntry, ...argv], { cwd: appDir, env, encoding: 'utf8' });
  if (result.error !== undefined) throw result.error;
  return {
    exitCode: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}`;
}

function runLines(steps: CliStep[]): string[] {
  return steps.flatMap((step, index) => {
    if (step.argv === undefined || step.argv.length === 0) {
      throw new Error(`TEST_GENERATION_UNSUPPORTED: шаг ${step.id} без argv`);
    }
    const setup = step.setup === undefined || step.setup.length === 0
      ? ''
      : `, ${JSON.stringify(step.setup)}`;
    return [`    const result${index} = run(env, ${JSON.stringify(step.argv)}${setup});`];
  });
}

function assertionsFromCheck(check: CliCheck): string[] {
  switch (check.kind) {
    case 'exitCode':
      return [`assert.equal(last.exitCode, ${Number(check.expected)}, 'код выхода');`];
    case 'stdoutContains':
      return [`assert.ok(last.stdout.includes(${JSON.stringify(String(check.expected))}), 'stdout содержит ожидаемый текст');`];
    case 'stdoutNotContains':
      return [`assert.ok(!last.stdout.includes(${JSON.stringify(String(check.expected))}), 'stdout не содержит запрещённый текст');`];
    case 'stderrContains':
      return [`assert.ok(last.stderr.includes(${JSON.stringify(String(check.expected))}), 'stderr содержит ожидаемый текст');`];
    case 'stderrNotContains':
      return [`assert.ok(!last.stderr.includes(${JSON.stringify(String(check.expected))}), 'stderr не содержит запрещённый текст');`];
    case 'stdoutOccurrences':
      return [`assert.equal(countOccurrences(last.stdout, ${JSON.stringify(check.pointer ?? '')}), ${Number(check.expected)}, 'число вхождений в stdout');`];
  }
}

/**
 * Без оракула утверждения берутся из сценария той же команды с тем же последним argv.
 * Если сценария нет, тест не генерируется: утверждение наблюдаемого бага прошло бы на баге.
 */
function assertionsFromScenario(candidate: Candidate, steps: CliStep[], config: CliConfig): string[] {
  const lastArgv = steps.at(-1)?.argv;
  if (lastArgv === undefined) return [];
  const scenario = config.scenarios.find((entry: CliScenario) =>
    entry.target === candidate.target
    && entry.argv.length === lastArgv.length
    && entry.argv.every((value, index) => value === lastArgv[index]));
  if (scenario === undefined) return [];
  const expected = scenario.expect;
  return [
    `assert.equal(last.exitCode, ${expected.exitCode}, 'код выхода по сценарию');`,
    ...(expected.stdoutContains ?? []).map((text) =>
      `assert.ok(last.stdout.includes(${JSON.stringify(text)}), 'stdout содержит текст сценария');`),
    ...(expected.stdoutNotContains ?? []).map((text) =>
      `assert.ok(!last.stdout.includes(${JSON.stringify(text)}), 'stdout не содержит запрещённый текст сценария');`),
    ...(expected.stderrContains ?? []).map((text) =>
      `assert.ok(last.stderr.includes(${JSON.stringify(text)}), 'stderr содержит текст сценария');`),
    ...(expected.stderrNotContains ?? []).map((text) =>
      `assert.ok(!last.stderr.includes(${JSON.stringify(text)}), 'stderr не содержит запрещённый текст сценария');`),
  ];
}
