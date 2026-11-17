import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const version = '__PLUGIN_VERSION__';

function selectedPreset() {
  if (process.env.BUGHUNTER_PRESET !== undefined) return process.env.BUGHUNTER_PRESET;
  const file = join(process.cwd(), '.qwen', 'bughunter.json');
  if (!existsSync(file)) return undefined;
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return typeof value.preset === 'string' ? value.preset : undefined;
  } catch {
    return undefined;
  }
}

async function dormant() {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const server = new McpServer({ name: 'bughunter', version });
  await server.connect(new StdioServerTransport());
}

async function main() {
  const preset = selectedPreset();
  if (preset === undefined) {
    await dormant();
    return;
  }
  if (!['web', 'node'].includes(preset)) {
    console.error(`BUGHUNTER_PRESET_INVALID: ${preset}`);
    process.exit(1);
  }
  const stateDir = process.env.BUGHUNTER_STATE_DIR
    ?? join(process.cwd(), '.qwen', 'bughunter', 'state', preset);
  mkdirSync(stateDir, { recursive: true });
  const ignore = join(stateDir, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, 'runs/\nauth/\n', 'utf8');
  process.env.BUGHUNTER_STATE_DIR = stateDir;
  await import(join(import.meta.dirname, 'presets', preset, 'src', 'index.ts'));
}

await main();
