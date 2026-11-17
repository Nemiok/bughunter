import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function writeLauncher({ pluginRoot, server, host, version }) {
  await mkdir(join(server, 'hosts'), { recursive: true });
  const launcher = await readFile(join(pluginRoot, 'launcher.mjs'), 'utf8');
  await writeFile(join(server, 'mcp.mjs'), launcher.replaceAll('__PLUGIN_VERSION__', version));
  await cp(join(pluginRoot, 'hosts', 'descriptor.mjs'), join(server, 'descriptor.mjs'));
  await cp(join(pluginRoot, 'hosts', 'descriptor.mjs'), join(server, 'hosts', 'descriptor.mjs'));
  await cp(join(pluginRoot, 'hosts', `${host.id}.mjs`), join(server, 'host.mjs'));
}
