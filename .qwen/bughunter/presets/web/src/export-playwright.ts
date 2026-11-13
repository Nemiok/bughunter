import { resolve } from 'node:path';

import { exportTest as exportCoreTest } from '@bughunter/core';
import type { Candidate, Config, ExportTarget, Step, TestGenerator } from '@bughunter/core';

import { isValidScroll, scrollDeltas } from './browser/point.ts';
import { loadConfig } from './config.ts';
import { defaultStateDir } from './paths.ts';
import { loadActiveProfile, resolveTestDataFile } from './profile/load.ts';
import type { Profile } from './profile/types.ts';
import { webTestRunner } from './test-runner.ts';

const jsonString = '"(?:\\\\.|[^"\\\\])*"';

function allowedUrl(path: string, config: Config): string {
  let target: URL;
  try {
    target = new URL(path, config.baseUrl);
  } catch {
    throw new Error(`ROUTE_NOT_ALLOWED: ${path}`);
  }
  // Граница та же, что у рантайм-навигации (SessionManager.isAllowed): разрешённый origin.
  // config.routes — область исследования, а не allowlist переходов, иначе легально
  // записанный журнал оказывался бы неэкспортируемым.
  const allowed = ['http:', 'https:'].includes(target.protocol)
    && !target.username
    && !target.password
    && config.allowedOrigins.some((origin) => {
      try {
        const allowedOrigin = new URL(origin);
        return !allowedOrigin.username && !allowedOrigin.password && allowedOrigin.origin === target.origin;
      } catch {
        return false;
      }
    });
  if (!allowed) throw new Error(`ROUTE_NOT_ALLOWED: ${path}`);
  return target.href;
}

function semanticLocator(source: string): string {
  const patterns = [
    {
      regex: new RegExp(`^page\\.getByTestId\\((${jsonString})\\)(?:\\.nth\\((\\d+)\\))?$`),
      format: (match: RegExpMatchArray) => `page.getByTestId(${JSON.stringify(JSON.parse(match[1]!) as string)})`,
    },
    {
      regex: new RegExp(`^page\\.getByText\\((${jsonString}), \\{ exact: true \\}\\)(?:\\.nth\\((\\d+)\\))?$`),
      format: (match: RegExpMatchArray) => `page.getByText(${JSON.stringify(JSON.parse(match[1]!) as string)}, { exact: true })`,
    },
    {
      regex: new RegExp(`^page\\.locator\\((${jsonString})\\)(?:\\.nth\\((\\d+)\\))?$`),
      format: (match: RegExpMatchArray) => `page.locator(${JSON.stringify(JSON.parse(match[1]!) as string)})`,
    },
    {
      regex: new RegExp(`^page\\.getByRole\\((${jsonString}), \\{ name: (${jsonString}), exact: true \\}\\)(?:\\.nth\\((\\d+)\\))?$`),
      format: (match: RegExpMatchArray) => `page.getByRole(${JSON.stringify(JSON.parse(match[1]!) as string)}, { name: ${JSON.stringify(JSON.parse(match[2]!) as string)}, exact: true })`,
    },
  ];
  for (const { regex, format } of patterns) {
    const match = source.match(regex);
    if (!match) continue;
    const expression = format(match);
    const index = match[match.length - 1];
    return index === undefined ? expression : `${expression}.nth(${Number(index)})`;
  }
  throw new Error(`STEP_LOCATOR_INVALID: ${source}`);
}

