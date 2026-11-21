import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { TargetRef } from './preset.ts';
import { candidatePath, readRun, writeJsonAtomic } from './run-store.ts';
import type { Candidate, Check, StepBase } from './types.ts';

function oracleSignature(check: Check, target: TargetRef): string {
  const canonical = JSON.stringify([check.kind, check.target, check.expected ?? null, target]);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Сигнатура кандидата: один источник — сырая сигнатура симптома или оракул; оба источника
 * склеиваются, иначе два разных бага с общим симптомом схлопнулись бы в один.
 * Числа в `check` не нормализуются — иначе разные значения схлопнулись бы в одну сигнатуру.
 * `checkSignature` позволяет пресету учесть поля оракула, которых core не знает.
 */
export function candidateSignature(input: {
  signalSignature?: string;
  checkSignature?: string;
  check?: Check;
  target: TargetRef;
}): string {
  const oracle = input.checkSignature ?? (input.check === undefined ? undefined : oracleSignature(input.check, input.target));
  if (input.signalSignature === undefined) {
    if (oracle === undefined) throw new Error('CANDIDATE_ORACLE_REQUIRED');
    return oracle;
  }
  if (oracle === undefined) return input.signalSignature;
  return createHash('sha256')
    .update(JSON.stringify(['signal+oracle', input.signalSignature, oracle, input.target]))
    .digest('hex');
}

/**
 * Записи общей памяти читаются терпимо: в файлах встречаются и `id`, и устаревший `candidateId`,
 * поэтому форма здесь слабее строгого `SharedMemoryEntry`.
 */
type MemoryEntry = { id?: string; candidateId?: string; sourceCandidate?: string; signature?: string };

async function findKnownSignature(signature: string, stateDir: string): Promise<string | undefined> {
  for (const file of ['known-bugs.json', 'suppressions.json']) {
    let entries: MemoryEntry[];
    try {
      entries = JSON.parse(await readFile(join(stateDir, file), 'utf8')) as MemoryEntry[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!Array.isArray(entries)) throw new Error(`SHARED_MEMORY_INVALID: ${file}`);
    const match = entries.find((entry) => entry.signature === signature);
    const id = match?.id ?? match?.candidateId ?? match?.sourceCandidate;
    if (id) return id;
  }
  return undefined;
}

export async function reportCandidate(input: {
  runId: string;
  sessionId: string;
  target: TargetRef;
  title: string;
  expected: string;
  actual: string;
  steps: StepBase[];
  signalIds: string[];
  signalSignature?: string;
  checkSignature?: string;
  check?: Check;
  stateDir: string;
}): Promise<{ candidateId: string; duplicateOf?: string }> {
  let run;
  try {
    run = await readRun(input.runId, input.stateDir);
  } catch {}
  if (run?.status === 'finished') throw new Error('RUN_FINISHED');
  const signature = candidateSignature(input);
  const candidateId = randomUUID();
  const duplicateOf = await findKnownSignature(signature, input.stateDir);
  const candidate: Candidate = {
    id: candidateId,
    runId: input.runId,
    sessionId: input.sessionId,
    target: input.target,
    title: input.title,
    expected: input.expected,
    actual: input.actual,
    signalIds: [...input.signalIds],
    signature,
    ...(input.signalSignature === undefined ? {} : { signalSignature: input.signalSignature }),
    steps: input.steps,
    artifacts: [],
    status: 'unprocessed',
    createdAt: new Date().toISOString(),
    ...(input.check === undefined ? {} : { check: input.check }),
    ...(duplicateOf === undefined ? {} : { duplicateOf }),
    reproduction: { status: 'unreproduced', attempts: 0 },
  };
  await writeJsonAtomic(candidatePath(input.runId, candidateId, input.stateDir), candidate);
  return { candidateId, ...(duplicateOf === undefined ? {} : { duplicateOf }) };
}

/** Артефакты сессии становятся известны только при её закрытии, поэтому дописываются отдельным проходом. */
export async function attachCandidateArtifacts(input: {
  runId: string;
  candidateIds: string[];
  artifacts: string[];
  stateDir: string;
}): Promise<void> {
  for (const candidateId of input.candidateIds) {
    const path = candidatePath(input.runId, candidateId, input.stateDir);
    const candidate = JSON.parse(await readFile(path, 'utf8')) as Candidate;
    // Артефакты повтора уже могли быть записаны: закрытие сессии дополняет, а не затирает.
    const artifacts = [...new Set([...candidate.artifacts, ...input.artifacts])];
    await writeJsonAtomic(path, { ...candidate, artifacts });
  }
}
