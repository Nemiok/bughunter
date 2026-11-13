import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Candidate, Check, Config, Finding, Signal, Step } from './types.ts';

/** Единица исследования: шаблон маршрута в web-пресете, эндпоинт в node-пресете. */
export type TargetRef = string;

/** Что существует в приложении и как это шаблонизируется. */
export type TargetInventory = {
  list(stateDir: string): Promise<TargetRef[]>;
  templateOf(value: string): TargetRef;
};

/** Живая сессия: то, через что core действует, не зная домена. */
export type SessionHandle = {
  id: string;
  snapshot(): Promise<unknown>;
  act(payload: unknown): Promise<unknown>;
  steps(): Step[];
  artifacts(): string[];
  close(): Promise<void>;
};

export type Session = {
  open(input: { runId: string; target: TargetRef; persona: string; stateDir: string }): Promise<SessionHandle>;
};

/** Что отдавать модели из снимка: ранжирование, лимит и отсечение лишнего. */
export type Snapshot = {
  compact(value: unknown): unknown;
};

/** Источники симптома. Нормализация и сигнатура остаются в core. */
export type Detectors = {
  kinds: string[];
  scan(handle: SessionHandle): Promise<Signal[]>;
};

/** Оракулы нарушения инварианта: словарь видов принадлежит пресету. */
export type Checks = {
  kinds: string[];
  validate(check: Check): void;
  violated(handle: SessionHandle, check: Check): Promise<boolean>;
};

/** Исполнение журнала шагов в чистой сессии; протокол повтора и минимизация — в core. */
export type Replay = {
  replay(steps: Step[], input: { target: TargetRef; persona: string; stateDir: string }): Promise<boolean>;
};

export type TestGenerator = {
  generate(input: { candidate: Candidate; initialTarget: TargetRef; stateDir: string }): Promise<string>;
};

/** Конфиг приложения: slot обязателен, форма — за пресетом. */
export type ProfileSchema = {
  load(stateDir: string, name: string): Promise<unknown>;
  testDataFile(profile: unknown, relativePath: string): string;
};

/**
 * Нейтральная сводка одного запуска теста. Core выносит вердикт `red | green | broken`
 * только по ней, поэтому формат отчёта раннера остаётся знанием пресета.
 */
export type TestRunSummary = {
  /** Раннер отчитался ровно по одному выбранному файлу. */
  singleFile: boolean;
  tests: number;
  passed: number;
  failed: number;
  /** Ошибки вне ассертов: синтаксис, импорт, таймаут раннера, глобальные ошибки. */
  runtimeErrors: boolean;
  /** Все падения — обычные провалы ассертов, а не инфраструктура. */
  assertionFailuresOnly: boolean;
  /** Специфичные раннеру признаки чистого прогона: флаги успеха, отсутствие flaky и skipped. */
  cleanPass: boolean;
  names: string[];
  diagnostic: string;
};

/** Как запускать тесты и как понимать отчёт; вердикт red/green/broken классифицирует core. */
export type TestRunner = {
  kinds: string[];
  resolveKind(input: { projectRoot: string; testFile: string; requested?: string; unitCommand?: string | null }): Promise<string | null>;
  command(kind: string, input: { projectRoot: string; testFile: string; reportFile: string; unitCommand?: string | null }): Promise<{ command: string; env?: NodeJS.ProcessEnv }>;
  parseReport(kind: string, raw: unknown, input: { testFile: string; exitCode: number | null }): TestRunSummary;
  ownsProject(packageJson: unknown): boolean;
};

export type Personas = {
  roster: readonly string[];
  brief(persona: string): string;
};

/** Словарь находок детерминированного обхода и шаг журнала для промоции находки в кандидата. */
export type FindingKinds = {
  kinds: string[];
  syntheticStep(finding: Finding): Step;
};

/** Визит одной цели обхода: дойти, снять, сравнить. Курсор и чекпоинты — в core. */
export type SweepVisit = {
  visit(input: { target: TargetRef; handle: SessionHandle; stateDir: string }): Promise<Finding[]>;
};

export type Reset = {
  supported: boolean;
  apply(handle: SessionHandle): Promise<void>;
};

export type ExportTarget = {
  dir(config: Config): string;
  kind: string;
  fileName(bugId: string): string;
};

/** Доменные коды ошибок пресета; коды core объявлены отдельно. */
export type Errors = {
  codes: Record<string, string>;
};

export type ReportFormat = {
  finding(finding: Finding): string[];
  candidate(candidate: Candidate): string[];
};

export type Preset = {
  name: string;
  configSchema: unknown;
  inventory: TargetInventory;
  session: Session;
  snapshot: Snapshot;
  detectors: Detectors;
  checks: Checks;
  replay: Replay;
  generateTest: TestGenerator;
  profile: ProfileSchema;
  testRunner: TestRunner;
  personas: Personas;
  findingKinds: FindingKinds;
  sweepVisit: SweepVisit;
  reset: Reset;
  exportTarget: ExportTarget;
  errors: Errors;
  report: ReportFormat;
};

const requiredFields = [
  'name', 'configSchema', 'inventory', 'session', 'snapshot', 'detectors', 'checks', 'replay',
  'generateTest', 'profile', 'testRunner', 'personas', 'findingKinds', 'sweepVisit', 'reset',
  'exportTarget', 'errors', 'report',
] as const;

export function assertPreset(preset: unknown): Preset {
  if (typeof preset !== 'object' || preset === null) throw new Error('PRESET_INVALID: preset');
  for (const field of requiredFields) {
    if ((preset as Record<string, unknown>)[field] === undefined) throw new Error(`PRESET_INVALID: ${field}`);
  }
  return preset as Preset;
}

/**
 * Один проект — один пресет: core-инструменты у всех пресетов именуются одинаково,
 * поэтому второй пресет на том же stateDir дал бы коллизию имён MCP-инструментов.
 */
export async function assertSinglePreset(stateDir: string, presetName: string): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  const file = join(stateDir, 'preset.json');
  let recorded: string | undefined;
  try {
    recorded = (JSON.parse(await readFile(file, 'utf8')) as { name?: string }).name;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (recorded === presetName) return;
  if (recorded !== undefined) throw new Error(`PRESET_CONFLICT: ${stateDir}`);
  await writeFile(file, `${JSON.stringify({ name: presetName }, null, 2)}\n`, 'utf8');
}
