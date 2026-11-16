import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/**
 * Запуск одного файла `node:test` и перевод его TAP-вывода в JSON-отчёт для core.
 * Node не поставляет JSON-репортёр, а `verifyRed` читает отчёт как JSON, поэтому перевод
 * живёт в пресете: общий раннер не меняется.
 */

type TapTest = {
  name: string;
  ok: boolean;
  failureType?: string;
  code?: string;
  error?: string;
  stack?: string;
};

type TapBlock = Record<string, string>;

function parseBlock(lines: string[], start: number): { block: TapBlock; next: number } {
  const block: TapBlock = {};
  let index = start;
  while (index < lines.length && lines[index]!.trim() !== '...') {
    const line = lines[index]!;
    const match = /^  ([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (match === null) {
      index += 1;
      continue;
    }
    const key = match[1]!;
    const value = match[2]!;
    if (value === '|-' || value === '|') {
      const parts: string[] = [];
      index += 1;
      while (index < lines.length) {
        const nested = lines[index]!;
        if (nested.startsWith('    ')) {
          parts.push(nested.slice(4));
          index += 1;
          continue;
        }
        break;
      }
      block[key] = parts.join('\n').trim();
      continue;
    }
    block[key] = value.replace(/^'(.*)'$/, '$1').replace(/^~$/, '');
    index += 1;
  }
  return { block, next: index + 1 };
}

function parseTap(stdout: string): { tests: TapTest[]; totals: Record<string, number>; diagnostic: string } {
  const lines = stdout.split('\n');
  const tests: TapTest[] = [];
  const totals: Record<string, number> = {};
  const diagnostics: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const total = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(line);
    if (total !== null) {
      totals[total[1]!] = Number(total[2]);
      continue;
    }
    // Ошибка загрузки модуля не попадает в YAML-блок теста: Node печатает её комментариями
    // перед `not ok`. Без этих строк диагностика `broken` теряла бы причину.
    if (line.startsWith('# ') && !line.startsWith('# Subtest:')) {
      diagnostics.push(line.slice(2));
      continue;
    }
    const result = /^(not ok|ok) \d+ - (.*)$/.exec(line);
    if (result === null) continue;
    const ok = result[1] === 'ok';
    const name = result[2]!;
    let block: TapBlock = {};
    if (lines[index + 1]?.trim() === '---') {
      const parsed = parseBlock(lines, index + 2);
      block = parsed.block;
      index = parsed.next - 1;
    }
    const test: TapTest = {
      name,
      ok,
      ...(block.failureType === undefined ? {} : { failureType: block.failureType }),
      ...(block.code === undefined ? {} : { code: block.code }),
      ...(block.error === undefined ? {} : { error: block.error }),
      ...(block.stack === undefined ? {} : { stack: block.stack }),
    };
    tests.push(test);
    if (!ok) diagnostics.push([test.name, test.error, test.stack].filter(Boolean).join('\n'));
  }
  return { tests, totals, diagnostic: diagnostics.join('\n') };
}

function maximum(bytes: number) {
  let value = '';
  return {
    push(chunk: string) {
      if (value.length < bytes) value += chunk.slice(0, bytes - value.length);
    },
    value: () => value,
  };
}

async function main(): Promise<void> {
  const [testFile, reportFile] = process.argv.slice(2);
  if (testFile === undefined || reportFile === undefined) {
    console.error('usage: test-report.ts <test-file> <report-file>');
    process.exitCode = 2;
    return;
  }
  const target = resolve(testFile);
  const stdout = maximum(1_048_576);
  const stderr = maximum(1_048_576);
  // Родитель может сам быть файлом `node --test`: унаследованный NODE_TEST_CONTEXT заставит
  // вложенный раннер пропустить файл и отчитаться без тестов.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['--test', '--test-reporter=tap', target], {
    cwd: process.cwd(),
    env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => stdout.push(chunk));
  child.stderr.on('data', (chunk: string) => stderr.push(chunk));
  const outcome = await new Promise<{ exitCode: number | null; signal: string | null; spawnError?: string }>((resolveOutcome) => {
    let spawnError: string | undefined;
    child.once('error', (error) => { spawnError = error.message; });
    child.once('close', (exitCode, signal) => resolveOutcome({
      exitCode,
      signal,
      ...(spawnError === undefined ? {} : { spawnError }),
    }));
  });

  const parsed = parseTap(stdout.value());
  const tests = parsed.totals.tests ?? parsed.tests.length;
  const passed = parsed.totals.pass ?? parsed.tests.filter((test) => test.ok).length;
  const failed = parsed.totals.fail ?? parsed.tests.filter((test) => !test.ok).length;
  const cancelled = parsed.totals.cancelled ?? 0;
  const diagnostic = [parsed.diagnostic, stderr.value()].filter(Boolean).join('\n').slice(0, 20_000);
  const report = {
    file: target,
    exitCode: outcome.exitCode,
    signal: outcome.signal,
    ...(outcome.spawnError === undefined ? {} : { spawnError: outcome.spawnError }),
    tests: parsed.tests,
    totals: { tests, passed, failed, cancelled, skipped: parsed.totals.skipped ?? 0, todo: parsed.totals.todo ?? 0 },
    diagnostic,
  };
  await mkdir(dirname(reportFile), { recursive: true });
  await writeFile(reportFile, `${JSON.stringify(report)}\n`, 'utf8');
  process.exitCode = outcome.exitCode ?? 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
