import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { hostPaths } from './hosts/descriptor.mjs';
import { checkPrerequisites } from './preflight.mjs';

async function writeNew(file, text, created) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' });
    await link(temporary, file);
    created.push(file);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function templateFor(serverRoot, preset) {
  const file = join(serverRoot, 'presets', preset, 'src', 'config.ts');
  const module = await import(pathToFileURL(file).href);
  return preset === 'web' ? module.webConfigTemplate() : module.nodeConfigTemplate();
}

export async function setupProject({ host, projectRoot, preset, serverRoot, preflight = checkPrerequisites }) {
  if (!['web', 'node'].includes(preset)) throw new Error(`BUGHUNTER_PRESET_INVALID: ${preset}`);
  const missing = await preflight(preset);
  if (missing.length > 0) throw new Error(`PREREQUISITES_MISSING: ${missing.join(', ')}`);
  const paths = hostPaths(host, projectRoot, preset);
  if (existsSync(paths.optIn)) {
    let existing;
    try { existing = JSON.parse(await readFile(paths.optIn, 'utf8')); }
    catch { throw new Error(`SETUP_OPT_IN_INVALID: ${paths.optIn}`); }
    if (existing.preset !== preset) throw new Error(`SETUP_PRESET_CONFLICT: ${paths.optIn}`);
  }
  const created = [];
  try {
    if (!existsSync(paths.optIn)) {
      await writeNew(paths.optIn, `${JSON.stringify({ preset }, null, 2)}\n`, created);
    }
    if (!existsSync(paths.configPath)) {
      const template = await templateFor(serverRoot, preset);
      await writeNew(paths.configPath, `${JSON.stringify(template, null, 2)}\n`, created);
    }
    const ignore = join(paths.stateDir, '.gitignore');
    if (!existsSync(ignore)) await writeNew(ignore, 'runs/\nauth/\n', created);
  } catch (error) {
    await Promise.all(created.reverse().map((file) => rm(file, { force: true })));
    throw error;
  }
  return {
    code: created.includes(paths.configPath) ? 'CONFIG_CREATED' : 'SETUP_READY',
    optInPath: paths.optIn,
    configPath: paths.configPath,
    reload: host.reloadInstruction,
  };
}

export async function startDormantServer({ host, version, serverRoot, projectRoot }) {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { z } = await import('zod');
  const server = new McpServer({ name: 'bughunter', version });
  server.registerTool('bh_setup', {
    description: 'Создать opt-in и config после явного выбора web/node; не запускает исследование',
    inputSchema: { preset: z.enum(['web', 'node']) },
  }, async ({ preset }) => {
    try {
      const value = await setupProject({ host, projectRoot, preset, serverRoot });
      return { content: [{ type: 'text', text: JSON.stringify(value) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text', text: message }], isError: true };
    }
  });
  await server.connect(new StdioServerTransport());
}
