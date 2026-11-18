import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { qwenHost } from './hosts/qwen.mjs';
import { writeLauncher } from './write-launcher.mjs';

export async function buildQwenMcpOnly({ pluginRoot, sharedServer, out, version }) {
  await mkdir(join(out, 'skills', 'bughunter-setup'), { recursive: true });
  const server = join(out, 'server');
  await cp(sharedServer, server, { recursive: true });
  await writeLauncher({ pluginRoot, server, host: qwenHost, version });
  await cp(join(pluginRoot, 'setup.mjs'), join(server, 'setup.mjs'));
  await cp(join(pluginRoot, 'preflight.mjs'), join(server, 'preflight.mjs'));
  await cp(join(pluginRoot, 'prompts', 'mcp-only-setup.md'), join(out, 'skills', 'bughunter-setup', 'SKILL.md'));
  const manifest = {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: 'bughunter-mcp',
    version,
    description: 'MCP-only; full workflow not certified. Local Bughunter tools with explicit project setup.',
  };
  const mcp = {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
    mcpServers: {
      bughunter: { type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/server/mcp.mjs'] },
    },
  };
  await writeFile(join(out, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(out, 'mcp.json'), `${JSON.stringify(mcp, null, 2)}\n`);
  await writeFile(join(out, 'README.md'), '# Bughunter MCP-only\n\nMCP-only; full workflow not certified.\n\nInstall through `qwen extensions install <published-source>`; this is an extension channel, not a marketplace listing.\n');
}
