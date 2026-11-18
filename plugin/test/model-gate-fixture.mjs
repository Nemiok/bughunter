import { spawn, spawnSync } from 'node:child_process';
import { cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function prepareFixture({ fixture, out, port, kind = 'web' }) {
  if (!['web', 'node'].includes(kind)) throw new Error(`FIXTURE_KIND_INVALID: ${kind}`);
  await mkdir(out, { recursive: true });
  await cp(fixture, out, {
    recursive: true,
    filter: (source) => !source.split(/[\\/]/).includes('node_modules'),
  });
  for (const args of [['init', '-b', 'main'], ['add', '.']]) {
    const result = spawnSync('git', args, { cwd: out, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
  }
  const install = spawnSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: out, stdio: 'inherit' });
  if (install.status !== 0) throw new Error('FIXTURE_NPM_CI_FAILED');
  const args = kind === 'web'
    ? [join(out, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort']
    : [join(out, 'src', 'server.js')];
  const child = spawn(process.execPath, args, {
    cwd: out,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { child, baseUrl: `http://127.0.0.1:${port}` };
}

export async function waitForHttp(url, child, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`FIXTURE_EXITED: ${url}`);
    try {
      const response = await fetch(url);
      if (response.status === 200) return;
    } catch {}
    await delay(100);
  }
  throw new Error(`FIXTURE_TIMEOUT: ${url}`);
}
