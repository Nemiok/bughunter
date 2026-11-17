import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

const KIMI_BIN = process.env.KIMI_BIN ?? 'kimi';

async function freePort() {
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const value = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return value;
}

export async function withKimiServer({ home, marketplace, project }, callback) {
  const bindPort = await freePort();
  const child = spawn(KIMI_BIN, ['web', '--no-open', '--host', '127.0.0.1', '--port', String(bindPort)], {
    cwd: project,
    env: { ...process.env, KIMI_CODE_HOME: home, KIMI_CODE_PLUGIN_MARKETPLACE_URL: marketplace },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (chunk) => { serverLog += chunk; });
  child.stderr.on('data', (chunk) => { serverLog += chunk; });
  const baseUrl = `http://127.0.0.1:${bindPort}`;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        if ((await fetch(`${baseUrl}/api/v1/healthz`)).ok) { ready = true; break; }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error(`KIMI_SERVER_NOT_READY: ${serverLog.slice(-2000)}`);
    const token = await readFile(join(home, 'server.token'), 'utf8');
    return await callback({ baseUrl, token: token.trim() });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000)),
      ]);
    }
  }
}

export async function kimiRequest(baseUrl, token, method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const envelope = await response.json();
  if (!response.ok || envelope.code !== 0) throw new Error(`KIMI_API_FAILED: ${path}: ${JSON.stringify(envelope)}`);
  return envelope.data;
}

export async function kimiProbe(baseUrl, token, method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return response.json();
}

export async function makeTempRoot(prefix) {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function removeTempRoot(root) {
  await rm(root, { recursive: true, force: true });
}

export function assertNoToken(value, label) {
  assert.equal(JSON.stringify(value).includes('server.token'), false, `${label} must not embed the token path`);
}

assert.equal(typeof withKimiServer, 'function');
assert.equal(typeof kimiRequest, 'function');
