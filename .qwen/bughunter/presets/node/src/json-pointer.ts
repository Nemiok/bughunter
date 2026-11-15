/**
 * Чтение значения из JSON-ответа по указателю. Поддержаны обе записи: `$.a.b[0].c` (так оракулы
 * пишут в тестах) и `/a/b/0/c` (RFC 6901 — так сценарии обхода объявлены в конфиге). Без зависимостей.
 */
export function readPointer(value: unknown, pointer: string): unknown {
  let current = value;
  for (const segment of parsePointer(pointer)) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) throw new Error(`POINTER_NOT_FOUND: ${pointer}`);
      const index = Number(segment);
      if (index >= current.length) throw new Error(`POINTER_NOT_FOUND: ${pointer}`);
      current = current[index];
      continue;
    }
    if (current === null || typeof current !== 'object') throw new Error(`POINTER_NOT_FOUND: ${pointer}`);
    const record = current as Record<string, unknown>;
    if (!Object.hasOwn(record, segment)) throw new Error(`POINTER_NOT_FOUND: ${pointer}`);
    current = record[segment];
  }
  return current;
}

function parsePointer(pointer: string): string[] {
  const trimmed = pointer.trim();
  if (trimmed.startsWith('$')) return parseDotted(trimmed.slice(1), pointer);
  if (trimmed.startsWith('/')) {
    return trimmed.slice(1).split('/').map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
  }
  throw new Error(`POINTER_INVALID: ${pointer}`);
}

function parseDotted(path: string, pointer: string): string[] {
  const pattern = /(?:^|\.)([^.[\]]+)|\[(?:"([^"]*)"|'([^']*)'|(\d+))\]/g;
  const segments: string[] = [];
  let consumed = 0;
  for (const match of path.matchAll(pattern)) {
    consumed = (match.index ?? 0) + match[0].length;
    const segment = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (segment === undefined) throw new Error(`POINTER_INVALID: ${pointer}`);
    segments.push(segment);
  }
  if (consumed !== path.length) throw new Error(`POINTER_INVALID: ${pointer}`);
  return segments;
}
