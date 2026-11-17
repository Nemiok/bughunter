import { createRequire } from 'node:module';
import { join } from 'node:path';

async function load(serverRoot, relative) {
  const require = createRequire(join(serverRoot, 'package.json'));
  return require(require.resolve(`@modelcontextprotocol/sdk/${relative}`));
}

export async function withMcpClient(serverRoot, cwd, callback, env = {}) {
  const { Client } = await load(serverRoot, 'client/index.js');
  const { StdioClientTransport } = await load(serverRoot, 'client/stdio.js');
  const client = new Client({ name: 'bh-install-test', version: '0.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(serverRoot, 'mcp.mjs')],
    cwd,
    env: { ...process.env, ...env },
  });
  try {
    await client.connect(transport);
    return await callback(client);
  } finally {
    await client.close();
  }
}
