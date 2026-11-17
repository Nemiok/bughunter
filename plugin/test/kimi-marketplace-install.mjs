import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  cp, mkdir, readFile, readdir, rename, writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { withMcpClient } from './mcp-client.mjs';
import {
  assertExcludes, kimiProbe, kimiRequest, makeTempRoot, removeTempRoot, withKimiServer,
} from './kimi-server.mjs';

const pluginRoot = resolve(import.meta.dirname, '..');
const kimi = process.env.KIMI_BIN ?? 'kimi';
const root = await makeTempRoot('bh-kimi-market-install-');
const home = join(root, 'home');
const project = join(root, 'project');
const nodeProject = join(root, 'node-project');
const marketplaceRoot = join(root, 'marketplace');
const evidencePath = join(pluginRoot, 'evidence', 'kimi', 'install.json');

// Derived from the built artifact before the server starts (see try block).
let BH_TOOL_PREFIX;
// Set inside the server session; used only for leak assertions, never logged.
let serverToken;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', cwd: options.cwd, env: { ...process.env, ...options.env } });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} → ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

async function writeCatalog(catalog) {
  await writeFile(join(marketplaceRoot, 'kimi-marketplace.json'), `${JSON.stringify(catalog, null, 2)}\n`);
}

async function waitFor(label, probe, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`TIMEOUT waiting for ${label}: ${JSON.stringify(last)}`);
}

async function sessionWithConnectedMcp(baseUrl, token, cwd) {
  const session = await kimiRequest(baseUrl, token, 'POST', '/api/v1/sessions', { metadata: { cwd } });
  await waitFor(`mcp connected for ${session.id}`, async () => {
    const servers = await kimiRequest(baseUrl, token, 'GET', '/api/v1/mcp/servers');
    const bughunter = servers.servers.find((server) => server.name === 'plugin-bughunter:bughunter');
    return bughunter?.status === 'connected' ? bughunter : undefined;
  });
  return session;
}

async function restartBhMcp(baseUrl, token) {
  await kimiRequest(baseUrl, token, 'POST', `/api/v1/mcp/servers/${encodeURIComponent('plugin-bughunter:bughunter')}:restart`, {});
  await waitFor('mcp reconnected after restart', async () => {
    const servers = await kimiRequest(baseUrl, token, 'GET', '/api/v1/mcp/servers');
    const bughunter = servers.servers.find((server) => server.name === 'plugin-bughunter:bughunter');
    return bughunter?.status === 'connected' ? bughunter : undefined;
  });
}

async function waitForHookCwd(homeDir, cwd) {
  await waitFor(`SessionStart hook cwd=${cwd}`, async () => {
    try {
      return (await readFile(join(homeDir, 'bughunter', 'session-cwd'), 'utf8')).trim() === cwd ? cwd : undefined;
    } catch {
      return undefined;
    }
  });
}

async function bhToolNames(baseUrl, token, sessionId) {
  const tools = await kimiRequest(baseUrl, token, 'GET', `/api/v1/tools?session_id=${encodeURIComponent(sessionId)}`);
  return tools.tools.filter((tool) => tool.name.startsWith(BH_TOOL_PREFIX)).map((tool) => tool.name);
}

