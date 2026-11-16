import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

import { reportCandidate as reportCoreCandidate, writeJsonAtomic } from '@bughunter/core';
import type { Check, Journal, Session, SessionHandle, Signal } from '@bughunter/core';

import { loadNodeConfig } from './config.ts';
import type { NodeConfig } from './config.ts';
import { scanResponse } from './detectors.ts';
import { targetOfRequest, templatisedPath } from './inventory.ts';
import { loadNodeProfile } from './profile.ts';
import { nodeCheckSignature } from './signature.ts';
import type { EndpointEntry, NodeScenario, NodeStep } from './types.ts';

export type NodeActInput = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
};

export type CapturedResponse = {
  method: string;
  path: string;
  /** 0 — запрос не завершился: таймаут или сетевая ошибка, причина в `error`. */
  status: number;
  headers: Record<string, string>;
  /** Разобранное тело для JSON и текста, `null` для бинарного. */
  body: unknown;
  /** Текст тела, усечённый до `maximumRawBytes`. */
  raw: string;
  durationMs: number;
  error?: string;
};

export type NodeSessionHandle = SessionHandle & {
  responses: CapturedResponse[];
  /** Симптомы, накопленные запросами с прошлого сканирования. */
  drainSignals(): Signal[];
};

/** Read-only вид сессии для оракулов: им нужны конфиг и последний ответ, а не внутренности. */
export type NodeSessionView = {
  readonly config: NodeConfig;
  readonly responses: readonly CapturedResponse[];
};

/** Тело ответа больше этого объёма не хранится: детекторы и снимок работают с усечением. */
export const maximumRawBytes = 65_536;

export const defaultRequestTimeoutMs = 10_000;

type NodeSessionState = {
  id: string;
  runId: string;
  target: string;
  persona: string;
  stateDir: string;
  config: NodeConfig;
  endpoints: EndpointEntry[];
  journal: Journal;
  responses: CapturedResponse[];
  pendingSignals: Signal[];
  /** Все симптомы сессии по идентификаторам: `bh_report_candidate` ссылается на них по id. */
  signals: Map<string, Signal>;
  /** Дескриптор этой сессии: точка входа и оракулы работают с ним, а не с состоянием напрямую. */
  handle?: NodeSessionHandle;
};

const sessions = new Map<string, NodeSessionState>();

function stateOf(handle: SessionHandle): NodeSessionState {
  const state = sessions.get(handle.id);
  if (state === undefined) throw new Error(`SESSION_NOT_FOUND: ${handle.id}`);
  return state;
}

export function sessionView(handle: SessionHandle): NodeSessionView {
  const state = stateOf(handle);
  return { config: state.config, responses: state.responses };
}

function journalPath(state: NodeSessionState): string {
  return join(state.stateDir, 'runs', state.runId, 'journals', `${state.id}.json`);
}

function artifactFile(state: NodeSessionState): string {
  return join(state.stateDir, 'runs', state.runId, 'artifacts', state.id, 'responses.jsonl');
}

export async function openNodeSession(input: {
  runId: string;
  target: string;
  persona: string;
  stateDir: string;
}): Promise<NodeSessionHandle> {
  const config = await loadNodeConfig(input.stateDir);
  const profile = await loadNodeProfile(input.stateDir, config.profile);
  const id = randomUUID();
  const state: NodeSessionState = {
    id,
    runId: input.runId,
    target: input.target,
    persona: input.persona,
    stateDir: input.stateDir,
    config,
    endpoints: profile.endpoints,
    journal: {
      sessionId: id,
      runId: input.runId,
      target: input.target,
      persona: input.persona,
      steps: [],
      createdAt: new Date().toISOString(),
    },
    responses: [],
    pendingSignals: [],
    signals: new Map(),
  };
  sessions.set(id, state);
  try {
    await mkdir(dirname(journalPath(state)), { recursive: true });
    // Журнал пишется сразу: кандидат без шагов всё равно обязан повторяться из файла.
    await writeJsonAtomic(journalPath(state), state.journal);
  } catch (error) {
    sessions.delete(id);
    throw error;
  }
  const handle = handleFor(state);
  state.handle = handle;
  return handle;
}

/** Дескриптор открытой сессии по идентификатору. */
export function sessionHandle(sessionId: string): NodeSessionHandle {
  const handle = sessions.get(sessionId)?.handle;
  if (handle === undefined) throw new Error(`SESSION_NOT_FOUND: ${sessionId}`);
  return handle;
}

/** Закрытие по идентификатору: отсутствующая сессия — не ошибка, её мог закрыть прерванный lease. */
export async function closeNodeSession(sessionId: string): Promise<void> {
  const handle = sessions.get(sessionId)?.handle;
  if (handle === undefined) return;
  await handle.close();
}

