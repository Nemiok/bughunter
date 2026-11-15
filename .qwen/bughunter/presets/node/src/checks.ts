import type { Check, Checks, SessionHandle } from '@bughunter/core';

import { readPointer } from './json-pointer.ts';
import { performRequest, sessionView } from './session.ts';
import type { CapturedResponse, NodeActInput, NodeSessionHandle } from './session.ts';

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
}

/**
 * Нарушен ли оракул. Судит по последнему ответу сессии — так же, как веб-оракул судит по текущей
 * странице: состояние API наблюдается только через запрос, и повтор кандидата уже оставил ответ
 * в сессии. Если ответов ещё нет (кандидат без шагов), запрос из `check.target` выполняется
 * без записи в журнал, чтобы проверка не исказила шаги.
 */
export async function nodeCheckViolated(handle: SessionHandle, check: Check): Promise<boolean> {
  const oracle = check as NodeCheck;
  validateNodeCheck(oracle);
  const response = await responseFor(handle as NodeSessionHandle, oracle);
  switch (oracle.kind) {
    case 'status':
      return response.status !== Number(oracle.expected);
    case 'jsonPath':
      return !sameValue(readPointer(response.body, oracle.pointer as string), oracle.expected);
    case 'headerContains': {
      const wanted = (oracle.pointer as string).trim().toLowerCase();
      const header = Object.entries(response.headers).find(([name]) => name.toLowerCase() === wanted);
      if (header === undefined) return true;
      return !header[1].includes(String(oracle.expected));
    }
  }
}

async function responseFor(handle: NodeSessionHandle, check: NodeCheck): Promise<CapturedResponse> {
  const view = sessionView(handle);
  const last = view.responses.at(-1);
  if (last !== undefined) return last;
  const request = requestLine.exec(check.target.trim());
  if (request === null) throw new Error(`CHECK_INVALID: ${check.target}`);
  const { response } = await performRequest(
    handle,
    { method: request[1] as NodeActInput['method'], path: request[2]! },
    view.config,
    { journal: false },
  );
  return response;
}

function sameValue(actual: unknown, expected: unknown): boolean {
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