try {
  run(process.execPath, [join(pluginRoot, 'build.mjs'), '--host', 'all'], { cwd: pluginRoot });
  const distPlugin = join(pluginRoot, 'dist', 'kimi', 'bughunter');
  assert.ok(existsSync(join(distPlugin, 'server', 'mcp.mjs')), 'build must produce the plugin server');
  assert.ok(existsSync(join(pluginRoot, 'dist', 'kimi-marketplace.json')), 'build must produce dist/kimi-marketplace.json');
  await cp(distPlugin, join(marketplaceRoot, 'bughunter'), { recursive: true });
  const catalog = JSON.parse(await readFile(join(pluginRoot, 'dist', 'kimi-marketplace.json'), 'utf8'));
  catalog.plugins[0].source = join(marketplaceRoot, 'bughunter');
  await writeCatalog(catalog);
  const version = catalog.plugins[0].version;

  // Derive the MCP tool prefix from the built artifact — the same rendered
  // entry the model sees — instead of hardcoding it.
  const entrySkill = await readFile(join(distPlugin, 'skills', 'bughunter', 'SKILL.md'), 'utf8');
  const prefixMatch = entrySkill.match(/(mcp__[a-z0-9_-]+__)bh_setup/);
  assert.ok(prefixMatch, 'rendered entry skill must name the bh_setup tool');
  BH_TOOL_PREFIX = prefixMatch[1];
  assert.ok(BH_TOOL_PREFIX.startsWith('mcp__') && BH_TOOL_PREFIX.includes('bughunter'));

  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  await mkdir(nodeProject, { recursive: true });

  const result = await withKimiServer({ home, marketplace: join(marketplaceRoot, 'kimi-marketplace.json'), project }, async ({ baseUrl, token }) => {
    serverToken = token;
    // Marketplace visibility with the Task 5 artifact platforms (darwin/win32).
    const listed = await kimiRequest(baseUrl, token, 'GET', '/api/v1/plugins/marketplace');
    const entry = listed.entries.find((value) => value.id === 'bughunter');
    assert.ok(entry, 'bughunter must be listed in the custom marketplace');
    assert.equal(entry.version, version);

    // Platform conventions proven against the live runtime, not the docs:
    // official docs list macos/windows/linux/cloud, the server API docs use
    // darwin/win32. Both spellings normalize to the same values; anything
    // else fails the catalog parse.
    const docStyle = JSON.parse(JSON.stringify(catalog));
    docStyle.plugins[0].platforms = ['macos', 'windows', 'linux'];
    await writeCatalog(docStyle);
    const aliased = await kimiRequest(baseUrl, token, 'GET', '/api/v1/plugins/marketplace');
    assert.ok(aliased.entries.some((value) => value.id === 'bughunter'), 'macos/windows/linux alias must stay visible');

    const invalid = JSON.parse(JSON.stringify(catalog));
    invalid.plugins[0].platforms = ['osx'];
    await writeCatalog(invalid);
    const rejected = await kimiProbe(baseUrl, token, 'GET', '/api/v1/plugins/marketplace');
    assert.notEqual(rejected.code, 0, `unsupported platform must fail, got ${JSON.stringify(rejected)}`);
    const rejectedMessage = rejected.msg ?? rejected.details?.message ?? JSON.stringify(rejected);
    await writeCatalog(catalog);
    const restored = await kimiRequest(baseUrl, token, 'GET', '/api/v1/plugins/marketplace');
    assert.ok(restored.entries.some((value) => value.id === 'bughunter'), 'entry must reappear after restoring the catalog');

    // Install from the custom marketplace and verify the managed record.
    const installed = await kimiRequest(baseUrl, token, 'POST', '/api/v1/plugins', {
      marketplaceId: 'bughunter', expectedVersion: version,
    });
    assert.equal(installed.id, 'bughunter');
    assert.equal(installed.enabled, true);
    assert.equal(installed.version, version);

    const details = await kimiRequest(baseUrl, token, 'GET', '/api/v1/plugins/bughunter');
    assert.equal(details.skillCount, 7);
    assert.equal(details.mcpServerCount, 1);
    assert.deepEqual(details.diagnostics, []);
    const agentFiles = (await readdir(join(details.root, 'agents'))).filter((file) => file.endsWith('.md'));
    assert.equal(agentFiles.length, 6, 'six agent files must ship in the managed root');

    // Main session without any model turn: 7 plugin skills, dormant MCP (1 tool).
    const dormant = await sessionWithConnectedMcp(baseUrl, token, project);
    // The SessionStart hook is what tells the sandboxed MCP server which
    // project it serves; it must fire without any model turn.
    await waitForHookCwd(home, project);
    const skills = await kimiRequest(baseUrl, token, 'GET', `/api/v1/sessions/${dormant.id}/skills`);
    assert.equal(skills.skills.filter((skill) => skill.name.startsWith('bughunter:')).length, 7);
    assert.deepEqual(await bhToolNames(baseUrl, token, dormant.id), [`${BH_TOOL_PREFIX}bh_setup`]);

    // Web setup through the managed plugin server, then sentinel state.
    const setup = await withMcpClient(join(details.root, 'server'), project, (client) =>
      client.callTool({ name: 'bh_setup', arguments: { preset: 'web' } }));
    assert.equal(setup.isError, undefined);
    const configPath = JSON.parse(setup.content[0].text).configPath;
    await writeFile(configPath, '{"sentinel":"preserve-me"}\n');
    await mkdir(join(project, '.kimi-code', 'bughunter', 'state', 'web', 'runs'), { recursive: true });
    await writeFile(join(project, '.kimi-code', 'bughunter', 'state', 'web', 'runs', 'sentinel.json'), '{}\n');
    await mkdir(join(project, '.kimi-code', 'bughunter', 'state', 'web', 'auth'), { recursive: true });
    await writeFile(join(project, '.kimi-code', 'bughunter', 'state', 'web', 'auth', 'README'), 'not-a-credential\n');

    // Direct probes spawned the way Kimi spawns plugin MCP servers: cwd =
    // plugin root, KIMI_PLUGIN_ROOT/KIMI_CODE_HOME set. With the SessionStart
    // bridge present, the server must resolve the project via the hook file
    // and expose the full web toolset.
    const kimiSpawnEnv = { KIMI_PLUGIN_ROOT: details.root, KIMI_CODE_HOME: home };
    const bridged = await withMcpClient(join(details.root, 'server'), details.root, (client) => client.listTools(), kimiSpawnEnv);
    assert.equal(bridged.tools.length, 19, `bridge-resolved spawn must expose 19 web tools, got ${bridged.tools.length}`);
    // Raw MCP tools/list carries bare bh_* names; the mcp__…__ prefix is added
    // by the host agent registry (checked separately via GET /api/v1/tools).
    assert.ok(bridged.tools.every((tool) => tool.name.startsWith('bh_')));

    // Without the bridge the same spawn cannot know the project: bh_setup
    // must refuse with BUGHUNTER_PROJECT_UNKNOWN instead of writing opt-in
    // into the managed plugin root.
    const bridgeFile = join(home, 'bughunter', 'session-cwd');
    await rename(bridgeFile, `${bridgeFile}.bak`);
    try {
      const unknown = await withMcpClient(join(details.root, 'server'), details.root, (client) =>
        client.callTool({ name: 'bh_setup', arguments: { preset: 'node' } }), kimiSpawnEnv);
      assert.equal(unknown.isError, true);
      assert.ok(unknown.content[0].text.includes('BUGHUNTER_PROJECT_UNKNOWN'));
    } finally {
      await rename(`${bridgeFile}.bak`, bridgeFile);
    }
    assert.ok(!existsSync(join(details.root, '.kimi-code', 'bughunter.json')), 'opt-in must never be written into the managed plugin root');

    // The v2 engine keeps one MCP connection set per workspace, so the
    // connection opened by the dormant session must be restarted to pick up
    // the opt-in; only then does a session see the full web toolset.
    await restartBhMcp(baseUrl, token);
    const webSession = await sessionWithConnectedMcp(baseUrl, token, project);
    const webTools = await bhToolNames(baseUrl, token, webSession.id);
    assert.equal(webTools.length, 19, `web preset must expose 19 tools, got ${webTools.length}`);

    // Genuine update: catalog and managed source move to 0.1.1-test.1,
    // POST /plugins must update in place and preserve project state.
    const bumpedSource = join(marketplaceRoot, 'bughunter', 'kimi.plugin.json');
    const manifest = JSON.parse(await readFile(bumpedSource, 'utf8'));
    manifest.version = '0.1.1-test.1';
    await writeFile(bumpedSource, `${JSON.stringify(manifest, null, 2)}\n`);
    const updatedCatalog = JSON.parse(await readFile(join(marketplaceRoot, 'kimi-marketplace.json'), 'utf8'));
    updatedCatalog.plugins[0].version = '0.1.1-test.1';
    await writeCatalog(updatedCatalog);

    const updated = await kimiRequest(baseUrl, token, 'POST', '/api/v1/plugins', {
      marketplaceId: 'bughunter', expectedVersion: '0.1.1-test.1',
    });
    assert.equal(updated.version, '0.1.1-test.1');
    assert.equal(updated.enabled, true);
    const afterUpdate = await kimiRequest(baseUrl, token, 'GET', '/api/v1/plugins/bughunter');
    assert.equal(afterUpdate.version, '0.1.1-test.1');
    assert.equal(await readFile(configPath, 'utf8'), '{"sentinel":"preserve-me"}\n');
    assert.equal(await readFile(join(project, '.kimi-code', 'bughunter', 'state', 'web', 'runs', 'sentinel.json'), 'utf8'), '{}\n');
    assert.equal(await readFile(join(project, '.kimi-code', 'bughunter', 'state', 'web', 'auth', 'README'), 'utf8'), 'not-a-credential\n');

    // Node preset in a separate temp project: 16 tools, no run started.
    const freshDetails = await kimiRequest(baseUrl, token, 'GET', '/api/v1/plugins/bughunter');
    const nodeSetup = await withMcpClient(join(freshDetails.root, 'server'), nodeProject, (client) =>
      client.callTool({ name: 'bh_setup', arguments: { preset: 'node' } }));
    assert.equal(nodeSetup.isError, undefined);
    const nodeSession = await sessionWithConnectedMcp(baseUrl, token, nodeProject);
    await waitForHookCwd(home, nodeProject);
    await restartBhMcp(baseUrl, token);
    const nodeTools = await bhToolNames(baseUrl, token, nodeSession.id);
    assert.equal(nodeTools.length, 16, `node preset must expose 16 tools, got ${nodeTools.length}`);

    // Two opted-in projects: after the node flow and its restarts, the bridge
    // must follow the latest started session back to the web project.
    await sessionWithConnectedMcp(baseUrl, token, project);
    await waitForHookCwd(home, project);
    await restartBhMcp(baseUrl, token);
    const webAgain = await sessionWithConnectedMcp(baseUrl, token, project);
    const webToolsAgain = await bhToolNames(baseUrl, token, webAgain.id);
    assert.equal(webToolsAgain.length, 19, `web project must resolve to 19 tools after the node flow, got ${webToolsAgain.length}`);

    return {
      installedId: installed.id,
      updatedTo: updated.version,
      rejectedPlatformMessage: rejectedMessage,
      webTools: webTools.length,
      nodeTools: nodeTools.length,
      webToolsReasserted: webToolsAgain.length,
      skills: skills.skills.filter((skill) => skill.name.startsWith('bughunter:')).length,
      statePreserved: true,
    };
  });

  const clientVersion = run(kimi, ['--version']).stdout.trim();
  assert.equal(clientVersion, '2.5.3');
  assertExcludes(result, serverToken, 'gate result must not contain the server token value');
  assertExcludes(result, home, 'gate result must not contain the temp home path');
  const evidence = {
    host: 'kimi',
    clientVersion,
    surface: 'cli',
    gate: 'install',
    status: 'passed',
    webTools: result.webTools,
    nodeTools: result.nodeTools,
    skills: result.skills,
    statePreserved: result.statePreserved,
  };
  assertExcludes(evidence, serverToken, 'evidence must not contain the server token value');
  assertExcludes(evidence, home, 'evidence must not contain the temp home path');
  assertExcludes(evidence, 'server.token', 'evidence must not name the token file');
  await mkdir(join(pluginRoot, 'evidence', 'kimi'), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

  console.log(JSON.stringify({
    ...evidence,
    updatedTo: result.updatedTo,
    rejectedPlatformMessage: result.rejectedPlatformMessage,
  }));
} finally {
  await removeTempRoot(root);
}