function actionSource(step: Step, profile: Profile | null): string {
  if (step.action === undefined) throw new Error(`STEP_ACTION_INVALID: ${step.id}`);
  const element = (): string => {
    if (step.locator === undefined) throw new Error(`STEP_ACTION_INVALID: ${step.id}`);
    return semanticLocator(step.locator);
  };
  switch (step.action) {
    case 'click':
    case 'dblclick':
    case 'check':
    case 'hover':
      return `await ${element()}.${step.action}();`;
    case 'fill':
    case 'press':
      if (step.value === undefined) throw new Error(`STEP_VALUE_REQUIRED: ${step.id}`);
      return `await ${element()}.${step.action}(${JSON.stringify(step.value)});`;
    case 'select':
      if (step.value === undefined) throw new Error(`STEP_VALUE_REQUIRED: ${step.id}`);
      return `await ${element()}.selectOption(${JSON.stringify(step.value)});`;
    case 'drag':
      if (step.to?.locator === undefined) throw new Error(`STEP_ACTION_INVALID: ${step.id}`);
      return `await ${element()}.dragTo(${semanticLocator(step.to.locator)});`;
    case 'scroll': {
      if (!isValidScroll(step.scroll)) throw new Error(`STEP_ACTION_INVALID: ${step.id}`);
      const { dx, dy } = scrollDeltas(step.scroll);
      // Без элемента скроллится страница, с элементом — конкретный контейнер (виртуальные списки BI).
      return step.locator === undefined
        ? `await page.mouse.wheel(${dx}, ${dy});`
        : `await ${element()}.evaluate((element) => element.scrollBy(${dx}, ${dy}));`;
    }
    case 'clickAt':
    case 'hoverAt': {
      if (step.at === undefined) throw new Error(`STEP_ACTION_INVALID: ${step.id}`);
      const method = step.action === 'clickAt' ? 'click' : 'move';
      return `await page.mouse.${method}(${step.at.x}, ${step.at.y});`;
    }
    case 'upload':
      if (step.file === undefined) throw new Error(`STEP_ACTION_INVALID: ${step.id}`);
      return `await ${element()}.setInputFiles(${JSON.stringify(resolveTestDataFile(profile, step.file))});`;
  }
}

function replaySource(candidate: Candidate, config: Config, profile: Profile | null): string {
  const steps = (candidate as Candidate & { minimalSteps?: Step[] }).minimalSteps ?? candidate.steps;
  return steps.map((step) => {
    if (step.kind === 'act') return `  ${actionSource(step, profile)}\n`;
    if (step.kind === 'navigate') {
      if (!step.path) throw new Error(`STEP_PATH_REQUIRED: ${step.id}`);
      return `  await page.goto(new URL(${JSON.stringify(step.path)}, ${JSON.stringify(config.baseUrl)}).href, { waitUntil: 'domcontentloaded' });\n`;
    }
    switch (step.probe) {
      case 'reload':
        return "  await page.reload({ waitUntil: 'domcontentloaded' });\n";
      case 'back':
        return "  await page.goBack({ waitUntil: 'domcontentloaded' });\n";
      case 'mobile_viewport':
        return '  await page.setViewportSize({ width: 390, height: 844 });\n';
      default:
        throw new Error(`STEP_PROBE_INVALID: ${step.id}`);
    }
  }).join('');
}

/** Сколько миллисекунд спек ждёт появления ожидаемого текста. */
const textAppearTimeoutMs = 5_000;
/** Сколько миллисекунд спек наблюдает отсутствие текста: симптом может отрисоваться позже первого опроса. */
const absenceWindowMs = 3_000;

function visibleTextCallback(target: string): string {
  return `async () => { const matches = page.getByText(${JSON.stringify(target)}, { exact: true }); const total = await matches.count(); for (let index = 0; index < total; index += 1) { if (await matches.nth(index).isVisible()) return true; } return false; }`;
}

/**
 * Проверка текста в экспорте обязана совпадать с ядром (`hasVisibleText` в reproduce.ts):
 * `.first()` попадает в скрытый узел (option фильтра, шаблон, aria-live), из-за чего спек
 * оставался красным после починки или, что хуже, зелёным при живом баге.
 *
 * Отрицание при этом нельзя проверять ни одним снимком, ни `expect.poll(...).toBe(false)`:
 * poll прекращает опрос на первом совпадении с ожиданием, поэтому симптом, отрисованный позже
 * первого опроса, давал зелёный спек при живом баге (дубль заказа проявлялся только так).
 * Отсутствие наблюдается окном: ждём появления текста и считаем симптомом всё, что возникло
 * за отведённое время.
 */
function visibleTextPoll(target: string, expected: boolean): string {
  if (expected) return `await expect.poll(${visibleTextCallback(target)}, { timeout: ${textAppearTimeoutMs} }).toBe(true);`;
  return `const symptomAppeared = await (async () => { try { await expect.poll(${visibleTextCallback(target)}, { timeout: ${absenceWindowMs} }).toBe(true); return true; } catch { return false; } })(); expect(symptomAppeared).toBe(false);`;
}

