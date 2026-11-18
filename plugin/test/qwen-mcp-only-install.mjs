import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { withMcpClient } from './mcp-client.mjs';

const pluginRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(pluginRoot, '..');
const qwen = process.env.QWEN_PORTABLE_BIN
  ?? join(repoRoot, 'bughunter-gate', 'multi-host', 'qwen-portable-cli', 'node_modules', '.bin', 'qwen');
const dist = join(pluginRoot, 'dist', 'qwen', 'bughunter-mcp');
const root = await mkdtemp(join(tmpdir(), 'bh-qwen-mcp-only-'));
const home = join(root, 'home');
const webProject = join(root, 'web-project');
const nodeProject = join(root, 'node-project');
const evidenceDir = join(pluginRoot, 'evidence', 'qwen', 'mcp-only');

// Qwen 0.28.0 (portable gate CLI) — no --config-dir; QWEN_HOME is the
// documented config root and HOME is isolated alongside it. The stream-json
// init event arrives before any model request, so the probe is killed on
// init and never spends credentials or model tokens.
const qwenEnv = { HOME: home, QWEN_HOME: home, DUMMY_API_KEY: 'sk-dummy-key-not-used' };

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} → ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function qwenInit({ project }) {
  return new Promise((resolveInit, reject) => {
    const child = spawn(qwen, [
      'hi', '--output-format', 'stream-json', '--max-wall-time', '20s', '--auth-type', 'openai',
    ], { cwd: project, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...qwenEnv } });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      if (error) reject(error); else resolveInit(value);
    };
    const timer = setTimeout(() => finish(new Error(`qwen init timed out\n${stderr}`)), 60_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const line = stdout.split('\n').find((value) => value.includes('"subtype":"init"'));
      if (line !== undefined) finish(undefined, JSON.parse(line));
    });
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => {
      if (!settled) finish(new Error(`qwen exited before init (${code})\n${stderr}\n${stdout}`));
    });
  });
}

try {
  run(process.execPath, [join(pluginRoot, 'build.mjs')], { cwd: pluginRoot });
  assert.ok(existsSync(join(dist, 'plugin.json')), 'build must produce the MCP-only manifest');
  assert.ok(existsSync(join(dist, 'server', 'mcp.mjs')), 'build must produce the MCP-only server');
  assert.ok(!existsSync(join(dist, 'agents')), 'MCP-only artifact must not ship agents');

  const clientVersion = run(qwen, ['--version'], { env: qwenEnv }).stdout.trim();
  assert.equal(clientVersion, '0.28.0');

  await mkdir(home, { recursive: true });
  await mkdir(webProject, { recursive: true });
  await mkdir(nodeProject, { recursive: true });
  // bh_start_run resolves the project root by walking up to a .git marker.
  await mkdir(join(webProject, '.git'), { recursive: true });
  await mkdir(join(nodeProject, '.git'), { recursive: true });
  await writeFile(join(home, 'settings.json'), `${JSON.stringify({
    $version: 4,
    modelProviders: {
      openai: [{ id: 'dummy', envKey: 'DUMMY_API_KEY', baseUrl: 'https://api.deepseek.com/v1', name: 'Dummy' }],
    },
    model: { name: 'openai:dummy' },
  }, null, 2)}\n`);

  run(qwen, ['extensions', 'install', dist, '--consent'], { env: qwenEnv });
  const installedRoot = join(home, 'extensions', 'bughunter-mcp');
  assert.ok(existsSync(join(installedRoot, 'plugin.json')), 'extension must be installed under QWEN_HOME');
  const installRecord = JSON.parse(await readFile(join(installedRoot, '.qwen-extension-install.json'), 'utf8'));
  assert.equal(installRecord.originSource, 'AgentPlugins');
  assert.equal(installRecord.externalContent, false);

  // Dormant: one setup tool, the portable setup skill, no project state.
  const dormant = await qwenInit({ project: webProject });
  const bhServer = dormant.mcp_servers.filter((server) => server.name === 'bughunter');
  assert.deepEqual(bhServer.map((server) => server.status), ['connected']);
  const dormantTools = dormant.tools.filter((tool) => tool.startsWith('mcp__bughunter__'));
  assert.deepEqual(dormantTools, ['mcp__bughunter__bh_setup']);
  assert.ok(dormant.slash_commands.includes('bughunter-mcp:bughunter-setup'));
  assert.equal(
    existsSync(join(webProject, '.qwen', 'bughunter')),
    false,
    'dormant extension must not create project state',
  );

  // Setup web through the installed server, then the full web toolset (19).
  const serverRoot = join(installedRoot, 'server');
  const web = await withMcpClient(serverRoot, webProject, async (client) => {
    const dormantList = await client.listTools();
    assert.deepEqual(dormantList.tools.map((tool) => tool.name), ['bh_setup']);
    return client.callTool({ name: 'bh_setup', arguments: { preset: 'web' } });
  });
  assert.equal(web.isError, undefined);
  const webSetup = JSON.parse(web.content[0].text);
  assert.equal(webSetup.code, 'CONFIG_CREATED');
  const webTools = await withMcpClient(serverRoot, webProject, (client) => client.listTools());
  assert.equal(webTools.tools.length, 19, `web preset must expose 19 tools, got ${webTools.tools.length}`);
  assert.ok(webTools.tools.every((tool) => tool.name.startsWith('bh_')));

  // Node preset in a separate project: 16 tools.
  const node = await withMcpClient(serverRoot, nodeProject, (client) =>
    client.callTool({ name: 'bh_setup', arguments: { preset: 'node' } }));
  assert.equal(node.isError, undefined);
  const nodeTools = await withMcpClient(serverRoot, nodeProject, (client) => client.listTools());
  assert.equal(nodeTools.tools.length, 16, `node preset must expose 16 tools, got ${nodeTools.tools.length}`);

  // Safety gate: opening an exploration run without a lease must fail closed
  // with LEASE_REQUIRED before any browser session starts.
  const safety = await withMcpClient(serverRoot, webProject, async (client) => {
    const started = await client.callTool({ name: 'bh_start_run', arguments: { scope: 'full' } });
    assert.equal(started.isError, undefined);
    const { runId } = JSON.parse(started.content[0].text);
    const opened = await client.callTool({
      name: 'bh_open',
      arguments: { runId, target: '/', persona: 'reader' },
    });
    assert.equal(opened.isError, true);
    return { runId, ...JSON.parse(opened.content[0].text) };
  });
  assert.equal(safety.code, 'LEASE_REQUIRED');
  assert.match(safety.message, /^LEASE_REQUIRED: /);

  const installEvidence = {
    host: 'qwen',
    channel: 'extensions',
    clientVersion,
    initVersion: dormant.qwen_code_version,
    package: 'bughunter-mcp',
    dormantTools: dormantTools.length,
    skill: 'bughunter-mcp:bughunter-setup',
    stateCreated: false,
    webTools: webTools.tools.length,
    nodeTools: nodeTools.tools.length,
    status: 'passed',
  };
  const safetyEvidence = {
    host: 'qwen',
    channel: 'extensions',
    clientVersion,
    gate: 'bh_open-without-lease',
    scope: 'full',
    code: safety.code,
    status: 'passed',
  };
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(join(evidenceDir, 'install.json'), `${JSON.stringify(installEvidence, null, 2)}\n`);
  await writeFile(join(evidenceDir, 'safety.json'), `${JSON.stringify(safetyEvidence, null, 2)}\n`);

  console.log(JSON.stringify({ install: installEvidence, safety: safetyEvidence }));
} finally {
  await rm(root, { recursive: true, force: true });
}
