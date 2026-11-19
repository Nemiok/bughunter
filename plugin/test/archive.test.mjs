import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { archiveSource, verifyArchive } from '../archive.mjs';
import { buildQwenArchiveMarketplace } from '../marketplace.mjs';

test('public qwen catalog pins an HTTPS archive and payload commit', async () => {
  const marketplaceRoot = await mkdtemp(join(tmpdir(), 'bh-archive-market-'));
  const sha256 = 'a'.repeat(64);
  const payloadCommit = 'b'.repeat(40);
  await buildQwenArchiveMarketplace({
    marketplaceRoot, version: '0.2.0', payloadCommit,
    archiveUrl: 'https://github.com/acme/bughunter/releases/download/0.2.0/bughunter-qwen.zip',
    sha256, repository: 'acme/bughunter',
  });
  const catalog = JSON.parse(await readFile(join(marketplaceRoot, '.claude-plugin', 'marketplace.json'), 'utf8'));
  assert.deepEqual(catalog.plugins[0].source, {
    source: 'archive',
    url: 'https://github.com/acme/bughunter/releases/download/0.2.0/bughunter-qwen.zip',
    sha256,
  });
  assert.equal(catalog.plugins[0].metadata.payloadCommit, payloadCommit);
  assert.equal(catalog.plugins[0].repository, 'https://github.com/acme/bughunter');
});

test('archive source rejects HTTP and malformed hashes', () => {
  assert.throws(
    () => archiveSource({ url: 'http://example.com/bughunter.zip', sha256: 'a'.repeat(64) }),
    /ARCHIVE_HTTPS_REQUIRED/,
  );
  assert.throws(
    () => archiveSource({ url: 'https://example.com/bughunter.zip', sha256: 'bad' }),
    /ARCHIVE_SHA256_INVALID/,
  );
  assert.throws(
    () => archiveSource({ url: 'not a url', sha256: 'a'.repeat(64) }),
    /ARCHIVE_URL_INVALID/,
  );
});

test('verifyArchive rejects a one-byte change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bh-archive-hash-'));
  const file = join(root, 'bughunter.zip');
  await writeFile(file, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const { createHash } = await import('node:crypto');
  const expected = createHash('sha256').update(await readFile(file)).digest('hex');
  await verifyArchive(file, expected);
  await writeFile(file, Buffer.from([0x50, 0x4b, 0x03, 0x05]));
  await assert.rejects(verifyArchive(file, expected), /ARCHIVE_SHA256_MISMATCH/);
});
