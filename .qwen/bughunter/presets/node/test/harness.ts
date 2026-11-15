import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { writeJsonAtomic } from '@bughunter/core';

import { nodeConfigTemplate } from '../src/config.ts';
import type { NodeConfig } from '../src/config.ts';

const presetRoot = resolve(import.meta.dirname, '..');
const fixtureRoot = resolve(presetRoot, '../../fixtures/node-api-app');

export type Fixture = { baseUrl: string; port: number; stop(): Promise<void> };

/** Свободный порт: слушаем ноль и забираем выданный, чтобы тесты не спорили за фиксированные. */
export async function freePort(host = '127.0.0.1'): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, host, done));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}

/** Поднимает `fixtures/node-api-app` дочерним процессом и ждёт строку готовности `listening <port>`. */
export async function startFixture(): Promise<Fixture> {
  const port = await freePort();
  const child = spawn(process.execPath, [join(fixtureRoot, 'src/server.js')], {
    cwd: fixtureRoot,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`FIXTURE_START_TIMEOUT: ${port}`)), 15_000);
    const onExit = (code: number | null) => {
      clearTimeout(timer);
      fail(new Error(`FIXTURE_EXITED: ${code}`));
    };
    let buffer = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      if (/^listening \d+$/m.test(buffer)) {
        clearTimeout(timer);
        child.removeListener('exit', onExit);
        done();
      }
    });
    child.once('exit', onExit);
  });

  let stopped = false;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      if (child.exitCode !== null) return;
      const exited = new Promise<void>((done) => child.once('exit', () => done()));
      child.kill('SIGTERM');
      await Promise.race([exited, new Promise<void>((done) => setTimeout(done, 3_000))]);
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}

export type FixtureState = {
  stateDir: string;
  config: NodeConfig;
  cleanup(): Promise<void>;
};

export type VitestProject = { root: string; cleanup(): Promise<void> };

/**
 * Проект с vitest во временном каталоге: нужен, чтобы запускать сгенерированные тесты настоящим
 * раннером, не загрязняя ни фикстуру, ни дерево разработки.
 */
export async function vitestProject(): Promise<VitestProject> {
  const root = await mkdtemp(join(tmpdir(), 'bh-node-vitest-'));
  await cp(join(fixtureRoot, '../vitest-project/node_modules'), join(root, 'node_modules'), {
    recursive: true,
    mode: constants.COPYFILE_FICLONE,
  });
  await writeFile(join(root, 'package.json'), `${JSON.stringify({
    name: 'bh-node-generated',
    private: true,
    type: 'module',
    devDependencies: { vitest: '^3.2.4' },
  }, null, 2)}\n`, 'utf8');
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/**
 * Каталог состояния под фикстуру: конфиг с адресом стенда и копия поставляемого профиля, чтобы
 * инвентарь целей был настоящим, а не выдуманным тестом.
 */
export async function stateForFixture(
  baseUrl: string,
  patch?: (config: NodeConfig) => void,
): Promise<FixtureState> {
  const stateDir = await mkdtemp(join(tmpdir(), 'bh-node-state-'));
  const config = nodeConfigTemplate();
  config.baseUrl = baseUrl;
  config.allowedHosts = [new URL(baseUrl).hostname];
  patch?.(config);
  await writeJsonAtomic(join(stateDir, 'config.json'), config);
  await mkdir(join(stateDir, 'profiles', config.profile), { recursive: true });
  await copyFile(
    join(presetRoot, 'state', 'profiles', config.profile, 'index.ts'),
    join(stateDir, 'profiles', config.profile, 'index.ts'),
  );
  return {
    stateDir,
    config,
    cleanup: async () => {
      await rm(stateDir, { recursive: true, force: true });
    },
  };
}
