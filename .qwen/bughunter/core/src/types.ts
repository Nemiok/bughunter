/** Область прогона. `target` — одна цель из инвентаря пресета, `sweep` — весь инвентарь. */
export type Scope = 'diff' | 'full' | 'target' | 'sweep';

/**
 * Общие поля `config.json`: их владеет core, а поля пресета объявляет его собственная схема,
 * расширяющая общую. Core не знает ни адреса стенда, ни того, что означает цель.
 */
export type Config = {
  baseBranch: string;
  profile?: string;
  /** Карта «изменённый файл → цели прогона» для области `diff`. */
  targetMap: Record<string, string[]>;
  limits: {
    stepsPerSession: number;
    candidatesPerRun: number;
  };
  safety: {
    forbiddenActionText: string[];
    readOnly: boolean;
  };
  testDataPrefix: string;
  tests: {
    unit: { command: string | null };
    /** Каталог сгенерированных тестов относительно ближайшего проекта пресета. */
    generated: { dir: string };
  };
};

export type RunStage = 'created' | 'exploring' | 'reproducing' | 'reviewing' | 'writing_tests' | 'finished';
export type OperationStage = 'pending' | 'running' | 'done' | 'failed';
export type TargetStage = 'pending' | 'exploring' | 'done' | 'failed';

/**
 * Набор стадий зависит от области: у `diff`/`full`/`target` есть `explore`,
 * у `sweep` вместо него детерминированные `sweep` и `findings`.
 */
export type RunStages = {
  explore?: OperationStage;
  reproduce?: OperationStage;
  triage?: OperationStage;
  export?: OperationStage;
  sweep?: OperationStage;
  findings?: OperationStage;
};

/**
 * Находка детерминированного обхода. Это не кандидат: у находки нет журнала сессии,
 * поэтому в кандидаты она превращается только через `promoteFindingToCandidate`.
 * Словарь видов принадлежит пресету (`FindingKinds.kinds`), core его только проверяет.
 */
export type Finding = {
  id: string;
  runId: string;
  targetRef: string;
  /** Ярлык того, что сломано внутри цели; словарь ярлыков принадлежит пресету. */
  subject?: string;
  kind: string;
  detail: string;
  /** Отпечатки доказательств (ответов, снимков и т. п.); их смысл знает пресет. */
  evidenceHashes: string[];
  status: 'new' | 'promoted' | 'dismissed';
  candidateId?: string;
  createdAt: string;
};

/** Что пресет сообщает о цели обхода; конверт находки заполняет core. */
export type FindingDraft = Omit<Finding, 'id' | 'runId' | 'status' | 'createdAt'>;

export type SweepProgress = {
  visited: string[];
  cursor: number;
  startedAt: string;
  updatedAt: string;
};

export type ExploreQueueItem = {
  id: string;
  target: string;
  persona: string;
  status: 'pending' | 'leased' | 'done';
  leaseId?: string;
  leasedAt?: string;
};

export type Run = {
  id: string;
  scope: Scope;
  targets: string[];
  status: RunStage;
  stages: RunStages;
  targetStages: Record<string, TargetStage>;
  exploreQueue?: ExploreQueueItem[];
  createdAt: string;
  updatedAt: string;
};

/** Нарушение инварианта. Словарь видов принадлежит пресету (`Checks.kinds`). */
export type Check = {
  kind: string;
  target: string;
  expected?: string | number;
};

export type Signal = {
  id: string;
  kind: string;
  message: string;
  signature: string;
  target: string;
  timestamp: string;
  stack?: string;
  /** Доменные подробности симптома; core их не читает. */
  details?: Record<string, unknown>;
};

/**
 * Конверт шага журнала: общая часть, которую core хранит, повторяет и включает в кандидат.
 * Поля самого действия объявляет пресет — core их не интерпретирует. Форма на диске одна:
 * шаг пресета структурно расширяет конверт, поэтому вложенность не вводится.
 */
export type StepBase = {
  id: string;
  /** Вид шага — открытый словарь пресета; core его не интерпретирует. */
  kind: string;
  timestamp: string;
  targetRef: string;
  signalIds?: string[];
  responseHashes?: string[];
};

export type Journal = {
  sessionId: string;
  runId: string;
  target: string;
  persona: string;
  steps: StepBase[];
  createdAt: string;
};

export type CandidateVerdict = 'red' | 'green' | 'broken';

export type Candidate = {
  id: string;
  runId: string;
  sessionId: string;
  target: string;
  title: string;
  expected: string;
  actual: string;
  signalIds: string[];
  /** Полная сигнатура: у кандидата с сигналом и оракулом включает оба источника. */
  signature: string;
  /** Сырая сигнатура симптома: по ней повтор находит тот же симптом, когда `signature` композитная. */
  signalSignature?: string;
  steps: StepBase[];
  artifacts: string[];
  status: 'new' | 'unprocessed' | 'confirmed' | 'rejected' | 'duplicate';
  createdAt: string;
  check?: Check;
  duplicateOf?: string;
  /** Подсказка подавления по симптому: запись suppressions.json, чей signalSignature совпал. */
  suppressedBy?: string;
  reproduction?: {
    status: 'unreproduced' | 'reproduced';
    attempts: number;
  };
  review?: {
    status: 'confirmed' | 'rejected' | 'duplicate';
    reason: string;
  };
  /** Виды тестов — открытый словарь пресета (`TestRunner.kinds`, `ExportTarget.kind`). */
  tests?: Record<string, string>;
  /** Вердикты `bh_verify_red` по видам тестов: `green` и `broken` не закрывают баг. */
  verdicts?: Record<string, CandidateVerdict>;
  minimalSteps?: StepBase[];
};
