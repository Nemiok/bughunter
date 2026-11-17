import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const pluginRoot = resolve(import.meta.dirname);
const dist = join(pluginRoot, 'dist', 'bughunter');
const qwen = process.env.QWEN_BIN ?? 'qwen';
const root = await mkdtemp(join(tmpdir(), 'bh-plugin-install-'));
const configDir = join(root, 'config');
const project = join(root, 'project');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', cwd: options.cwd, env: { ...process.env, ...options.env } });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} → ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function initOf() {
  return new Promise((resolveInit, reject) => {
    const child = spawn(qwen, [
      '--config-dir', configDir,
      '-p', 'hi',
      '--output-format', 'stream-json',
      '--no-session-persistence',
      '--allowed-mcp-server-names', 'bughunter',
    ], { cwd: project, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => finish(new Error(`qwen init timed out\n${stderr}`)), 30_000);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      if (error) reject(error);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const line = stdout.split('\n').find((value) => value.includes('"subtype":"init"'));
      if (line === undefined) return;
      finish();
      resolveInit(JSON.parse(line));
    });
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => {
      if (!settled) finish(new Error(`qwen exited before init (${code})\n${stderr}\n${stdout}`));
    });
  });
}

function summarize(event) {
  return {
    mcp: event.mcp_servers.map((server) => `${server.name}:${server.status}`),
    bhTools: event.tools.filter((tool) => tool.startsWith('mcp__bughunter__')),
    skills: event.skills.filter((skill) => skill.startsWith('bughunter:')),
    agents: event.agents.filter((agent) => agent.startsWith('bughunter:')),
  };
}

try {
  run(process.execPath, [join(pluginRoot, 'build.mjs')], { cwd: pluginRoot });
  const entry = await readFile(join(dist, 'skills', 'bughunter', 'SKILL.md'), 'utf8');
  assert.match(entry, /<card>=bughunter:bughunter-preset-card-web/);
  assert.match(entry, /<explorer>=bughunter:bh-explorer-node/);
  assert.match(await readFile(join(dist, 'agents', 'bh-explorer.md'), 'utf8'), /bughunter:bughunter-preset-card-web/);
  assert.match(await readFile(join(dist, 'agents', 'bh-explorer-node.md'), 'utf8'), /bughunter:bughunter-preset-card-node/);
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

  run(process.execPath, [join(pluginRoot, 'install.mjs'), '--config-dir', configDir, '--preset', 'web'], { cwd: project, env: { QWEN_BIN: qwen } });
  const optIn = JSON.parse(await readFile(join(project, '.qwen', 'bughunter.json'), 'utf8'));
  assert.equal(optIn.preset, 'web');

  const web = summarize(await initOf());
  assert.deepEqual(web.mcp, ['bughunter:connected']);
  assert.equal(web.bhTools.length, 19, `web tools: ${web.bhTools.join(', ')}`);
  assert.deepEqual(web.skills.sort(), [
    'bughunter:bughunter',
    'bughunter:bughunter-oracles',
    'bughunter:bughunter-red-test',
    'bughunter:bughunter-preset-card-web',
    'bughunter:bughunter-preset-card-node',
  ].sort());
  assert.deepEqual(web.agents.sort(), [
    'bughunter:bh-explorer',
    'bughunter:bh-reviewer',
    'bughunter:bh-test-writer',
    'bughunter:bh-explorer-node',
    'bughunter:bh-reviewer-node',
    'bughunter:bh-test-writer-node',
  ].sort());
  assert.ok(existsSync(join(project, '.qwen', 'bughunter', 'state', 'web', 'preset.json')));

  await writeFile(join(project, '.qwen', 'bughunter.json'), '{"preset":"node"}\n');
  const node = summarize(await initOf());
  assert.deepEqual(node.mcp, ['bughunter:connected']);
  assert.equal(node.bhTools.length, 16, `node tools: ${node.bhTools.join(', ')}`);
  assert.ok(existsSync(join(project, '.qwen', 'bughunter', 'state', 'node', 'preset.json')));

  await rm(join(project, '.qwen', 'bughunter.json'));
  await rm(join(project, '.qwen', 'bughunter'), { recursive: true, force: true });
  const dormant = summarize(await initOf());
  assert.deepEqual(dormant.mcp, ['bughunter:connected']);
  assert.equal(dormant.bhTools.length, 0, 'dormant plugin must expose no Bughunter tools');
  assert.equal(dormant.skills.length, 5);
  assert.equal(dormant.agents.length, 6);
  assert.ok(!existsSync(join(project, '.qwen', 'bughunter')), 'dormant plugin must not create project state');

  console.log(JSON.stringify({
    web: { tools: web.bhTools.length, skills: web.skills.length, agents: web.agents.length },
    node: { tools: node.bhTools.length },
    dormant: { tools: dormant.bhTools.length, state: false },
  }));
} finally {
  await rm(root, { recursive: true, force: true });
}
