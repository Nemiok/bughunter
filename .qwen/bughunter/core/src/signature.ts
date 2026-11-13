import { createHash } from 'node:crypto';

export type SignatureInput = {
  kind: string;
  message: string;
  route: string;
  stack?: string;
};

/**
 * Нормализация убирает изменчивое (числа, uuid, значения query-параметров), чтобы один и тот же
 * симптом на разных данных давал одну сигнатуру, а разные поля и значения — разные.
 */
export function normalizeMessage(message: string): string {
  return message
    .replace(/([?&][^=\s&]+)=([^&\s]*)/g, '$1=<value>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\d+(?:\.\d+)?/g, '<number>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function signalSignature(input: SignatureInput): string {
  const topFrame = input.stack?.split('\n').find((line) => /^\s*at\s+/.test(line)) ?? '';
  const value = [
    input.kind,
    normalizeMessage(input.message),
    normalizeMessage(input.route),
    normalizeMessage(topFrame),
  ].join('\n');
  return createHash('sha256').update(value).digest('hex');
}
