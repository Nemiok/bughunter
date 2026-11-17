import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { hostPaths } from './descriptor.mjs';
import { host } from './host.mjs';
import { startDormantServer } from './setup.mjs';

const version = '__PLUGIN_VERSION__';

function selectedPreset() {
  if (process.env.BUGHUNTER_PRESET !== undefined) return process.env.BUGHUNTER_PRESET;
  const file = hostPaths(host, process.cwd(), 'web').optIn;
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
    projectRoot: process.cwd(),
  });
}

async function main() {
  const preset = selectedPreset();
  if (preset === undefined) return dormant();
  if (!['web', 'node'].includes(preset)) {
    console.error(`BUGHUNTER_PRESET_INVALID: ${preset}`);
    process.exit(1);
  }
  const paths = hostPaths(host, process.cwd(), preset);
  const stateDir = process.env.BUGHUNTER_STATE_DIR ?? paths.stateDir;
  mkdirSync(stateDir, { recursive: true });
  const ignore = join(stateDir, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, 'runs/\nauth/\n', 'utf8');
  process.env.BUGHUNTER_STATE_DIR = stateDir;
  await import(join(import.meta.dirname, 'presets', preset, 'src', 'index.ts'));
}

await main();
