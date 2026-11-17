import { existsSync, readFileSync } from 'node:fs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { hostPaths } from './descriptor.mjs';
import { host } from './host.mjs';
import { startDormantServer } from './setup.mjs';

const version = '__PLUGIN_VERSION__';

function kimiPluginRoot() {
  return process.env.KIMI_PLUGIN_ROOT;
}

function kimiHome() {
  return process.env.KIMI_CODE_HOME;
}

// Kimi/Desktop spawn plugin MCP servers with cwd = plugin root and expose no
// workspace path (verified against the 2.5.3 runtime: initialize capabilities
// are empty). Resolution order:
//   1. BUGHUNTER_PROJECT_ROOT override (harnesses, tests)
//   2. cwd when it is neither the plugin root nor the Kimi home (Qwen spawn)
//   3. the latest SessionStart hook cwd recorded under KIMI_CODE_HOME
//   4. cwd as a last resort
function resolveProjectRoot() {
  if (process.env.BUGHUNTER_PROJECT_ROOT !== undefined) return process.env.BUGHUNTER_PROJECT_ROOT;
  const cwd = process.cwd();
  if (cwd !== kimiPluginRoot() && cwd !== kimiHome()) return cwd;
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
  const managedRoot = kimiPluginRoot();
  return (managedRoot !== undefined && projectRoot === managedRoot)
    || (kimiHome() !== undefined && projectRoot === kimiHome());
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
