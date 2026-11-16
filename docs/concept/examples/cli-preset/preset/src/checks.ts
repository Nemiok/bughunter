import type { Check, Checks, SessionHandle } from '@bughunter/core';

import { sessionView } from './session.ts';

/** Словарь оракулов CLI-пресета: код выхода и наличие подстрок в потоках. */
export const cliCheckKinds = [
  'exitCode',
  'stdoutContains',
  'stdoutNotContains',
  'stderrContains',
  'stderrNotContains',
  'stdoutOccurrences',
] as const;

export type CliCheckKind = (typeof cliCheckKinds)[number];

/**
 * `pointer` — игла для `stdoutOccurrences`. Core не включает его в сигнатуру, поэтому два
 * оракула с разными иглами схлопнулись бы в один кандидат; точка входа считает сигнатуру сама.
 */
export type CliCheck = Check & { kind: CliCheckKind; pointer?: string };

/** Цель оракула — шаблон команды из инвентаря, например «add <name> <qty>». */
const commandTemplate = /^[A-Za-z][A-Za-z0-9_-]*(?: \S.*)?$/;

export function validateCliCheck(check: Check): void {
  const oracle = check as CliCheck;
  if (!(cliCheckKinds as readonly string[]).includes(oracle.kind)) {
    throw new Error(`CHECK_INVALID: неизвестный вид check: ${oracle.kind}; словарь пресета: ${cliCheckKinds.join(', ')}`);
  }
  if (typeof oracle.target !== 'string' || commandTemplate.exec(oracle.target.trim()) === null) {
    throw new Error(`CHECK_INVALID: ${oracle.kind}.target — шаблон команды, например «add <name> <qty>», получено: ${String(oracle.target)}`);
  }
  if (oracle.expected === undefined) throw new Error(`CHECK_INVALID: ${oracle.kind}.expected обязателен`);
  if (oracle.kind === 'exitCode') {
    if (typeof oracle.expected !== 'number' || !Number.isInteger(oracle.expected)) {
      throw new Error(`CHECK_INVALID: exitCode.expected — целое число`);
    }
    return;
  }
  if (oracle.kind === 'stdoutOccurrences') {
    if (typeof oracle.pointer !== 'string' || oracle.pointer.length === 0) {
      throw new Error('CHECK_INVALID: stdoutOccurrences.pointer обязателен — подстрока, вхождения которой считаются');
    }
    if (typeof oracle.expected !== 'number' || !Number.isInteger(oracle.expected) || oracle.expected < 0) {
      throw new Error('CHECK_INVALID: stdoutOccurrences.expected — неотрицательное целое число');
    }
    return;
  }
  if (typeof oracle.expected !== 'string') {
    throw new Error(`CHECK_INVALID: ${oracle.kind}.expected — строка`);
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const found = haystack.indexOf(needle, offset);
    if (found < 0) return count;
    count += 1;
    offset = found + needle.length;
  }
}

/**
 * Нарушен ли оракул. Судит по последнему запуску сессии: команда наблюдаема только своим
 * выполнением, а повтор кандидата уже оставил этот запуск в сессии.
 */
export async function cliCheckViolated(handle: SessionHandle, check: Check): Promise<boolean> {
  const oracle = check as CliCheck;
  validateCliCheck(oracle);
  const execution = sessionView(handle).executions.at(-1);
  if (execution === undefined) return false;
  switch (oracle.kind) {
    case 'exitCode':
      return execution.exitCode !== Number(oracle.expected);
    case 'stdoutContains':
      return !execution.stdout.includes(String(oracle.expected));
    case 'stdoutNotContains':
      return execution.stdout.includes(String(oracle.expected));
    case 'stderrContains':
      return !execution.stderr.includes(String(oracle.expected));
    case 'stderrNotContains':
      return execution.stderr.includes(String(oracle.expected));
    case 'stdoutOccurrences':
      return countOccurrences(execution.stdout, oracle.pointer as string) !== Number(oracle.expected);
  }
}

export const cliChecks: Checks = {
  kinds: [...cliCheckKinds],
  validate: validateCliCheck,
  violated: cliCheckViolated,
};
