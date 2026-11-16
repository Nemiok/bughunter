import type { StepBase } from '@bughunter/core';

/**
 * Шаг журнала CLI-пресета: одна команда процесса и её исход. Форма плоская, как у node-пресета:
 * core хранит шаги как есть и не знает доменных полей.
 */
export type CliStep = StepBase & {
  argv?: string[];
  /** Команды, выполненные перед основной: например, подготовка заказа для `show`. */
  setup?: string[][];
  exitCode?: number | null;
  signal?: string | null;
  durationMs?: number;
};

/** Запись инвентаря: команда приложения, её шаблон и пример конкретных аргументов. */
export type CliCommand = {
  command: string;
  template: string;
  sampleArgv: string[];
  description?: string;
  /** Команда меняет базу: при `safety.readOnly` её выполнение запрещено. */
  mutates?: boolean;
};

/** Объявленный сценарий обхода: команда, необязательная подготовка и ожидаемый исход. */
export type CliScenario = {
  name: 'valid' | 'empty' | 'invalid' | 'boundary';
  target: string;
  argv: string[];
  setup?: Array<{ argv: string[] }>;
  expect: {
    exitCode: number;
    stdoutContains?: string[];
    stdoutNotContains?: string[];
    stderrContains?: string[];
    stderrNotContains?: string[];
  };
};
