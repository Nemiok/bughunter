import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { prepareFixture, waitForHttp } from './model-gate-fixture.mjs';

const repoRoot = resolve(import.meta.dirname, '../..');
const enabled = process.env.BH_FIXTURE_TEST === '1';

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

async function stop(child) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await once(child, 'exit');
}

test('web buggy-app serves the target route', { skip: !enabled }, async () => {
  const port = await freePort();
  const out = await mkdtemp(join(tmpdir(), 'bh-fixture-web-'));
  const { child, baseUrl } = await prepareFixture({
    fixture: join(repoRoot, '.qwen', 'bughunter', 'fixtures', 'buggy-app'),
    out, port, kind: 'web',
  });
  try {
    await waitForHttp(`${baseUrl}/`, child);
    const response = await fetch(`${baseUrl}/`);
    assert.equal(response.status, 200);
  } finally {
    await stop(child);
    await rm(out, { recursive: true, force: true });
  }
});

test('node node-api-app serves its health endpoint', { skip: !enabled }, async () => {
  const port = await freePort();
  const out = await mkdtemp(join(tmpdir(), 'bh-fixture-node-'));
  const { child, baseUrl } = await prepareFixture({
    fixture: join(repoRoot, '.qwen', 'bughunter', 'fixtures', 'node-api-app'),
    out, port, kind: 'node',
  });
  try {
    await waitForHttp(`${baseUrl}/health`, child);
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
  } finally {
    await stop(child);
    await rm(out, { recursive: true, force: true });
  }
});
