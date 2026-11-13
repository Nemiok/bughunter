import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import type { Page } from 'playwright-core';
import { attachNetworkCapture } from './browser/network.ts';
import { describeScreen } from './browser/screen.ts';
import { resolveLaunchOptions } from './browser/session.ts';
import { loadConfig } from './config.ts';
import { signalSignature } from '@bughunter/core';
import { readScreens } from './discovery/screens-store.ts';
import { loadProfile } from './profile/load.ts';
import type { Profile } from './profile/types.ts';
import {
  findingPath, readFindings, readRun, recordRouteExploration, recordRunStage, writeFinding, writeJsonAtomic,
} from '@bughunter/core';
import type { Candidate, Check, Finding, Journal, SweepProgress } from '@bughunter/core';

export const defaultScreensPerSweep = 25;
export const defaultResponseSettleMs = 2_500;

import { defaultStateDir } from './paths.ts';

export type SweepResult = {
  /** Шаблоны экранов, пройденные этим вызовом. */
  visited: string[];
  nextCursor?: number;
  findings: number;
  done: boolean;
  screens: number;
};

/**
 * Возврат приложения к исходным данным перед экраном. Без рецепта профиля сброс невозможен,
 * и это видно в находках: «состояние не сброшено» и «сброшено» — разные утверждения об экране.
 */
export async function applyReset(page: Page, profile: Profile | null, baseUrl?: string): Promise<void> {
  const reset = profile?.reset;
  if (reset === undefined) throw new Error('RESET_UNSUPPORTED');
  if (reset.kind === 'storage-flag') {
    if (reset.key === undefined) throw new Error('RESET_UNSUPPORTED');
    // Флаг пишется в хранилище приложения, поэтому на about:blank сначала нужен переход на origin.
    if (page.url() === 'about:blank' && baseUrl !== undefined) {
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    }
    await page.evaluate((key) => {
      const marker = new Date().toISOString();
      try {
        localStorage.setItem(key, marker);
      } catch { /* приватный режим или закрытое хранилище */ }
      try {
        sessionStorage.setItem(key, marker);
      } catch { /* приватный режим или закрытое хранилище */ }
    }, reset.key);
    return;
  }
  if (reset.url === undefined) throw new Error('RESET_UNSUPPORTED');
  await page.evaluate(async (url) => {
    await fetch(url, { method: 'POST' });
  }, reset.url);
}

function progressPath(runId: string, stateDir: string): string {
  return join(stateDir, 'runs', runId, 'sweep.json');
}

