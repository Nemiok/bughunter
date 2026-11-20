import type { Check, Checks, SessionHandle } from '@bughunter/core';

import { assertPointerSyntax, readPointer } from './json-pointer.ts';
import { sessionView } from './session.ts';

/** Словарь оракулов node-пресета: что именно сравнивается с ответом приложения. */
export const nodeCheckKinds = ['status', 'jsonPath', 'headerContains'] as const;

export type NodeCheckKind = (typeof nodeCheckKinds)[number];

/**
 * `pointer` — что читать в ответе: JSON-указатель для `jsonPath`, имя заголовка для
 * `headerContains`. Core хранит поле как есть, но в сигнатуре кандидата его не знает, поэтому
 * два оракула с одинаковыми `kind`, `target` и `expected` и разными указателями дали бы одну
 * сигнатуру: точка входа обязана передавать свою сигнатуру с учётом `pointer`.
 */
export type NodeCheck = Check & { kind: NodeCheckKind; pointer?: string };

/** Цель оракула — строка запроса: «МЕТОД /путь». */
const requestLine = /^([A-Z]{3,7}) (\/\S*)$/;

export function validateNodeCheck(check: Check): void {
  const oracle = check as NodeCheck;
  if (!(nodeCheckKinds as readonly string[]).includes(oracle.kind)) {
    throw new Error(`CHECK_INVALID: неизвестный вид check: ${oracle.kind}; словарь пресета: ${nodeCheckKinds.join(', ')}`);
  }
  if (typeof oracle.target !== 'string' || requestLine.exec(oracle.target.trim()) === null) {
    throw new Error(`CHECK_INVALID: ${oracle.kind}.target — строка запроса «МЕТОД /путь», получено: ${String(oracle.target)}`);
  }
  if (oracle.kind !== 'status' && (typeof oracle.pointer !== 'string' || oracle.pointer.trim().length === 0)) {
    throw new Error(`CHECK_INVALID: ${oracle.kind}.pointer обязателен`);
  }
  if (oracle.expected === undefined) throw new Error(`CHECK_INVALID: ${oracle.kind}.expected обязателен`);
  if (oracle.kind === 'status'
    && (typeof oracle.expected !== 'number' || !Number.isInteger(oracle.expected)
      || oracle.expected < 100 || oracle.expected > 599)) {
    throw new Error(`CHECK_INVALID: status.expected — целый HTTP-код 100–599, получено: ${String(oracle.expected)}`);
  }
  if (oracle.kind === 'jsonPath') assertPointerSyntax(oracle.pointer as string);
}

/**
 * Нарушен ли оракул. Судит по последнему ответу сессии — так же, как веб-оракул судит по текущей
 * странице: состояние API наблюдается только через запрос, и повтор кандидата уже оставил этот
 * ответ в сессии. Если ответов нет, нарушение не фиксируется: у API нечего наблюдать, а запрос
 * «из оракула» без тела и истории ломал бы минимизацию — шаг журнала оказывался бы необязательным.
 */
export async function nodeCheckViolated(handle: SessionHandle, check: Check): Promise<boolean> {
  const oracle = check as NodeCheck;
  validateNodeCheck(oracle);
  const response = sessionView(handle).responses.at(-1);
  if (response === undefined) return false;
  switch (oracle.kind) {
    case 'status':
      return response.status !== Number(oracle.expected);
    case 'jsonPath': {
      let actual: unknown;
      try {
        actual = readPointer(response.body, oracle.pointer as string);
      } catch {
        // Отсутствующее поле — нарушение ожидания «поле равно значению», а не отказ оракула:
        // иначе баги «поле пропало из ответа» никогда не воспроизводились бы.
        return true;
      }
      return !sameValue(actual, oracle.expected);
    }
    case 'headerContains': {
      const wanted = (oracle.pointer as string).trim().toLowerCase();
      const header = Object.entries(response.headers).find(([name]) => name.toLowerCase() === wanted);
      if (header === undefined) return true;
      return !header[1].includes(String(oracle.expected));
    }
  }
}

/** Равенство значений ответа: примитивы напрямую, составные — по JSON-представлению. */
export function sameValue(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (actual === null || expected === null) return false;
  if (typeof actual !== 'object' || typeof expected !== 'object') return false;
  return JSON.stringify(actual) === JSON.stringify(expected);
}

export const nodeChecks: Checks = {
  kinds: [...nodeCheckKinds],
  validate: validateNodeCheck,
  violated: nodeCheckViolated,
};