function checkAssertion(candidate: Candidate): string {
  if (!candidate.check) throw new Error('CANDIDATE_ORACLE_REQUIRED');
  const check = candidate.check;
  switch (check.kind) {
    case 'visibleText':
      return visibleTextPoll(check.target, true);
    case 'notVisibleText':
      return visibleTextPoll(check.target, false);
    case 'elementCount': {
      const expected = check.expected ?? 0;
      if (typeof expected !== 'number' || !Number.isFinite(expected) || !Number.isInteger(expected) || expected < 0) {
        throw new Error(`ELEMENT_COUNT_EXPECTED_INVALID: ${JSON.stringify(expected)}`);
      }
      return `await expect(page.locator(${JSON.stringify(check.target)})).toHaveCount(${JSON.stringify(expected)});`;
    }
  }
}

function signalSource(candidate: Candidate, config: Config, initialRoute: string, replay: string): string {
  const signature = JSON.stringify(candidate.signature);
  return `import { createHash } from 'node:crypto';
import { test, expect } from '@playwright/test';

test(${JSON.stringify(candidate.title)}, async ({ page }) => {
  let matched = false;
  const normalize = (value: string): string => value
    .replace(/([?&][^=\\s&]+)=([^&\\s]*)/g, '$1=<value>')
    .replace(/\\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\b/gi, '<uuid>')
    .replace(/\\d+(?:\\.\\d+)?/g, '<number>')
    .replace(/\\s+/g, ' ')
    .trim();
  const signature = (input: { kind: string; message: string; route: string; stack?: string }): string => {
    const topFrame = input.stack?.split('\\n').find((line) => /^\\s*at\\s+/.test(line)) ?? '';
    return createHash('sha256').update([input.kind, normalize(input.message), normalize(input.route), normalize(topFrame)].join('\\n')).digest('hex');
  };
  const route = (): string => {
    try {
      return new URL(page.url()).pathname;
    } catch {
      return page.url();
    }
  };
  page.on('pageerror', (error) => {
    if (signature({ kind: 'pageerror', message: error.message, route: route(), ...(error.stack === undefined ? {} : { stack: error.stack }) }) === ${signature}) matched = true;
  });
  page.on('console', (message) => {
    if (message.type() === 'error' && signature({ kind: 'console', message: message.text(), route: route() }) === ${signature}) matched = true;
  });
  page.on('requestfailed', (request) => {
    const url = request.url();
    const reason = request.failure()?.errorText ?? 'Request failed';
    if (signature({ kind: 'requestfailed', message: \`\${request.method()} \${url}: \${reason}\`, route: route() }) === ${signature}) matched = true;
  });
  page.on('response', (response) => {
    const status = response.status();
    const url = response.url();
    if (status >= 400 && signature({ kind: 'response', message: \`\${response.request().method()} \${url}: HTTP \${status}\`, route: route() }) === ${signature}) matched = true;
  });
  const observedAnomalies: Array<{ text: string; route: string }> = [];
  await page.exposeFunction('__bughunterReportAnomalies', (entries: Array<{ text: string; route: string }>) => {
    for (const entry of entries) observedAnomalies.push(entry);
  });
  await page.addInitScript((anomalyTexts: string[]) => {
    const target = window as unknown as Window & {
      __bughunterAnomalyObserver?: MutationObserver;
      __bughunterSeenAnomalies?: Set<string>;
      __bughunterReportAnomalies: (entries: Array<{ text: string; route: string }>) => void;
    };
    if (target.__bughunterAnomalyObserver) return;
    target.__bughunterSeenAnomalies = new Set();
    const scan = (): void => {
      if (!document.body) return;
      const text = document.body.innerText;
      for (const token of anomalyTexts) {
        if (token.length === 0) continue;
        const escaped = token.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
        if (!new RegExp(\`(?<![\\\\p{L}\\\\p{N}_])\${escaped}(?![\\\\p{L}\\\\p{N}_])\`, 'u').test(text)) continue;
        let observedRoute: string;
        try {
          observedRoute = new URL(location.href).pathname;
        } catch {
          observedRoute = location.href;
        }
        const key = \`\${token}\\n\${observedRoute}\`;
        if (target.__bughunterSeenAnomalies!.has(key)) continue;
        target.__bughunterSeenAnomalies!.add(key);
        target.__bughunterReportAnomalies([{ text: token, route: observedRoute }]);
      }
    };
    target.__bughunterAnomalyObserver = new MutationObserver(scan);
    target.__bughunterAnomalyObserver.observe(document, { characterData: true, childList: true, subtree: true });
    scan();
  }, ${JSON.stringify(config.detectors.anomalyTexts)});
  await page.goto(new URL(${JSON.stringify(initialRoute)}, ${JSON.stringify(config.baseUrl)}).href, { waitUntil: 'domcontentloaded' });
${replay}  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => undefined);
  const bodyText = await page.locator('body').innerText();
  for (const text of ${JSON.stringify(config.detectors.anomalyTexts)}) {
    const escaped = text.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&');
    if (text.length > 0 && new RegExp(\`(?<![\\\\p{L}\\\\p{N}_])\${escaped}(?![\\\\p{L}\\\\p{N}_])\`, 'u').test(bodyText) && signature({ kind: 'anomaly', message: text, route: route() }) === ${signature}) matched = true;
  }
  for (const entry of observedAnomalies) {
    if (signature({ kind: 'anomaly', message: entry.text, route: entry.route }) === ${signature}) matched = true;
  }
  const boundaries = page.locator(${JSON.stringify(config.detectors.errorBoundarySelector)});
  for (let index = 0; index < await boundaries.count(); index += 1) {
    const boundary = boundaries.nth(index);
    if (await boundary.isVisible()) {
      const text = (await boundary.innerText()).trim() || ${JSON.stringify(config.detectors.errorBoundarySelector)};
      if (signature({ kind: 'errorBoundary', message: text, route: route() }) === ${signature}) matched = true;
    }
  }
  expect(matched).toBe(false);
});
`;
}

