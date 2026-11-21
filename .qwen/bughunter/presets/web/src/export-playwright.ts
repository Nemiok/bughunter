import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { exportTest as exportCoreTest } from '@bughunter/core';
import type { Candidate, ExportTarget, TestGenerator } from '@bughunter/core';
import type { WebConfig as Config } from './config.ts';
import type { WebCheck } from './checks.ts';
import type { Step } from './types.ts';

import { isValidScroll, scrollDeltas } from './browser/point.ts';
import { loadConfig } from './config.ts';
import { defaultStateDir } from './paths.ts';
import { loadActiveProfile, resolveTestDataFile } from './profile/load.ts';
import type { Profile, ResetRecipe } from './profile/types.ts';
import { webTestRunner } from './test-runner.ts';

/** Предусловия сессии, которые экспортированный тест обязан наследовать. */
export type ExportPreconditions = { storageStatePath?: string; reset?: ResetRecipe };

function preconditionSetup(preconditions: ExportPreconditions | undefined, config: Config): { use: string; body: string } {
  const use = preconditions?.storageStatePath === undefined ? '' :
    `test.use({ storageState: process.env.BH_STORAGE_STATE ?? ${JSON.stringify(preconditions.storageStatePath)} });\n`;
  let body = '';
  const reset = preconditions?.reset;
  if (reset?.kind === 'mock-endpoint' && reset.url !== undefined) {
    body += `  const resetResponse = await page.request.post(new URL(${JSON.stringify(reset.url)}, ${JSON.stringify(config.baseUrl)}).href);\n  expect(resetResponse.ok()).toBeTruthy();\n`;
  } else if (reset?.kind === 'storage-flag' && reset.key !== undefined) {
    body += `  await page.addInitScript((key) => { try { localStorage.setItem(key, new Date().toISOString()); sessionStorage.setItem(key, new Date().toISOString()); } catch { /* закрытое хранилище */ } }, ${JSON.stringify(reset.key)});\n`;
  }
  return { use, body };
}

const jsonString = '"(?:\\\\.|[^"\\\\])*"';

