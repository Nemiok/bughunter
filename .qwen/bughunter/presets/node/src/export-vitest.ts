import { exportTest as exportCoreTest } from '@bughunter/core';
import type { Candidate, ExportTarget, TestGenerator } from '@bughunter/core';

import { loadNodeConfig } from './config.ts';
import type { NodeConfig } from './config.ts';
import type { NodeCheck } from './checks.ts';
import { apiKind, nodeTestRunner } from './test-runner.ts';
import type { NodeStep } from './types.ts';

/** Таймаут сгенерированного теста: ожиданий в теле нет, но стенд может отвечать медленно. */
const testTimeoutMs = 60_000;

export const nodeExportTarget: ExportTarget = {
  kind: apiKind,
  dir: (config) => config.tests.generated.dir,
  fileName: (bugId) => `${bugId}.test.ts`,
};

export const nodeTestGenerator: TestGenerator = {
  async generate({ candidate, stateDir }) {
    return generateVitestTest(candidate, await loadNodeConfig(stateDir));
  },
};

export async function exportNodeTest(input: { runId: string; bugId: string; stateDir: string }) {
  const config = await loadNodeConfig(input.stateDir);
  return exportCoreTest({
    ...input,
    config,
    generate: nodeTestGenerator,
    target: nodeExportTarget,
    runner: nodeTestRunner,
  });
}

/**
 * Регрессионный тест на подтверждённый баг: последовательность запросов из журнала и одно
 * утверждение на симптом. Никаких импортов bughunter и никаких искусственных ожиданий — только
 * `fetch` к стенду из конфига, чтобы тест жил в проекте приложения и запускался его раннером.
 */
export function generateVitestTest(candidate: Candidate, config: NodeConfig): string {
  const steps = (candidate.minimalSteps ?? candidate.steps) as NodeStep[];
  const check = candidate.check as NodeCheck | undefined;
  const assertion = buildAssertion(steps, check, config);
  return [
    '// Сгенерировано Bughunter: регрессионный тест на подтверждённый баг.',
    `// Ожидалось: ${oneLine(candidate.expected)}`,
    `// Фактически: ${oneLine(candidate.actual)}`,
    "import { expect, test } from 'vitest';",
    '',
    `const baseUrl = ${JSON.stringify(trimTrailingSlash(config.baseUrl))};`,
    '',
    requestHelper(),
    ...(assertion.helper === undefined ? [] : ['', assertion.helper]),
    '',
    `test(${JSON.stringify(candidate.title)}, async () => {`,
    ...requestLines(steps, check, config),
    `  ${assertion.expression}`,
    `}, ${testTimeoutMs});`,
    '',
  ].join('\n');
}

function oneLine(value: string): string {
  return value.replaceAll('\n', ' ').trim();
}

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function requestHelper(): string {
  return `async function request(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
  const response = await fetch(\`\${baseUrl}\${path}\`, {
    method,
    redirect: 'manual',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text === '' ? null : JSON.parse(text) as unknown;
  } catch {
    parsed = text;
  }
  return { status: response.status, headers: response.headers, body: parsed };
}`;
}

function requestCall(method: string, path: string, body?: unknown, headers?: Record<string, string>): string {
  const args = [JSON.stringify(method.toUpperCase()), JSON.stringify(path)];
  if (body !== undefined) args.push(JSON.stringify(body));
  if (headers !== undefined) {
    if (body === undefined) args.push('undefined');
    args.push(JSON.stringify(headers));
  }
  return `request(${args.join(', ')})`;
}

/** Сброс стенда обязателен: тест должен начинаться с того же состояния, что и прогон. */
function requestLines(steps: NodeStep[], check: NodeCheck | undefined, config: NodeConfig): string[] {
  const lines: string[] = [];
  if (config.reset !== null) {
    lines.push(`  await ${requestCall(config.reset.method, config.reset.path)};`);
  }
  const calls = steps.map((step) => requestCall(step.method ?? 'GET', step.path ?? '/', step.body, step.headers));
  if (calls.length === 0 && check !== undefined) {
    const request = /^([A-Z]{3,7}) (\/\S*)$/.exec(check.target.trim());
    if (request !== null) calls.push(requestCall(request[1]!, request[2]!));
  }
  calls.forEach((call, index) => {
    lines.push(index === calls.length - 1 ? `  const last = await ${call};` : `  await ${call};`);
  });
  return lines;
}

function comparison(expected: unknown): 'toBe' | 'toEqual' {
  return expected !== null && typeof expected === 'object' ? 'toEqual' : 'toBe';
}

/**
 * У кандидата с оракулом утверждение повторяет оракул. У сигнального кандидата симптом виден
 * в последнем шаге журнала: статус 4xx/5xx (или 0 — запрос не завершился) либо аномальный токен
 * в теле при успешном статусе.
 */
function buildAssertion(
  steps: NodeStep[],
  check: NodeCheck | undefined,
  config: NodeConfig,
): { expression: string; helper?: string } {
  if (check !== undefined) {
    switch (check.kind) {
      case 'status':
        return { expression: `expect(last.status).toBe(${Number(check.expected)});` };
      case 'jsonPath':
        return {
          expression: `expect(valueAt(last.body, ${JSON.stringify(check.pointer ?? '')}))`
            + `.${comparison(check.expected)}(${JSON.stringify(check.expected)});`,
          helper: pointerHelper(),
        };
      case 'headerContains':
        return {
          expression: `expect(last.headers.get(${JSON.stringify(check.pointer ?? '')}) ?? '')`
            + `.toContain(${JSON.stringify(String(check.expected))});`,
        };
    }
  }
  const status = steps.at(-1)?.status;
  if (status !== undefined && (status === 0 || status >= 400)) {
    return { expression: `expect(last.status).toBe(${status});` };
  }
  return {
    expression: 'expect(anomaliesIn(last.body)).not.toEqual([]);',
    helper: anomaliesHelper(config.detectors.anomalyTexts),
  };
}

function pointerHelper(): string {
  return `function valueAt(value: unknown, pointer: string): unknown {
  const segments = pointer.startsWith('$')
    ? pointer.slice(1).split(/[[\\].]+/).filter((segment) => segment !== '')
    : pointer.split('/').filter((segment) => segment !== '').map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
  let current: unknown = value;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}`;
}

function anomaliesHelper(tokens: string[]): string {
  return `function anomaliesIn(value: unknown): string[] {
  const tokens = ${JSON.stringify(tokens)};
  const found = new Set<string>();
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      for (const token of tokens) if (node.includes(token)) found.add(token);
    } else if (Array.isArray(node)) {
      for (const item of node) walk(item);
    } else if (node !== null && typeof node === 'object') {
      for (const item of Object.values(node)) walk(item);
    }
  };
  walk(value);
  return [...found];
}`;
}
