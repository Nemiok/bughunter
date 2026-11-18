import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  cp, mkdir, mkdtemp, readFile, rm, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { withMcpClient } from './mcp-client.mjs';

const pluginRoot = resolve(import.meta.dirname, '..');
const repoRoot = resolve(pluginRoot, '..');
const claude = process.env.CLAUDE_BIN ?? 'claude';
const root = await mkdtemp(join(tmpdir(), 'bh-claude-market-install-'));
const home = join(root, 'home');
const configDir = join(root, 'config');
const project = join(root, 'project');
const nodeProject = join(root, 'node-project');
const marketplaceRoot = join(root, 'marketplace');
const evidencePath = join(pluginRoot, 'evidence', 'claude', 'install.json');
const pluginVersion = JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8')).version;

function claudeEnv() {
  return { ...process.env, CLAUDE_CONFIG_DIR: configDir, HOME: home };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    cwd: options.cwd,
    timeout: options.timeout ?? 180000,
    env: options.env ?? { ...process.env, ...options.env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} → ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function installedEntry(listJson) {
  return listJson.find((entry) => entry.id === 'bughunter@bughunter-market');
}

async function writeEvidence(value) {
  await mkdir(join(pluginRoot, 'evidence', 'claude'), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(value, null, 2)}\n`);
}

try {
  run(process.execPath, [join(pluginRoot, 'build.mjs'), '--host', 'all'], { cwd: pluginRoot });
  const distPlugin = join(pluginRoot, 'dist', 'claude', 'bughunter');
  assert.ok(existsSync(join(distPlugin, 'server', 'mcp.mjs')), 'build must produce the plugin server');
  assert.ok(existsSync(join(pluginRoot, 'dist', 'claude-marketplace', '.claude-plugin', 'marketplace.json')), 'build must produce dist/claude-marketplace');
  await mkdir(home, { recursive: true });
  await mkdir(configDir, { recursive: true });
  await mkdir(project, { recursive: true });
  await mkdir(nodeProject, { recursive: true });
  await cp(join(pluginRoot, 'dist', 'claude-marketplace'), marketplaceRoot, { recursive: true });

  const version = spawnSync(claude, ['--version'], { encoding: 'utf8', env: claudeEnv() });
  if (version.error?.code === 'ENOENT') {
    await writeEvidence({
      host: 'claude', surface: 'cli', gate: 'install', status: 'blocked', blocker: 'CLAUDE_CLI_MISSING',
    });
    throw new Error('CLAUDE_CLI_MISSING: install Claude Code, authenticate it in the isolated gate config, then rerun');
  }
  if (version.status !== 0) {
    throw new Error(`claude --version → ${version.status}\n${version.stdout}\n${version.stderr}`);
  }
  const clientVersion = version.stdout.trim();

  const valid = run(claude, ['plugin', 'validate', '--strict', distPlugin], { env: claudeEnv() });
  assert.match(valid.stdout, /Validation passed/);

  run(claude, ['plugin', 'marketplace', 'add', marketplaceRoot], { env: claudeEnv() });
  run(claude, ['plugin', 'install', 'bughunter@bughunter-market', '--scope', 'user', '--yes'], { env: claudeEnv() });
  const list = run(claude, ['plugin', 'list'], { env: claudeEnv() });
  assert.match(list.stdout, /bughunter@bughunter-market/);
  assert.match(list.stdout, /loaded|enabled/i);

  const installed = installedEntry(JSON.parse(run(claude, ['plugin', 'list', '--json'], { env: claudeEnv() }).stdout));
  assert.ok(installed, 'bughunter@bughunter-market must be installed');
  assert.equal(installed.version, pluginVersion);
  assert.equal(installed.enabled, true);
  const serverRoot = (entry) => join(entry.installPath, 'server');

  // Real MCP handshake against the installed plugin server: a fresh process in
  // a project without opt-in is dormant and offers exactly bh_setup.
  const dormant = await withMcpClient(serverRoot(installed), project, (client) => client.listTools());
  assert.deepEqual(dormant.tools.map((tool) => tool.name), ['bh_setup']);

  // Web setup through a new server process, then sentinel state in the project.
  const setup = await withMcpClient(serverRoot(installed), project, (client) =>
    client.callTool({ name: 'bh_setup', arguments: { preset: 'web' } }));
  assert.equal(setup.isError, undefined);
  const setupResult = JSON.parse(setup.content[0].text);
  assert.equal(setupResult.code, 'CONFIG_CREATED');
  const optIn = JSON.parse(await readFile(join(project, '.claude', 'bughunter.json'), 'utf8'));
  assert.equal(optIn.preset, 'web');
  const configPath = setupResult.configPath;
  await writeFile(configPath, '{"sentinel":"preserve-me"}\n');
  await mkdir(join(project, '.claude', 'bughunter', 'state', 'web', 'runs'), { recursive: true });
  await writeFile(join(project, '.claude', 'bughunter', 'state', 'web', 'runs', 'sentinel.json'), '{}\n');
  await mkdir(join(project, '.claude', 'bughunter', 'state', 'web', 'auth'), { recursive: true });
  await writeFile(join(project, '.claude', 'bughunter', 'state', 'web', 'auth', 'README'), 'not-a-credential\n');

  // The toolset is fixed at server start: only a new process sees the web tools.
  const web = await withMcpClient(serverRoot(installed), project, (client) => client.listTools());
  assert.equal(web.tools.length, 19, `web preset must expose 19 tools, got ${web.tools.length}`);
  assert.ok(web.tools.every((tool) => tool.name.startsWith('bh_')));

  // Separate node project: its own opt-in and 16 tools on a fresh process.
  const nodeSetup = await withMcpClient(serverRoot(installed), nodeProject, (client) =>
    client.callTool({ name: 'bh_setup', arguments: { preset: 'node' } }));
  assert.equal(nodeSetup.isError, undefined);
  const node = await withMcpClient(serverRoot(installed), nodeProject, (client) => client.listTools());
  assert.equal(node.tools.length, 16, `node preset must expose 16 tools, got ${node.tools.length}`);

  // Genuine native update: both manifest and catalog move to 0.1.1-test.1.
  const manifestPath = join(marketplaceRoot, 'plugins', 'bughunter', '.claude-plugin', 'plugin.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.version = '0.1.1-test.1';
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const catalogPath = join(marketplaceRoot, '.claude-plugin', 'marketplace.json');
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  catalog.plugins[0].version = '0.1.1-test.1';
  await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

  run(claude, ['plugin', 'marketplace', 'update', 'bughunter-market'], { env: claudeEnv() });
  run(claude, ['plugin', 'update', 'bughunter@bughunter-market', '--yes'], { env: claudeEnv() });
  const updated = installedEntry(JSON.parse(run(claude, ['plugin', 'list', '--json'], { env: claudeEnv() }).stdout));
  assert.equal(updated.version, '0.1.1-test.1');
  assert.equal(updated.enabled, true);
  const listAfter = run(claude, ['plugin', 'list'], { env: claudeEnv() });
  assert.match(listAfter.stdout, /bughunter@bughunter-market/);
  assert.match(listAfter.stdout, /loaded|enabled/i);

  const statePreserved = (await readFile(configPath, 'utf8')) === '{"sentinel":"preserve-me"}\n'
    && (await readFile(join(project, '.claude', 'bughunter', 'state', 'web', 'runs', 'sentinel.json'), 'utf8')) === '{}\n'
    && (await readFile(join(project, '.claude', 'bughunter', 'state', 'web', 'auth', 'README'), 'utf8')) === 'not-a-credential\n';
  assert.equal(statePreserved, true, 'marketplace update must preserve project state');
  assert.ok(!existsSync(join(installed.installPath, '.claude', 'bughunter.json')), 'opt-in must never be written into the managed plugin root');
  assert.ok(!existsSync(join(updated.installPath, '.claude', 'bughunter.json')), 'opt-in must never be written into the updated managed root');

  // The updated managed copy serves the same project state on fresh processes.
  const webAfter = await withMcpClient(serverRoot(updated), project, (client) => client.listTools());
  assert.equal(webAfter.tools.length, 19);
  const nodeAfter = await withMcpClient(serverRoot(updated), nodeProject, (client) => client.listTools());
  assert.equal(nodeAfter.tools.length, 16);

  const sourceCommit = run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }).stdout.trim();
  const evidence = {
    host: 'claude',
    clientVersion,
    surface: 'cli',
    gate: 'install',
    status: 'passed',
    sourceCommit,
    dormantTools: dormant.tools.length,
    webTools: web.tools.length,
    nodeTools: node.tools.length,
    statePreserved,
  };
  await writeEvidence(evidence);

  console.log(JSON.stringify({ ...evidence, updatedTo: updated.version }));
} finally {
  await rm(root, { recursive: true, force: true });
}