function handleFor(state: NodeSessionState): NodeSessionHandle {
  const handle: NodeSessionHandle = {
    id: state.id,
    get responses() {
      return state.responses;
    },
    async snapshot() {
      return {
        target: state.target,
        persona: state.persona,
        endpoints: state.endpoints,
        // Объявленный контракт своей цели: модель обязана брать ожидания отсюда, а не из обычаев REST.
        scenarios: scenariosFor(state),
        stepsLeft: Math.max(0, state.config.limits.stepsPerSession - state.journal.steps.length),
        responses: [...state.responses],
        signals: state.pendingSignals.splice(0, state.pendingSignals.length),
      };
    },
    async act(payload: unknown) {
      return performRequest(handle, payload as NodeActInput, state.config);
    },
    steps: () => [...state.journal.steps] as NodeStep[],
    artifacts: () => (state.responses.length === 0
      ? []
      : [relative(state.stateDir, artifactFile(state)).split(sep).join('/')]),
    drainSignals: () => state.pendingSignals.splice(0, state.pendingSignals.length),
    close: async () => {
      await writeJsonAtomic(journalPath(state), state.journal);
      sessions.delete(state.id);
    },
  };
  return handle;
}

export const nodeSession: Session = { open: openNodeSession };

/**
 * Один HTTP-запрос сессии: единственный способ действовать в node-пресете. Ответ попадает
 * в `handle.responses`, симптомы — в буфер детекторов, шаг — в журнал на диске.
 *
 * `options.journal: false` — запрос без записи в журнал и без симптомов: так оракул проверяет
 * состояние, не искажая шаги кандидата.
 */
export async function performRequest(
  handle: NodeSessionHandle,
  input: NodeActInput,
  config: NodeConfig,
  options: { journal?: boolean } = {},
): Promise<{ response: CapturedResponse; signals: Signal[] }> {
  const state = stateOf(handle);
  const journaled = options.journal !== false;
  if (journaled && state.journal.steps.length >= config.limits.stepsPerSession) throw new Error('LIMIT_REACHED');
  const request: NodeActInput = {
    ...input,
    method: input.method.toUpperCase() as NodeActInput['method'],
    body: normalizeBody(input.body),
  };
  assertSafety(config, request.method, request);
  const url = resolveRequestUrl(request.path, config);
  assertHostAllowed(request.headers, config);

  const response = await sendRequest(url, request.method, request, config);
  const signals = scanResponse(response, config);
  if (journaled) {
    state.responses.push(response);
    state.pendingSignals.push(...signals);
    for (const signal of signals) state.signals.set(signal.id, signal);
    await appendStep(state, request, response, signals);
  }
  return { response, signals };
}

/**
 * Аргументы инструмента приходят JSON'ом, и модель регулярно передаёт тело строкой с JSON вместо
 * значения. Без разбора такая строка кодировалась второй раз, приложение отвечало 400 «тело не
 * объект», и модель заявляла ложного кандидата на исправное поведение. Строка, которая разбирается
 * в объект или массив, отправляется значением; прочий текст остаётся сырым телом — оно законно.
 */
function normalizeBody(body: unknown): unknown {
  if (typeof body !== 'string') return body;
  const trimmed = body.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return body;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return body;
  }
}

/**
 * Заявка кандидата: журнал и симптомы уже в сессии, поэтому точка входа передаёт только суть
 * наблюдения. Сигнатуру оракула считаем сами — с учётом `pointer`, которого core не знает.
 */
export async function reportNodeCandidate(
  handle: NodeSessionHandle,
  input: { title: string; expected: string; actual: string; signalIds: string[]; check?: Check & { pointer?: string } },
): Promise<{ candidateId: string; duplicateOf?: string }> {
  const state = stateOf(handle);
  const referenced = input.signalIds.map((id) => {
    const signal = state.signals.get(id);
    if (signal === undefined) throw new Error(`SIGNAL_NOT_FOUND: ${id}`);
    return signal;
  });
  return reportCoreCandidate({
    runId: state.runId,
    sessionId: state.id,
    target: state.target,
    title: input.title,
    expected: input.expected,
    actual: input.actual,
    steps: [...state.journal.steps],
    signalIds: [...input.signalIds],
    ...(referenced.length > 0
      ? { signalSignature: referenced[0]!.signature }
      : input.check === undefined
        ? {}
        : { signalSignature: nodeCheckSignature(input.check, state.target) }),
    ...(input.check === undefined ? {} : { check: input.check }),
    stateDir: state.stateDir,
  });
}