export function generatePlaywrightTest(
  candidate: Candidate,
  config: Config,
  initialRoute = candidate.route,
  profile: Profile | null = null,
): string {
  allowedUrl(initialRoute, config);
  const replay = replaySource(candidate, config, profile);
  for (const step of (candidate as Candidate & { minimalSteps?: Step[] }).minimalSteps ?? candidate.steps) {
    if (step.kind === 'navigate' && step.path) allowedUrl(step.path, config);
  }
  if (candidate.signalIds.length > 0) return signalSource(candidate, config, initialRoute, replay);
  return `import { test, expect } from '@playwright/test';

test(${JSON.stringify(candidate.title)}, async ({ page }) => {
  await page.goto(new URL(${JSON.stringify(initialRoute)}, ${JSON.stringify(config.baseUrl)}).href, { waitUntil: 'domcontentloaded' });
${replay}  ${checkAssertion(candidate)}
});
`;
}

/** Каталог назначения: сгенерированный тест живёт там, где его запустит раннер пресета. */
export const webExportTarget: ExportTarget = {
  dir: (config) => config.tests.e2e.dir,
  kind: 'e2e',
  fileName: (bugId) => `${bugId}.spec.ts`,
};

export const webTestGenerator: TestGenerator = {
  async generate({ candidate, initialTarget, stateDir }) {
    const [config, profile] = await Promise.all([loadConfig(stateDir), loadActiveProfile(stateDir)]);
    return generatePlaywrightTest(candidate, config, initialTarget, profile);
  },
};

/**
 * Экспорт с веб-значениями по умолчанию: генератор Playwright-спека, каталог из конфига
 * приложения и раннер, узнающий свой проект по `@playwright/test`. Порядок действий,
 * запись ровно один раз и защита пути принадлежат core.
 */
export async function exportTest(input: {
  runId: string;
  bugId: string;
  stateDir?: string;
}): Promise<{ file: string; placedInProject: boolean }> {
  const stateDir = input.stateDir ? resolve(input.stateDir) : defaultStateDir;
  const config = await loadConfig(stateDir);
  return exportCoreTest({
    runId: input.runId,
    bugId: input.bugId,
    stateDir,
    config,
    generate: webTestGenerator,
    target: webExportTarget,
    runner: webTestRunner,
  });
}
