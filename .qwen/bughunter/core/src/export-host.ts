import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

import { findProjectRoot } from './project.ts';
import type { ExportTarget, TestGenerator, TestRunner } from './preset.ts';
import { readCandidate, readRun, readSharedMemory, recordCandidateTest } from './run-store.ts';
import type { SharedMemoryEntry } from './run-store.ts';
import type { Candidate, Config, Journal } from './types.ts';

const safeIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

async function candidatesForRun(runId: string, stateDir: string): Promise<Candidate[]> {
  const directory = join(stateDir, 'runs', runId, 'candidates');
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return Promise.all(files.filter((file) => file.endsWith('.json')).map(async (file) =>
    JSON.parse(await readFile(join(directory, file), 'utf8')) as Candidate,
  ));
}

/**
 * Баг ищется и по идентификатору из общей памяти, и по идентификатору кандидата: модель
 * оперирует номерами багов, а хранятся они отдельно от кандидатов прогона.
 */
async function resolveExportCandidate(
  runId: string,
  bugId: string,
  stateDir: string,
): Promise<{ candidate: Candidate; known: SharedMemoryEntry }> {
  const knownBugs = await readSharedMemory('known-bugs.json', stateDir);
  const known = knownBugs.find((entry) => entry.id === bugId) ?? knownBugs.find((entry) => entry.sourceCandidate === bugId);
  if (known) {
    const candidates = await candidatesForRun(runId, stateDir);
    const matches = candidates.filter((candidate) => candidate.signature === known.signature && candidate.runId === runId);
    const candidate = matches.find((value) => value.id === known.sourceCandidate)
      ?? matches.sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    if (!candidate) throw new Error(`BUG_NOT_FOUND: ${bugId}`);
    return { candidate, known };
  }
  const candidate = await readCandidate(runId, bugId, stateDir);
  const bySignature = knownBugs.find((entry) => entry.signature === candidate.signature);
  if (!bySignature) throw new Error(`BUG_NOT_CONFIRMED: ${bugId}`);
  return { candidate, known: bySignature };
}

/**
 * Ближайший проект, которому принадлежит генерируемый тест: без него файл некому запустить.
 * Признак «проект наш» знает пресет (`runner.ownsProject`), core только обходит каталоги.
 */
async function nearestOwnedProject(runner: TestRunner): Promise<string | undefined> {
  let root: string;
  try {
    root = await findProjectRoot();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('PROJECT_ROOT_NOT_FOUND:')) return undefined;
    throw error;
  }
  let directory = process.cwd();
  const filesystemRoot = parse(directory).root;
  while (true) {
    let packageJson: unknown;
    try {
      packageJson = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (packageJson !== undefined && runner.ownsProject(packageJson)) return directory;
    if (directory === root || directory === filesystemRoot) return undefined;
    directory = dirname(directory);
  }
}

/**
 * Запись ровно один раз: сгенерированный тест может быть доработан человеком, и молчаливая
 * перезапись уничтожила бы его правки. Побайтово совпадающий файл — не ошибка.
 */
async function writeOnce(file: string, source: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  try {
    const existing = await readFile(file, 'utf8');
    if (existing !== source) throw new Error(`EXPORT_FILE_EXISTS: ${file}`);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    await writeFile(file, source, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`EXPORT_FILE_EXISTS: ${file}`);
    throw error;
  }
}

async function journalTarget(candidate: Candidate, stateDir: string): Promise<string> {
  let journal: Journal;
  try {
    journal = JSON.parse(await readFile(
      join(stateDir, 'runs', candidate.runId, 'journals', `${candidate.sessionId}.json`),
      'utf8',
    )) as Journal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`JOURNAL_NOT_FOUND: ${candidate.sessionId}`);
    throw error;
  }
  if (journal.runId !== candidate.runId || journal.sessionId !== candidate.sessionId) {
    throw new Error(`JOURNAL_MISMATCH: ${candidate.sessionId}`);
  }
  return journal.target;
}

export type ExportInput = {
  runId: string;
  bugId: string;
  stateDir: string;
  config: Config;
  generate: TestGenerator;
  target: ExportTarget;
  runner: TestRunner;
};

/**
 * Размещение сгенерированного теста: проверить право экспорта, построить источник хуком пресета,
 * выбрать каталог, защититься от выхода за его пределы, записать один раз и отметить кандидата.
 * Текст теста и каталог назначения — знание пресета, порядок и гарантии — core.
 */
export async function exportTest(input: ExportInput): Promise<{ file: string; placedInProject: boolean }> {
  const stateDir = resolve(input.stateDir);
  await readRun(input.runId, stateDir);
  const { candidate, known } = await resolveExportCandidate(input.runId, input.bugId, stateDir);
  if (typeof known.id !== 'string' || !safeIdPattern.test(known.id) || known.id === '.' || known.id === '..') {
    throw new Error(`BUG_ID_INVALID: ${known.id}`);
  }
  if (candidate.status !== 'confirmed') throw new Error(`BUG_NOT_CONFIRMED: ${input.bugId}`);
  if (candidate.reproduction?.status !== 'reproduced') throw new Error(`CANDIDATE_UNREPRODUCED: ${candidate.id}`);

  const initialTarget = await journalTarget(candidate, stateDir);
  const source = await input.generate.generate({ candidate, initialTarget, stateDir });
  const project = await nearestOwnedProject(input.runner);
  // Вне проекта тест остаётся в каталоге прогона: его нельзя запустить, но и потерять нельзя.
  const destination = project
    ? resolve(project, input.target.dir(input.config))
    : resolve(stateDir, 'runs', input.runId, input.target.kind);
  const file = resolve(destination, input.target.fileName(known.id));
  const relativeFile = relative(destination, file);
  if (relativeFile === '..' || relativeFile.startsWith(`..${sep}`) || isAbsolute(relativeFile)) {
    throw new Error(`EXPORT_PATH_UNSAFE: ${file}`);
  }
  await writeOnce(file, source);
  await recordCandidateTest(input.runId, candidate.id, input.target.kind, file, stateDir);
  return { file, placedInProject: project !== undefined };
}
