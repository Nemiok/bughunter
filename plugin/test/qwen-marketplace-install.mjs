import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { withMcpClient } from './mcp-client.mjs';
import { qwenInit, summarize } from './qwen-harness.mjs';

const pluginRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(pluginRoot, '..');
const dist = join(pluginRoot, 'dist', 'bughunter');
const qwen = process.env.QWEN_BIN ?? 'qwen';
const root = await mkdtemp(join(tmpdir(), 'bh-qwen-market-install-'));
const configDir = join(root, 'config');
const project = join(root, 'project');
const marketplaceRoot = join(root, 'marketplace');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', cwd: options.cwd, env: { ...process.env, ...options.env } });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} → ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function qwenArgs(...rest) {
  return ['--config-dir', configDir, ...rest];
}

try {
  run(process.execPath, [join(pluginRoot, 'build.mjs')], { cwd: pluginRoot });
  assert.ok(existsSync(join(dist, 'server', 'mcp.mjs')), 'build must produce the plugin server');
  assert.ok(existsSync(join(pluginRoot, 'dist', 'qwen-marketplace', '.claude-plugin', 'marketplace.json')), 'build must produce dist/qwen-marketplace');
  await cp(join(pluginRoot, 'dist', 'qwen-marketplace'), marketplaceRoot, { recursive: true });

  await mkdir(configDir, { recursive: true });
  await mkdir(join(project, '.qwen'), { recursive: true });
  await writeFile(join(configDir, 'settings.json'), `${JSON.stringify({
    providers: {
      deepseek: {
        protocol: 'openai',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-dummy-key-not-used',
        displayName: 'DeepSeek',
        models: [{ model: 'deepseek-chat', displayName: 'DeepSeek Chat', contextWindow: 128000 }],
      },
    },
    model: { name: 'deepseek/deepseek-chat' },
    permissions: { trustDirectories: [project] },
  }, null, 2)}\n`);
  await writeFile(join(project, '.qwen', 'settings.json'), `${JSON.stringify({
    permissions: { allow: ['mcp__bughunter__*', 'Read'] },
  }, null, 2)}\n`);

  run(qwen, qwenArgs('plugins', 'marketplace', 'add', marketplaceRoot));
  run(qwen, qwenArgs('plugins', 'install', 'bughunter@bughunter-market', '--json'));
  const installed = JSON.parse(run(qwen, qwenArgs('plugins', 'list', '--json')).stdout);
  assert.equal(installed.find((plugin) => plugin.id === 'bughunter@bughunter-market').enabled, true);

  const dormant = summarize(await qwenInit({ qwen, configDir, project }));
  assert.deepEqual(dormant.mcp, ['bughunter:connected']);
  assert.deepEqual(dormant.bhTools, ['mcp__bughunter__bh_setup']);

  const setup = await withMcpClient(join(marketplaceRoot, 'plugins', 'bughunter', 'server'), project, (client) =>
    client.callTool({ name: 'bh_setup', arguments: { preset: 'web' } }));
  assert.equal(setup.isError, undefined);
  const configPath = JSON.parse(setup.content[0].text).configPath;
  await writeFile(configPath, '{"sentinel":"preserve-me"}\n');
  await mkdir(join(project, '.qwen', 'bughunter', 'state', 'web', 'runs'), { recursive: true });
  await writeFile(join(project, '.qwen', 'bughunter', 'state', 'web', 'runs', 'sentinel.json'), '{}\n');
  await mkdir(join(project, '.qwen', 'bughunter', 'state', 'web', 'auth'), { recursive: true });
  await writeFile(join(project, '.qwen', 'bughunter', 'state', 'web', 'auth', 'README'), 'not-a-credential\n');

  const pluginManifestPath = join(marketplaceRoot, 'plugins', 'bughunter', '.claude-plugin', 'plugin.json');
  const pluginManifest = JSON.parse(await readFile(pluginManifestPath, 'utf8'));
  pluginManifest.version = '0.1.1-test.1';
  await writeFile(pluginManifestPath, `${JSON.stringify(pluginManifest, null, 2)}\n`);
  const catalogPath = join(marketplaceRoot, '.claude-plugin', 'marketplace.json');
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  catalog.plugins[0].version = '0.1.1-test.1';
  await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

  run(qwen, qwenArgs('plugins', 'marketplace', 'update', 'bughunter-market'));
  run(qwen, qwenArgs('plugins', 'update', 'bughunter@bughunter-market'));
  const updated = JSON.parse(run(qwen, qwenArgs('plugins', 'list', '--json')).stdout);
  assert.equal(updated.find((plugin) => plugin.id === 'bughunter@bughunter-market').version, '0.1.1-test.1');
  assert.equal(updated.find((plugin) => plugin.id === 'bughunter@bughunter-market').enabled, true);
  const statePreserved = (await readFile(configPath, 'utf8')) === '{"sentinel":"preserve-me"}\n'
    && (await readFile(join(project, '.qwen', 'bughunter', 'state', 'web', 'runs', 'sentinel.json'), 'utf8')) === '{}\n'
    && (await readFile(join(project, '.qwen', 'bughunter', 'state', 'web', 'auth', 'README'), 'utf8')) === 'not-a-credential\n';
  assert.equal(statePreserved, true, 'marketplace update must preserve project state');

  const clientVersion = run(qwen, ['--version']).stdout.trim();
  const sourceCommit = run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }).stdout.trim();
  const installEvidence = {
    host: 'qwen',
    surface: 'cli',
    gate: 'install',
    status: 'passed',
    source: 'marketplace',
    sourceCommit,
    clientVersion,
    dormantTools: dormant.bhTools.length,
    skills: dormant.skills.length,
    agents: dormant.agents.length,
    updatedTo: updated.find((plugin) => plugin.id === 'bughunter@bughunter-market').version,
    statePreserved,
  };
  await mkdir(join(pluginRoot, 'evidence', 'qwen'), { recursive: true });
  await writeFile(
    join(pluginRoot, 'evidence', 'qwen', 'install.json'),
    `${JSON.stringify(installEvidence, null, 2)}\n`,
  );

  console.log(JSON.stringify({
    installed: installed.find((plugin) => plugin.id === 'bughunter@bughunter-market').id,
    dormant: { tools: dormant.bhTools.length },
    updatedTo: updated.find((plugin) => plugin.id === 'bughunter@bughunter-market').version,
    sentinels: ['config', 'runs', 'auth'],
    evidence: installEvidence,
  }));
} finally {
  await rm(root, { recursive: true, force: true });
}
