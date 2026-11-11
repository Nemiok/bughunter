export type Scope = 'diff' | 'full' | 'route';

export type Config = {
  baseUrl: string;
  allowedOrigins: string[];
  routes: string[];
  routeMap: Record<string, string[]>;
  baseBranch: string;
  profile?: string;
  limits: {
    stepsPerSession: number;
    candidatesPerRun: number;
  };
  safety: {
    forbiddenActionText: string[];
    readOnly: boolean;
  };
  testDataPrefix: string;
  detectors: {
    ignoreConsole: string[];
    ignoreRequests: string[];
    anomalyTexts: string[];
    errorBoundarySelector: string;
  };
  tests: {
    unit: { command: string | null };
    e2e: { dir: string };
  };
};

export type RunStage = 'created' | 'exploring' | 'reproducing' | 'reviewing' | 'writing_tests' | 'finished';
export type OperationStage = 'pending' | 'running' | 'done' | 'failed';
export type RouteStage = 'pending' | 'exploring' | 'done' | 'failed';

export type ExploreQueueItem = {
  id: string;
  route: string;
  persona: string;
  status: 'pending' | 'leased' | 'done';
  leaseId?: string;
  leasedAt?: string;
};

export type Run = {
  id: string;
  scope: Scope;
  routes: string[];
  status: RunStage;
  stages: Record<'explore' | 'reproduce' | 'triage' | 'export', OperationStage>;
  routeStages: Record<string, RouteStage>;
  exploreQueue?: ExploreQueueItem[];
  createdAt: string;
  updatedAt: string;
};

export type Check = {
  kind: 'visibleText' | 'notVisibleText' | 'elementCount';
  target: string;
  expected?: string | number;
};

export type Signal = {
  id: string;
  kind: string;
  message: string;
  signature: string;
  route: string;
  timestamp: string;
  stack?: string;
  url?: string;
  status?: number;
};

export type SemanticLocator =
  | { kind: 'testid'; value: string; index?: number }
  | { kind: 'role'; role: string; name: string; index?: number }
  | { kind: 'text'; value: string; index?: number }
  | { kind: 'css'; value: string; index?: number };

export type ElementSnapshot = {
  id: string;
  role: string;
  name: string;
  type: string;
  value?: string;
  disabled?: boolean;
  locator: SemanticLocator;
};

export type Step = {
  id: string;
  kind: 'act' | 'navigate' | 'probe';
  timestamp: string;
  routeTemplate: string;
  action?: 'click' | 'dblclick' | 'fill' | 'select' | 'press' | 'check' | 'hover';
  elementId?: string;
  value?: string;
  path?: string;
  probe?: 'reload' | 'back' | 'mobile_viewport';
  locator?: string;
  signalIds?: string[];
};

export type Journal = {
  sessionId: string;
  runId: string;
  route: string;
  persona: string;
  steps: Step[];
  createdAt: string;
};

export type Candidate = {
  id: string;
  runId: string;
  sessionId: string;
  route: string;
  title: string;
  expected: string;
  actual: string;
  signalIds: string[];
  signature: string;
  steps: Step[];
  artifacts: string[];
  status: 'new' | 'unprocessed' | 'confirmed' | 'rejected' | 'duplicate';
  createdAt: string;
  check?: Check;
  duplicateOf?: string;
  reproduction?: {
    status: 'unreproduced' | 'reproduced';
    attempts: number;
  };
  review?: {
    status: 'confirmed' | 'rejected' | 'duplicate';
    reason: string;
  };
  tests?: {
    e2e?: string;
    unit?: string;
  };
  minimalSteps?: Step[];
};
