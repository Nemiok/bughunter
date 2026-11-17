import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type {
  FindingKinds, Reset, Session, SessionHandle, SweepVisit, TargetInventory,
} from './preset.ts';
import {
  findingPath, readFindings, readRun, recordTargetExploration, recordRunStage, writeFinding, writeJsonAtomic,
} from './run-store.ts';
import { signalSignature } from './signature.ts';
import type { Candidate, Finding, FindingDraft, Journal, SweepProgress } from './types.ts';

/** Персона обхода: журнал промоции — не исследование, и ростер персон здесь ни при чём. */
const sweepPersona = 'sweep';

export type SweepResult = {
  /** Цели, пройденные этим вызовом. */
  visited: string[];
  nextCursor?: number;
  findings: number;
  done: boolean;
  targets: number;
};

export type SweepOptions = {
  runId: string;
  stateDir: string;
  /** Сколько целей пройти за один вызов; без лимита — весь оставшийся инвентарь. */
  limit?: number;
  cursor?: number;
  inventory: TargetInventory;
  session: Session;
  visit: SweepVisit;
  reset: Reset;
  findingKinds: FindingKinds;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
 * Детерминированный обход инвентаря без модели: core ведёт курсор, чекпоинты и находки,
 * а пресет — дойти до цели, сбросить стенд, снять и сравнить. Курсор пишется после каждой
 * цели, поэтому прерванный обход продолжается, а не начинается заново.
 */
export async function runSweep(options: SweepOptions): Promise<SweepResult> {
  const stateDir = resolve(options.stateDir);
  const run = await readRun(options.runId, stateDir);
  if (run.scope !== 'sweep') throw new Error(`SWEEP_SCOPE_REQUIRED: ${run.scope}`);

  const all = await options.inventory.list(stateDir);
  if (all.length === 0) throw new Error('INVENTORY_EMPTY');
  const selected = run.targets.length > 0 ? all.filter((target) => run.targets.includes(target)) : all;
  if (selected.length === 0) throw new Error(`TARGETS_EMPTY: ${run.targets[0] ?? options.runId}`);

  const startedAt = new Date().toISOString();
  const progress = await readProgress(options.runId, stateDir)
    ?? { visited: [], cursor: 0, startedAt, updatedAt: startedAt };
  const start = options.cursor ?? progress.cursor;
  const slice = selected.slice(start, start + (options.limit ?? selected.length));

  const visited: string[] = [];
  let findings = 0;
  let resetReported = (await readFindings(options.runId, stateDir))
    .some((finding) => finding.kind === 'reset-unsupported');

  const record = async (draft: FindingDraft): Promise<void> => {
    await writeFinding({
      ...draft,
      id: randomUUID(),
      runId: options.runId,
      status: 'new',
      createdAt: new Date().toISOString(),
    }, stateDir);
    findings += 1;
  };

  // Сессия открывается только под непустой срез: обходить нечего — незачем и запускать стенд.
  let handle: SessionHandle | undefined;
  try {
    if (slice.length > 0) {
      handle = await options.session.open({
        runId: options.runId,
        target: slice[0]!,
        persona: sweepPersona,
        stateDir,
      });
      for (const [index, target] of slice.entries()) {
        try {
          if (!options.reset.supported) throw new Error('RESET_UNSUPPORTED');
          await options.reset.apply(handle);
        } catch (error) {
          // «Состояние не сброшено» и «сброшено» — разные утверждения о цели, но утверждение
          // относится к прогону, а не к каждой цели: одна находка на обход.
          if (!resetReported) {
            resetReported = true;
            await record({
              targetRef: target,
              kind: 'reset-unsupported',
              detail: messageOf(error),
              evidenceHashes: [],
            });
          }
        }
        for (const draft of await options.visit.visit({ target, handle, stateDir })) {
          // Словарь видов принадлежит пресету: находка вне словаря — ошибка пресета, а не данные.
          if (!options.findingKinds.kinds.includes(draft.kind)) {
            throw new Error(`FINDING_KIND_INVALID: ${draft.kind}`);
          }
          await record(draft);
        }

        progress.cursor = start + index + 1;
        progress.visited.push(target);
        progress.updatedAt = new Date().toISOString();
        await writeJsonAtomic(progressPath(options.runId, stateDir), progress);
        // Цель обработана (курсор сдвинут, находки записаны), поэтому она обязана попасть
        // и в ответ вызывающей стороне: иначе модель решит, что цель ещё не пройдена.
        visited.push(target);
        if (run.targets.length > 0) await recordTargetExploration(options.runId, target, 'done', stateDir);
      }
    }
  } finally {
    await handle?.close().catch(() => undefined);
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
    targets: selected.length,
    ...(done ? {} : { nextCursor: progress.cursor }),
  };
}

/**
 * Находка становится кандидатом вместе с синтетическим журналом из одного шага, который
 * строит пресет: без журнала находку нельзя ни воспроизвести, ни экспортировать, а общий
 * поток дальше обычный.
 */
export async function promoteFindingToCandidate(input: {
  runId: string;
  findingId: string;
  title: string;
  expected: string;
  actual: string;
  check?: Candidate['check'];
  stateDir: string;
  findingKinds: FindingKinds;
}): Promise<{ candidateId: string }> {
  const stateDir = resolve(input.stateDir);
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
  const { step, target } = await input.findingKinds.syntheticStep(finding, stateDir);
  const sessionId = `finding-${input.findingId.replaceAll('-', '').slice(0, 12)}`;
  const timestamp = new Date().toISOString();
  const journal: Journal = {
    sessionId,
    runId: input.runId,
    target,
    persona: sweepPersona,
    steps: [step],
    createdAt: timestamp,
  };
  const runDirectory = join(stateDir, 'runs', input.runId);
  await writeJsonAtomic(join(runDirectory, 'journals', `${sessionId}.json`), journal);

  const candidateId = randomUUID();
  const candidate: Candidate = {
    id: candidateId,
    runId: input.runId,
    sessionId,
    target,
    title: input.title,
    expected: input.expected,
    actual: input.actual,
    signalIds: [],
    signature: signalSignature({
      kind: 'finding',
      message: `${finding.kind}: ${finding.targetRef}`,
      target: finding.targetRef,
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