async function sendRequest(
  url: URL,
  method: string,
  input: NodeActInput,
  config: NodeConfig,
): Promise<CapturedResponse> {
  const path = `${url.pathname}${url.search}`;
  const started = Date.now();
  try {
    const fetched = await fetch(url, {
      method,
      // Переходы не выполняются: редирект увёл бы запрос за разрешённые хосты.
      redirect: 'manual',
      signal: AbortSignal.timeout(config.requestTimeoutMs ?? defaultRequestTimeoutMs),
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      headers: {
        ...(input.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...input.headers,
      },
    });
    const raw = await readBodyCapped(fetched);
    return {
      method,
      path,
      status: fetched.status,
      headers: Object.fromEntries(fetched.headers.entries()),
      body: parseBody(raw, fetched.headers.get('content-type')),
      raw,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    // Стенд может не отвечать: это симптом, а не авария инструмента.
    return {
      method,
      path,
      status: 0,
      headers: {},
      body: null,
      raw: '',
      durationMs: Date.now() - started,
      error: isTimeout(error) ? 'REQUEST_TIMEOUT' : `REQUEST_FAILED: ${failureReason(error)}`,
    };
  }
}

async function readBodyCapped(response: Response): Promise<string> {
  const bytes = Buffer.from(await response.arrayBuffer());
  const capped = bytes.length > maximumRawBytes ? bytes.subarray(0, maximumRawBytes) : bytes;
  return capped.toString('utf8');
}

function parseBody(raw: string, contentType: string | null): unknown {
  if (raw === '') return null;
  const type = contentType ?? '';
  if (type.includes('application/json')) {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return raw;
    }
  }
  return type.startsWith('text/') ? raw : null;
}

function isTimeout(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

function failureReason(error: unknown): string {
  const cause = (error as { cause?: unknown }).cause ?? error;
  const code = (cause as { code?: string } | null)?.code;
  if (typeof code === 'string' && code.length > 0) return code;
  return cause instanceof Error ? cause.message.split('\n')[0]! : String(cause);
}

/**
 * Цель — относительный путь от `baseUrl` либо абсолютный URL разрешённого хоста. Всё остальное
 * отклоняется до отправки: запрос наружу — это действие с приложением, а не намерение.
 */
function resolveRequestUrl(path: string, config: NodeConfig): URL {
  const trimmed = path.trim();
  const absolute = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed);
  let url: URL;
  if (absolute) {
    try {
      url = new URL(trimmed);
    } catch {
      throw new Error(`TARGET_REQUIRED: ${path}`);
    }
  } else {
    if (!trimmed.startsWith('/')) throw new Error(`TARGET_REQUIRED: ${path}`);
    url = new URL(trimmed, config.baseUrl);
  }
  if (!config.allowedHosts.includes(url.hostname)) throw new Error(`FORBIDDEN_ORIGIN: ${url.hostname}`);
  // `allowedHosts` называет хосты, но стенд занимает конкретный порт: другой порт того же хоста —
  // другой сервис, и запрос к нему выходит за пределы прогона. Дополнительные хосты из списка
  // остаются свободными в выборе порта — их объявил автор конфига.
  const base = new URL(config.baseUrl);
  if (url.hostname === base.hostname && url.port !== base.port) {
    throw new Error(`FORBIDDEN_ORIGIN: ${url.host}`);
  }
  return url;
}

function assertHostAllowed(headers: Record<string, string> | undefined, config: NodeConfig): void {
  if (headers === undefined) return;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'host') continue;
    const host = value.trim().replace(/:\d+$/, '');
    if (!config.allowedHosts.includes(host)) throw new Error(`FORBIDDEN_ORIGIN: ${value}`);
  }
}

function assertSafety(config: NodeConfig, method: string, input: NodeActInput): void {
  const { forbiddenActionText, readOnly } = config.safety;
  if (readOnly && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    throw new Error(`FORBIDDEN_ACTION: ${method} при readOnly`);
  }
  const haystack = [method, input.path, input.body === undefined ? '' : JSON.stringify(input.body)].join(' ');
  const forbidden = forbiddenActionText.find((token) => token.length > 0 && haystack.includes(token));
  if (forbidden !== undefined) throw new Error(`FORBIDDEN_ACTION: ${forbidden}`);
}

/** Объявленные сценарии своей цели: контракт приложения, который модель читает вместо догадок. */
function scenariosFor(state: NodeSessionState): NodeScenario[] {
  return state.config.scenarios.filter(
    (scenario) => targetOfRequest(state.endpoints, scenario.request.method, scenario.request.path) === state.target,
  );
}

async function appendStep(
  state: NodeSessionState,
  input: NodeActInput,
  response: CapturedResponse,
  signals: Signal[],
): Promise<void> {
  const step: NodeStep = {
    id: randomUUID(),
    kind: 'act',
    timestamp: new Date().toISOString(),
    targetRef: `${response.method} ${templatisedPath(response.path.split('?')[0]!)}`,
    ...(signals.length === 0 ? {} : { signalIds: signals.map((signal) => signal.id) }),
    responseHashes: [responseHash(response)],
    method: response.method,
    path: response.path,
    ...(input.body === undefined ? {} : { body: input.body }),
    ...(input.headers === undefined ? {} : { headers: input.headers }),
    status: response.status,
    durationMs: response.durationMs,
  };
  state.journal.steps.push(step);
  await writeJsonAtomic(journalPath(state), state.journal);
  const log = artifactFile(state);
  await mkdir(dirname(log), { recursive: true });
  await appendFile(log, `${JSON.stringify({ step: step.id, response })}\n`, 'utf8');
}

/** Отпечаток ответа: им находки обхода ссылаются на конкретный ответ приложения. */
export function responseHash(response: CapturedResponse): string {
  return createHash('sha256').update(`${response.status}\n${response.raw}`).digest('hex');
}
