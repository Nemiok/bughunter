import { randomUUID } from 'node:crypto';

import { signalSignature } from '@bughunter/core';
import type { Detectors, SessionHandle, Signal } from '@bughunter/core';

import type { CliConfig } from './config.ts';
import type { CliSessionHandle, CommandExecution } from './session.ts';

/** Виды симптомов CLI-пресета: код выхода, внутренности в stderr, аномальные токены. */
export const cliDetectorKinds = ['exit-code', 'stderr-stack', 'anomaly'] as const;

const stackMarkers = ['\n    at ', 'at Object.<anonymous>', 'TypeError:', 'ReferenceError:', 'SyntaxError:'];
const maximumStackInSignal = 2_000;
const maximumMessageLength = 200;

function firstLine(text: string): string {
  const line = text.split('\n')[0]!.trim();
  return line.length > maximumMessageLength ? `${line.slice(0, maximumMessageLength)}…` : line;
}

/**
 * Симптомы одного запуска. Ненулевой код вне `allowedExitCodes`, стек в stderr и аномальный
 * токен в любом потоке — нарушения контракта CLI; ожидаемый код ошибки (например, 2) симптомом
 * не считается, иначе штатный отказ приложения выглядел бы багом.
 */
export function scanExecution(execution: CommandExecution, target: string, config: CliConfig): Signal[] {
  const signals: Signal[] = [];
  const add = (kind: string, message: string, stack?: string): void => {
    signals.push({
      id: randomUUID(),
      kind,
      message,
      signature: signalSignature({ kind, message, target, ...(stack === undefined ? {} : { stack }) }),
      target,
      timestamp: new Date().toISOString(),
      ...(execution.exitCode === null ? {} : { status: execution.exitCode }),
    });
  };

  if (execution.timedOut) {
    add('exit-code', `EXECUTION_TIMEOUT: ${execution.argv.join(' ')}`);
  } else if (execution.spawnError !== undefined) {
    add('exit-code', `EXECUTION_FAILED: ${execution.spawnError}`);
  } else if (execution.exitCode === null) {
    add('exit-code', `EXECUTION_SIGNAL: ${execution.signal ?? 'unknown'} (${execution.argv.join(' ')})`);
  } else if (!config.detectors.allowedExitCodes.includes(execution.exitCode)) {
    add('exit-code', `exit=${execution.exitCode} (${execution.argv.join(' ')})`);
  }

  const stack = [execution.stderr, execution.stdout]
    .find((text) => stackMarkers.some((marker) => text.includes(marker)));
  if (stack !== undefined) add('stderr-stack', firstLine(stack), stack.slice(0, maximumStackInSignal));

  const streams = [execution.stdout, execution.stderr];
  for (const token of config.detectors.anomalyTexts) {
    if (streams.some((text) => text.includes(token))) add('anomaly', token);
  }
  return signals;
}

export const cliDetectors: Detectors = {
  kinds: [...cliDetectorKinds],
  scan: async (handle: SessionHandle): Promise<Signal[]> => (handle as CliSessionHandle).drainSignals(),
};