function allowedUrl(path: string, config: Config): string {
  let target: URL;
  try {
    target = new URL(path, config.baseUrl);
  } catch {
    throw new Error(`TARGET_NOT_ALLOWED: ${path}`);
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
  if (!allowed) throw new Error(`TARGET_NOT_ALLOWED: ${path}`);
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

function stepsOf(candidate: Candidate): Step[] {
  return ((candidate as Candidate & { minimalSteps?: Step[] }).minimalSteps ?? candidate.steps) as Step[];
}

/** Обработчик диалогов в тесте нужен только кандидату, чьи шаги их видели. */
function dialogSetupSource(steps: Step[]): string {
  const usesDialogs = steps.some((step) => step.dialog !== undefined || (step.dialogs?.length ?? 0) > 0);
  if (!usesDialogs) return '';
  return `  let dialogPolicy: 'accept' | 'dismiss' = 'dismiss';
  page.on('dialog', (dialog) => { if (dialogPolicy === 'accept') void dialog.accept(); else void dialog.dismiss(); });
`;
}

/**
 * Signal-тест обязан матчить и диалоговый симптом: без этого экспортированная регрессия
 * зелёная на живом баге, а прогон не завершить (red-вердикт недостижим).
 */
function dialogSignalSetupSource(candidateSignature: string): string {
  return `  let dialogPolicy: 'accept' | 'dismiss' = 'dismiss';
  page.on('dialog', (dialog) => {
    if (signature({ kind: 'dialog', message: \`\${dialog.type()}: \${dialog.message()}\`, target: route() }) === ${candidateSignature}) matched = true;
    if (dialogPolicy === 'accept') void dialog.accept(); else void dialog.dismiss();
  });
`;
}

function replaySource(candidate: Candidate, config: Config, profile: Profile | null): string {
  const steps = stepsOf(candidate);
  const usesDialogs = steps.some((step) => step.dialog !== undefined || (step.dialogs?.length ?? 0) > 0);
  return steps.map((step) => {
    if (step.kind === 'act') {
      const policy = usesDialogs ? `  dialogPolicy = ${JSON.stringify(step.dialog ?? 'dismiss')};\n` : '';
      // Политика принадлежит действию: после шага она сброшена, как в сессии.
      const reset = usesDialogs ? `  dialogPolicy = ${JSON.stringify('dismiss')};\n` : '';
      return `${policy}  ${actionSource(step, profile)}\n${reset}`;
    }
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
  const check = candidate.check as WebCheck;
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

function signalSource(candidate: Candidate, config: Config, initialRoute: string, replay: string, setup: { use: string; body: string }): string {
  const signature = JSON.stringify(candidate.signature);
  return `import { createHash } from 'node:crypto';
import { test, expect } from '@playwright/test';

${setup.use}test(${JSON.stringify(candidate.title)}, async ({ page }) => {
${setup.body}${dialogSignalSetupSource(signature)}  let matched = false;
  const normalize = (value: string): string => value
    .replace(/([?&][^=\\s&]+)=([^&\\s]*)/g, '$1=<value>')
    .replace(/\\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\b/gi, '<uuid>')
    .replace(/\\d+(?:\\.\\d+)?/g, (match: string, offset: number, source: string) => /[vV]$/.test(source.slice(0, offset)) || /HTTP $/i.test(source.slice(0, offset)) ? match : '<number>')
    .replace(/\\s+/g, ' ')
    .trim();
  const signature = (input: { kind: string; message: string; target: string; stack?: string }): string => {
    const topFrame = input.stack?.split('\\n').find((line) => /^\\s*at\\s+/.test(line)) ?? '';
    return createHash('sha256').update([input.kind, normalize(input.message), normalize(input.target), normalize(topFrame)].join('\\n')).digest('hex');
  };
  const route = (): string => {
    try {
      return new URL(page.url()).pathname;
    } catch {
      return page.url();
    }
  };
  page.on('pageerror', (error) => {
    if (signature({ kind: 'pageerror', message: error.message, target: route(), ...(error.stack === undefined ? {} : { stack: error.stack }) }) === ${signature}) matched = true;
  });
  page.on('console', (message) => {
    if (message.type() === 'error' && signature({ kind: 'console', message: message.text(), target: route() }) === ${signature}) matched = true;
  });
  page.on('requestfailed', (request) => {
    const url = request.url();
    const reason = request.failure()?.errorText ?? 'Request failed';
    if (signature({ kind: 'requestfailed', message: \`\${request.method()} \${url}: \${reason}\`, target: route() }) === ${signature}) matched = true;
  });
  page.on('response', (response) => {
    const status = response.status();
    const url = response.url();
    if (status >= 400 && signature({ kind: 'response', message: \`\${response.request().method()} \${url}: HTTP \${status}\`, target: route() }) === ${signature}) matched = true;
  });
  const observedAnomalies: Array<{ text: string; target: string }> = [];
  await page.exposeFunction('__bughunterReportAnomalies', (entries: Array<{ text: string; target: string }>) => {
    for (const entry of entries) observedAnomalies.push(entry);
  });
  await page.addInitScript((anomalyTexts: string[]) => {
    const target = window as unknown as Window & {
      __bughunterAnomalyObserver?: MutationObserver;
      __bughunterSeenAnomalies?: Set<string>;
      __bughunterReportAnomalies: (entries: Array<{ text: string; target: string }>) => void;
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
        target.__bughunterReportAnomalies([{ text: token, target: observedRoute }]);
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
    if (text.length > 0 && new RegExp(\`(?<![\\\\p{L}\\\\p{N}_])\${escaped}(?![\\\\p{L}\\\\p{N}_])\`, 'u').test(bodyText) && signature({ kind: 'anomaly', message: text, target: route() }) === ${signature}) matched = true;
  }
  for (const entry of observedAnomalies) {
    if (signature({ kind: 'anomaly', message: entry.text, target: entry.target }) === ${signature}) matched = true;
  }
  const boundaries = page.locator(${JSON.stringify(config.detectors.errorBoundarySelector)});
  for (let index = 0; index < await boundaries.count(); index += 1) {
    const boundary = boundaries.nth(index);
    if (await boundary.isVisible()) {
      const text = (await boundary.innerText()).trim() || ${JSON.stringify(config.detectors.errorBoundarySelector)};
      if (signature({ kind: 'errorBoundary', message: text, target: route() }) === ${signature}) matched = true;
    }
  }
  expect(matched).toBe(false);
});
`;
}

export function generatePlaywrightTest(
  candidate: Candidate,
  config: Config,
  initialRoute = candidate.target,
  profile: Profile | null = null,
  preconditions?: ExportPreconditions,
): string {
  allowedUrl(initialRoute, config);
  const replay = replaySource(candidate, config, profile);
  for (const step of stepsOf(candidate)) {
    if (step.kind === 'navigate' && step.path) allowedUrl(step.path, config);
  }
  const setup = preconditionSetup(preconditions, config);
  if (candidate.signalIds.length > 0) return signalSource(candidate, config, initialRoute, replay, setup);
  return `import { test, expect } from '@playwright/test';

${setup.use}test(${JSON.stringify(candidate.title)}, async ({ page }) => {
${setup.body}${dialogSetupSource(stepsOf(candidate))}  await page.goto(new URL(${JSON.stringify(initialRoute)}, ${JSON.stringify(config.baseUrl)}).href, { waitUntil: 'domcontentloaded' });
${replay}  ${checkAssertion(candidate)}
});
`;
}

/** Каталог назначения: сгенерированный тест живёт там, где его запустит раннер пресета. */
export const webExportTarget: ExportTarget = {
  dir: (config) => config.tests.generated.dir,
  kind: 'e2e',
  fileName: (bugId) => `${bugId}.spec.ts`,
};

export const webTestGenerator: TestGenerator = {
  async generate({ candidate, initialTarget, stateDir }) {
    const [config, profile] = await Promise.all([loadConfig(stateDir), loadActiveProfile(stateDir)]);
    const storageStatePath = join(stateDir, 'auth', 'storage-state.json');
    let auth: string | undefined;
    try {
      await access(storageStatePath);
      auth = storageStatePath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return generatePlaywrightTest(candidate, config, initialTarget, profile, {
      ...(auth === undefined ? {} : { storageStatePath: auth }),
      ...(profile?.reset === undefined ? {} : { reset: profile.reset }),
    });
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
