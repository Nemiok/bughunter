import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

function invalid(message) {
  return new Error(`RED_REPORT_INVALID: ${message}`);
}

async function readReport(reportPath) {
  let raw;
  try {
    raw = await readFile(reportPath);
  } catch {
    throw invalid('report is missing');
  }
  let report;
  try {
    report = JSON.parse(raw.toString('utf8'));
  } catch {
    throw invalid('report is not valid JSON');
  }
  if (report === null || typeof report !== 'object' || Array.isArray(report)) throw invalid('report must be an object');
  return { report, reportSha256: createHash('sha256').update(raw).digest('hex') };
}

function countPlaywright(report, cwd, testPath) {
  if (!Array.isArray(report.suites)) throw invalid('suites is missing');
  if (Array.isArray(report.errors) && report.errors.length > 0) throw invalid('top-level errors');
  const selected = resolve(cwd, testPath);
  let failedAssertions = 0;
  const visit = (suite) => {
    if (suite === null || typeof suite !== 'object') return;
    const suiteFile = typeof suite.file === 'string' ? suite.file : undefined;
    for (const spec of Array.isArray(suite.specs) ? suite.specs : []) {
      const specFile = typeof spec?.file === 'string' ? spec.file : suiteFile;
      for (const testCase of Array.isArray(spec?.tests) ? spec.tests : []) {
        for (const result of Array.isArray(testCase?.results) ? testCase.results : []) {
          if (result?.status !== 'failed') continue;
          if (specFile === undefined) throw invalid('failed result has no test file');
          if (resolve(cwd, specFile) !== selected) throw invalid('failure outside candidate test');
          failedAssertions += 1;
        }
      }
    }
    for (const child of Array.isArray(suite.suites) ? suite.suites : []) visit(child);
  };
  for (const suite of Array.isArray(report.suites) ? report.suites : []) visit(suite);
  return failedAssertions;
}

function countVitest(report, cwd, testPath) {
  if (!Array.isArray(report.testResults)) throw invalid('testResults is missing');
  const selected = resolve(cwd, testPath);
  let failedAssertions = 0;
  let totalFailures = 0;
  let foreignFailure = false;
  for (const file of report.testResults) {
    if (typeof file?.name !== 'string') throw invalid('test result has no file name');
    const filePath = resolve(cwd, file.name);
    for (const assertion of Array.isArray(file.assertionResults) ? file.assertionResults : []) {
      if (assertion?.status !== 'failed') continue;
      totalFailures += 1;
      if (filePath !== selected) foreignFailure = true;
      else failedAssertions += 1;
    }
  }
  if (foreignFailure) throw invalid('failure outside candidate test');
  if (typeof report.numFailedTests === 'number' && report.numFailedTests !== totalFailures) {
    throw invalid('numFailedTests does not match assertion results');
  }
  return failedAssertions;
}

export async function runIndependentRed({
  runner, cwd, testPath, reportPath, spawn = spawnSync,
}) {
  if (!['playwright', 'vitest'].includes(runner)) throw new Error(`RED_RUNNER_INVALID: ${runner}`);
  if (typeof cwd !== 'string' || typeof testPath !== 'string' || typeof reportPath !== 'string') {
    throw new Error('RED_INPUT_INVALID');
  }
  const command = 'npx';
  const args = runner === 'playwright'
    ? ['playwright', 'test', testPath, '--workers=1', '--reporter=json']
    : ['vitest', 'run', testPath, '--reporter=json', `--outputFile=${reportPath}`];
  const options = {
    cwd,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      ...(runner === 'playwright' ? { PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath } : {}),
    },
  };
  try {
    await rm(reportPath, { force: true });
  } catch {
    throw invalid('cannot reset report');
  }
  let processResult;
  try {
    processResult = spawn(command, args, options);
  } catch (error) {
    throw invalid(`spawn failed: ${error.message ?? error}`);
  }
  if (processResult?.error) throw invalid(`spawn failed: ${processResult.error.message ?? processResult.error}`);
  if (!Number.isInteger(processResult?.status) || processResult.status === 0) {
    throw new Error(`RED_EXPECTED: exit ${processResult?.status}`);
  }
  const { report, reportSha256 } = await readReport(reportPath);
  const failedAssertions = runner === 'playwright'
    ? countPlaywright(report, cwd, testPath)
    : countVitest(report, cwd, testPath);
  if (failedAssertions < 1) throw new Error('RED_ASSERTIONS_REQUIRED');
  return { command, args, exitCode: processResult.status, failedAssertions, reportSha256 };
}