async function readProgress(runId: string, stateDir: string): Promise<SweepProgress | null> {
  try {
    return JSON.parse(await readFile(progressPath(runId, stateDir), 'utf8')) as SweepProgress;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Детерминированный обход инвентаря без модели: сброс → переход → ожидание ответов → структура экрана.
 * Курсор пишется после каждого экрана, поэтому прерванный обход продолжается, а не начинается заново.
 */
export async function runSweep(options: {
  runId: string;
  stateDir: string;
  limit?: number;
  cursor?: number;
}): Promise<SweepResult> {
  const stateDir = resolve(options.stateDir);
  const config = await loadConfig(stateDir);
  const profile = config.profile === undefined ? null : await loadProfile(stateDir, config.profile);
  const run = await readRun(options.runId, stateDir);
  if (run.scope !== 'sweep' && run.scope !== 'screen') throw new Error(`SWEEP_SCOPE_REQUIRED: ${run.scope}`);

  const screens = await readScreens(stateDir);
  const selected = run.scope === 'screen'
    ? screens.filter((screen) => run.routes.includes(screen.template))
    : screens;
  if (selected.length === 0) {
    throw new Error(`SCREEN_NOT_FOUND: ${run.scope === 'screen' ? run.routes[0] ?? '' : 'пустой инвентарь — сначала bh_crawl'}`);
  }

  const startedAt = new Date().toISOString();
  const progress = await readProgress(options.runId, stateDir)
    ?? { visited: [], cursor: 0, startedAt, updatedAt: startedAt };
  const start = options.cursor ?? progress.cursor;
  const limit = options.limit ?? config.limits.screensPerSweep ?? defaultScreensPerSweep;
  const settleMs = config.limits.responseSettleMs ?? defaultResponseSettleMs;
  const slice = selected.slice(start, start + limit);

  const launch = resolveLaunchOptions(config, profile);
  const browser = await chromium.launch({
    channel: 'chrome',
    ...(launch.args.length > 0 ? { args: launch.args } : {}),
    ...(launch.proxy === undefined ? {} : { proxy: launch.proxy }),
  });
  const context = await browser.newContext({
    ...(launch.ignoreHTTPSErrors ? { ignoreHTTPSErrors: true } : {}),
  });
  const visited: string[] = [];
  let findings = 0;
  let resetReported = (await readFindings(options.runId, stateDir)).some((finding) => finding.kind === 'reset-unsupported');

  const record = async (finding: Omit<Finding, 'id' | 'runId' | 'status' | 'createdAt'>): Promise<void> => {
    await writeFinding({
      ...finding,
      id: randomUUID(),
      runId: options.runId,
      status: 'new',
      createdAt: new Date().toISOString(),
    }, stateDir);
    findings += 1;
  };

  try {
    const page = await context.newPage();
    const network = await attachNetworkCapture(page, {
      stateDir,
      runId: options.runId,
      allowedOrigins: config.allowedOrigins,
      ...(profile?.responseSource === undefined ? {} : { responseSource: profile.responseSource }),
    });
    try {
      for (const [index, screen] of slice.entries()) {
        const position = start + index;
        try {
          await applyReset(page, profile, config.baseUrl);
        } catch (error) {
          if (!resetReported) {
            resetReported = true;
            await record({
              screenTemplate: screen.template,
              kind: 'reset-unsupported',
              detail: error instanceof Error ? error.message : String(error),
              responseHashes: [],
            });
          }
        }
        try {
          await page.goto(screen.sampleUrl, { waitUntil: 'domcontentloaded', timeout: settleMs * 10 });
        } catch (error) {
          await record({
            screenTemplate: screen.template,
            kind: 'navigation-failed',
            detail: error instanceof Error ? error.message : String(error),
            responseHashes: [],
          });
          progress.cursor = position + 1;
          progress.visited.push(screen.template);
          progress.updatedAt = new Date().toISOString();
          await writeJsonAtomic(progressPath(options.runId, stateDir), progress);
          // Экран обработан (курсор сдвинут, находка записана), поэтому он обязан попасть
          // и в ответ вызывающей стороне: иначе модель решит, что экран ещё не пройден.
          visited.push(screen.template);
          continue;
        }
        await page.waitForLoadState('networkidle', { timeout: settleMs }).catch(() => undefined);
        await network.flush();
        const responses = network.takePending();
        const structure = await describeScreen(page, profile);
        for (const widget of structure.widgets) {
          if (widget.error === undefined) continue;
          await record({
            screenTemplate: screen.template,
            ...(widget.widget === undefined ? {} : { widget: widget.widget }),
            kind: 'extract-failed',
            detail: widget.error,
            responseHashes: [],
          });
        }
        const hashes = responses.map((response) => response.hash).filter((hash): hash is string => hash !== undefined);
        await record(hashes.length === 0 && responses.length === 0
          ? {
            screenTemplate: screen.template,
            kind: 'response-missing',
            detail: 'Экран не вернул ни одного ответа; сверка данных невозможна',
            responseHashes: [],
          }
          : {
            screenTemplate: screen.template,
            kind: 'response-captured',
            detail: `Ответов: ${responses.length}, с телом: ${hashes.length}`,
            responseHashes: hashes,
          });

        progress.cursor = position + 1;
        progress.visited.push(screen.template);
        progress.updatedAt = new Date().toISOString();
        // Чекпоинт после каждого экрана: прерывание длинного обхода не теряет пройденное.
        await writeJsonAtomic(progressPath(options.runId, stateDir), progress);
        visited.push(screen.template);
        if (run.scope === 'screen') await recordRouteExploration(options.runId, screen.template, 'done', stateDir);
      }
    } finally {
      await network.dispose().catch(() => undefined);
    }
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }

  const done = progress.cursor >= selected.length;
  if (done) {
    await recordRunStage(options.runId, 'sweep', 'done', stateDir);
    await recordRunStage(options.runId, 'findings', 'done', stateDir);
  }
  return {
    visited,
    findings,
    done,
    screens: selected.length,
    ...(done ? {} : { nextCursor: progress.cursor }),
  };
}

/**
 * Находка становится кандидатом вместе с синтетическим журналом из одного перехода:
 * без журнала её нельзя ни воспроизвести, ни экспортировать, а общий поток дальше обычный.
 */
export async function promoteFindingToCandidate(input: {
  runId: string;
  findingId: string;
  title: string;
  expected: string;
  actual: string;
  check?: Check;
  stateDir?: string;
}): Promise<{ candidateId: string }> {
  const stateDir = input.stateDir ? resolve(input.stateDir) : defaultStateDir;
  let finding: Finding;
  try {
    finding = JSON.parse(await readFile(findingPath(input.runId, input.findingId, stateDir), 'utf8')) as Finding;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`FINDING_NOT_FOUND: ${input.findingId}`);
    throw error;
  }
  if (finding.status === 'promoted' && finding.candidateId !== undefined) {
    return { candidateId: finding.candidateId };
  }
  const screen = (await readScreens(stateDir)).find((entry) => entry.template === finding.screenTemplate);
  const sample = screen?.sampleUrl ?? new URL(finding.screenTemplate.replaceAll(':id', '1'), 'https://screen.invalid').href;
  const target = new URL(sample);
  const route = `${target.pathname}${target.search}`;
  const sessionId = `finding-${input.findingId.replaceAll('-', '').slice(0, 12)}`;
  const timestamp = new Date().toISOString();
  const journal: Journal = {
    sessionId,
    runId: input.runId,
    route,
    persona: 'sweep',
    steps: [{
      id: randomUUID(),
      kind: 'navigate',
      timestamp,
      routeTemplate: finding.screenTemplate,
      path: route,
      signalIds: [],
    }],
    createdAt: timestamp,
  };
  const runDirectory = join(stateDir, 'runs', input.runId);
  await mkdir(join(runDirectory, 'journals'), { recursive: true });
  await mkdir(join(runDirectory, 'candidates'), { recursive: true });
  await writeJsonAtomic(join(runDirectory, 'journals', `${sessionId}.json`), journal);

  const candidateId = randomUUID();
  const candidate: Candidate = {
    id: candidateId,
    runId: input.runId,
    sessionId,
    route,
    title: input.title,
    expected: input.expected,
    actual: input.actual,
    signalIds: [],
    signature: signalSignature({
      kind: 'finding',
      message: `${finding.kind}: ${finding.screenTemplate}`,
      route: finding.screenTemplate,
    }),
    steps: journal.steps,
    artifacts: [],
    status: 'unprocessed',
    createdAt: timestamp,
    ...(input.check === undefined ? {} : { check: input.check }),
    reproduction: { status: 'unreproduced', attempts: 0 },
  };
  await writeJsonAtomic(join(runDirectory, 'candidates', `${candidateId}.json`), candidate);
  await writeFinding({ ...finding, status: 'promoted', candidateId }, stateDir);
  return { candidateId };
}
