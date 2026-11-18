import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { hostPaths } from './descriptor.mjs';
import { host } from './host.mjs';
import { startDormantServer } from './setup.mjs';

const version = '__PLUGIN_VERSION__';

// Agent Plugins v1 hosts (Qwen Code 0.28.0 extensions) set PLUGIN_ROOT and
// spawn stdio servers with cwd = plugin root, so the workspace project is
// indistinguishable from the installation directory without a workspace
// signal. Kimi Desktop signals the same via KIMI_PLUGIN_ROOT.
function hostPluginRoot() {
  return process.env.KIMI_PLUGIN_ROOT ?? process.env.PLUGIN_ROOT;
}

function kimiHome() {
  return process.env.KIMI_CODE_HOME;
}

// Hosts may hand us symlinked paths (macOS /var → /private/var) while the
// spawned process cwd is already resolved, so equality is checked on realpaths.
function samePath(a, b) {
  if (b === undefined) return false;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
}

// Kimi/Desktop spawn plugin MCP servers with cwd = plugin root and expose no
// workspace path (verified against the 2.5.3 runtime: initialize capabilities
// are empty); Qwen Code 0.28.0 extension spawns behave the same way (verified:
// cwd = $QWEN_HOME/extensions/<name>, PLUGIN_ROOT set, QWEN_CODE_PROJECT_DIR
// points at CLI-internal per-project storage, not the workspace). Resolution
// order:
//   1. BUGHUNTER_PROJECT_ROOT override (harnesses, tests)
//   2. cwd when it is neither the plugin root nor the Kimi home (Qwen preview
//      spawn — the session cwd)
//   3. the latest SessionStart hook cwd recorded under KIMI_CODE_HOME
//   4. cwd as a last resort; projectUnknown() then refuses bh_setup before
//      any write, because the resolved root is the installation directory
function resolveProjectRoot() {
  if (process.env.BUGHUNTER_PROJECT_ROOT !== undefined) return process.env.BUGHUNTER_PROJECT_ROOT;
  const cwd = process.cwd();
  if (!samePath(cwd, hostPluginRoot()) && !samePath(cwd, kimiHome())) return cwd;
  const bridge = kimiHome() === undefined ? undefined : join(kimiHome(), 'bughunter', 'session-cwd');
  if (bridge !== undefined && existsSync(bridge)) {
    try {
      const value = readFileSync(bridge, 'utf8').trim();
      if (value.length > 0) return value;
    } catch {}
  }
  return cwd;
}

const projectRoot = resolveProjectRoot();

function projectUnknown() {
  return samePath(projectRoot, hostPluginRoot()) || samePath(projectRoot, kimiHome());
}

function selectedPreset() {
  if (process.env.BUGHUNTER_PRESET !== undefined) return process.env.BUGHUNTER_PRESET;
  const file = hostPaths(host, projectRoot, 'web').optIn;
  if (!existsSync(file)) return undefined;
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return typeof value.preset === 'string' ? value.preset : undefined;
  } catch {
    return undefined;
  }
}

async function dormant() {
  return startDormantServer({
    host,
    version,
    serverRoot: import.meta.dirname,
    projectRoot,
    projectUnknown: projectUnknown(),
  });
}

async function main() {
  const preset = selectedPreset();
  if (preset === undefined) return dormant();
  if (!['web', 'node'].includes(preset)) {
    console.error(`BUGHUNTER_PRESET_INVALID: ${preset}`);
    process.exit(1);
  }
  const paths = hostPaths(host, projectRoot, preset);
  const stateDir = process.env.BUGHUNTER_STATE_DIR ?? paths.stateDir;
  mkdirSync(stateDir, { recursive: true });
  const ignore = join(stateDir, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, 'runs/\nauth/\n', 'utf8');
  process.env.BUGHUNTER_STATE_DIR = stateDir;
  await import(join(import.meta.dirname, 'presets', preset, 'src', 'index.ts'));
}

await main();
