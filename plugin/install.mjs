import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const pluginRoot = resolve(import.meta.dirname);
const repoRoot = resolve(pluginRoot, '..');
const dist = join(pluginRoot, 'dist', 'bughunter');
const args = process.argv.slice(2);
const qwen = process.env.QWEN_BIN ?? 'qwen';
const configDir = value('--config-dir');
const scope = value('--scope') ?? 'user';
const preset = value('--preset');

function value(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  });
  if (result.error) fail(`${command}: ${result.error.message}`);
  if (result.status !== 0 && options.required !== false) {
    if (options.capture) process.stderr.write(result.stdout || result.stderr || '');
    fail(`${command} ${commandArgs.join(' ')} → exit ${result.status}`);
  }
  return result;
}

function qwenArgs(...rest) {
  return [...(configDir === undefined ? [] : ['--config-dir', configDir]), ...rest];
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: node install.mjs [--scope user|project|local] [--preset web|node] [--config-dir DIR] [--rebuild]

Installs the Bughunter Qwen plugin, enables it, and writes .qwen/bughunter.json
in the current project. Run it from the root of the project that should use Bughunter.
Default scope: user (once per machine). Default preset for a new opt-in file: web.`);
  process.exit(0);
}
if (!['user', 'project', 'local'].includes(scope)) fail(`unknown scope: ${scope}`);
if (preset !== undefined && !['web', 'node'].includes(preset)) fail(`unknown preset: ${preset}`);
if (scope === 'project') {
  console.warn('scope=project commits the plugin (including production node_modules) to the project; use "local" for a personal per-project install.');
}

if (args.includes('--rebuild') || !existsSync(join(dist, 'server', 'mcp.mjs'))) {
  run(process.execPath, [join(pluginRoot, 'build.mjs')]);
}

const installed = run(qwen, qwenArgs('plugins', 'install', '-s', scope, dist, '--json'), { capture: true });
let pluginId = 'bughunter@local';
let installPath;
try {
  const parsedInstall = JSON.parse(installed.stdout);
  pluginId = parsedInstall.pluginId ?? pluginId;
  installPath = parsedInstall.path;
} catch {
  // A text-format install is still usable if the CLI changes its JSON output.
}
const listed = run(qwen, qwenArgs('plugins', 'list', '--json'), { capture: true });
let entry;
try {
  entry = JSON.parse(listed.stdout).find((plugin) => plugin.id === pluginId);
} catch {
  entry = undefined;
}
if (entry?.enabled !== true) {
  run(qwen, qwenArgs('plugins', 'enable', pluginId));
}

const projectRoot = process.cwd();
const optIn = join(projectRoot, '.qwen', 'bughunter.json');
let selected = preset ?? 'web';
if (existsSync(optIn)) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(optIn, 'utf8'));
  } catch {
    fail(`cannot parse ${optIn}; fix or remove it`);
  }
  if (preset !== undefined) parsed.preset = preset;
  selected = typeof parsed.preset === 'string' ? parsed.preset : selected;
  writeFileSync(optIn, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
} else {
  mkdirSync(dirname(optIn), { recursive: true });
  writeFileSync(optIn, `${JSON.stringify({ preset: selected }, null, 2)}\n`, 'utf8');
}
if (!['web', 'node'].includes(selected)) fail(`opt-in preset must be web or node: ${selected}`);

const mcpFile = join(projectRoot, '.mcp.json');
if (existsSync(mcpFile)) {
  try {
    const mcp = JSON.parse(readFileSync(mcpFile, 'utf8'));
    if (mcp.mcpServers?.bughunter !== undefined) {
      console.warn('warning: .mcp.json already defines a "bughunter" server. Remove it: the plugin registers its own server with the same name.');
    }
  } catch {
    console.warn(`warning: cannot parse ${mcpFile}; check for a duplicate "bughunter" MCP server.`);
  }
}
if (existsSync(join(projectRoot, '.qwen', 'bughunter', 'presets'))) {
  console.warn('warning: a manual .qwen/bughunter installation was found. The plugin is a second "bughunter" server; keep one installation.');
}

const settingsFiles = [
  ...(configDir === undefined ? [join(homedir(), '.qwen', 'settings.json')] : [join(configDir, 'settings.json')]),
  join(projectRoot, '.qwen', 'settings.json'),
];
const allowed = settingsFiles.some((file) => {
  if (!existsSync(file)) return false;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return (parsed.permissions?.allow ?? []).some((pattern) => pattern === 'mcp__bughunter__*' || pattern === '*');
  } catch {
    return false;
  }
});

const stateDir = join(projectRoot, '.qwen', 'bughunter', 'state', selected);
console.log(`
Bughunter plugin: ${pluginId} (${scope}), preset: ${selected}
Opt-in: ${optIn}
State:  ${stateDir}
Config: ${join(stateDir, 'config.json')}
Authoring: ${installPath === undefined ? '<installPath>/AUTHORING.md' : join(installPath, 'AUTHORING.md')}
Template: ${installPath === undefined ? '<installPath>/template/cli-preset' : join(installPath, 'template', 'cli-preset')}

Next:
1. Restart qwen (or run /plugins reload) so the MCP server starts.
2. Run /bughunter:bughunter in the project root.
3. On the first run the server creates the config and returns CONFIG_CREATED; fill it in and run again.
${allowed ? '' : '4. Allow the tools in your Qwen settings: "permissions": { "allow": ["mcp__bughunter__*"] }'}

Web preset needs Google Chrome. Node preset needs a profile in state/profiles/<name>/.
Switch preset: edit .qwen/bughunter.json, then restart qwen.
`);
