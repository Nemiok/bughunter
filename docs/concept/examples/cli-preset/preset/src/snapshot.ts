import type { Snapshot } from '@bughunter/core';

import type { CommandExecution } from './session.ts';

const maximumExecutionsInSnapshot = 10;
const maximumStreamInSnapshot = 2_048;

function trimStream(value: string): { value: string; truncated: boolean } {
  return value.length > maximumStreamInSnapshot
    ? { value: value.slice(0, maximumStreamInSnapshot), truncated: true }
    : { value, truncated: false };
}

/** Один запуск для модели: потоки усекаются, факт усечения виден явно. */
export function trimExecution(execution: CommandExecution): CommandExecution & { truncated?: boolean } {
  const stdout = trimStream(execution.stdout);
  const stderr = trimStream(execution.stderr);
  return {
    ...execution,
    stdout: stdout.value,
    stderr: stderr.value,
    ...(stdout.truncated || stderr.truncated ? { truncated: true } : {}),
  };
}

/** Последние запуски и новые симптомы: полный журнал остаётся на диске артефактом. */
export const cliSnapshot: Snapshot = {
  compact: (value) => {
    if (value === null || typeof value !== 'object') return value;
    const snapshot = value as { executions?: unknown };
    if (!Array.isArray(snapshot.executions)) return value;
    const executions = snapshot.executions as CommandExecution[];
    return {
      ...snapshot,
      executions: executions.slice(-maximumExecutionsInSnapshot).map(trimExecution),
      totalExecutions: executions.length,
    };
  },
};
