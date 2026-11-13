import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { writeJsonAtomic } from '../run-store.ts';
import type { ScreenEntry } from '@bughunter/core';

/** Сегмент, похожий на идентификатор записи: hex-uuid, числа, длинные цифры. */
export const defaultIdSegmentPattern = '^[0-9a-fA-F]{8,}$|^\\d+$';

export type ScreensUpsertResult = { added: number; updated: number; total: number };

function screensPath(stateDir: string): string {
  return join(stateDir, 'screens.json');
}

/**
 * `/orders/7f3ab4c9` и `/orders/12` — один экран `/orders/:id`. Без шаблонизации инвентарь
 * приложения с сотнями сущностей состоял бы из тысяч записей и не годился бы для обхода.
 */
export function templatisedPathname(pathname: string, idSegmentPattern: string = defaultIdSegmentPattern): string {
  let matcher: RegExp;
  try {
    matcher = new RegExp(idSegmentPattern);
  } catch (error) {
    throw new Error(`PROFILE_INVALID: navigation.idSegmentPattern: ${error instanceof Error ? error.message : String(error)}`);
  }
  return pathname
    .split('/')
    .map((segment) => (segment.length > 0 && matcher.test(segment) ? ':id' : segment))
    .join('/');
}

export async function readScreens(stateDir: string): Promise<ScreenEntry[]> {
  const file = screensPath(stateDir);
  let source: string;
  try {
    source = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    // Инвентарь — накопленное знание о приложении: молча перезаписать его означало бы потерять
    // всё, что найдено предыдущими обходами.
    throw new Error(`SCREENS_STORE_CORRUPT: ${file}`);
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'object' || entry === null
    || typeof (entry as ScreenEntry).template !== 'string')) {
    throw new Error(`SCREENS_STORE_CORRUPT: ${file}`);
  }
  return parsed as ScreenEntry[];
}

const locks = new Map<string, Promise<unknown>>();

/** Read-modify-write инвентаря внутри процесса идёт последовательно: параллельные обходы не теряют записи. */
function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous.then(work, work);
  locks.set(key, run.then(() => undefined, () => undefined));
  return run;
}

export function upsertScreens(stateDir: string, entries: ScreenEntry[]): Promise<ScreensUpsertResult> {
  const key = resolve(stateDir);
  return serialized(key, async () => {
    const existing = await readScreens(stateDir);
    const byTemplate = new Map(existing.map((entry) => [entry.template, entry]));
    let added = 0;
    let updated = 0;
    for (const entry of entries) {
      const previous = byTemplate.get(entry.template);
      if (previous === undefined) {
        byTemplate.set(entry.template, entry);
        added += 1;
        continue;
      }
      const merged: ScreenEntry = {
        ...previous,
        sampleUrl: entry.sampleUrl,
        discoveredVia: [...new Set([...previous.discoveredVia, ...entry.discoveredVia])],
        widgets: [...new Set([...previous.widgets, ...entry.widgets])],
        lastCheckedAt: entry.lastCheckedAt ?? previous.lastCheckedAt,
        ...(entry.cursorState === undefined ? {} : { cursorState: entry.cursorState }),
      };
      const changed = merged.sampleUrl !== previous.sampleUrl
        || merged.lastCheckedAt !== previous.lastCheckedAt
        || merged.cursorState !== previous.cursorState
        || merged.widgets.join('|') !== previous.widgets.join('|')
        || merged.discoveredVia.join('|') !== previous.discoveredVia.join('|');
      if (changed) updated += 1;
      byTemplate.set(entry.template, merged);
    }
    const all = [...byTemplate.values()];
    await writeJsonAtomic(screensPath(stateDir), all);
    return { added, updated, total: all.length };
  });
}
