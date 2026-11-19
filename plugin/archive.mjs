import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export function archiveSource({ url, sha256 }) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('ARCHIVE_URL_INVALID');
  }
  if (parsed.protocol !== 'https:') throw new Error('ARCHIVE_HTTPS_REQUIRED');
  if (!/^[a-f0-9]{64}$/i.test(sha256)) throw new Error('ARCHIVE_SHA256_INVALID');
  return { source: 'archive', url, sha256: sha256.toLowerCase() };
}

export async function verifyArchive(path, expectedSha256) {
  if (!/^[a-f0-9]{64}$/i.test(expectedSha256)) throw new Error('ARCHIVE_SHA256_INVALID');
  const actual = createHash('sha256').update(await readFile(path)).digest('hex');
  if (actual !== expectedSha256.toLowerCase()) {
    throw new Error(`ARCHIVE_SHA256_MISMATCH: expected ${expectedSha256}, got ${actual}`);
  }
  return actual;
}
