import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import { kimiHost, kimiManifest } from './hosts/kimi.mjs';
import { qwenHost } from './hosts/qwen.mjs';
import { buildQwenMarketplace } from './marketplace.mjs';
import { buildServerPayload } from './payload.mjs';
import { renderPromptLayer } from './prompts.mjs';
import { writeLauncher } from './write-launcher.mjs';

const pluginRoot = resolve(import.meta.dirname);
const repoRoot = resolve(pluginRoot, '..');
const source = join(repoRoot, '.qwen');
const workspace = join(source, 'bughunter');
const version = JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8')).version;

const args = process.argv.slice(2);
const requested = args.includes('--host') ? args[args.indexOf('--host') + 1] : 'qwen';
if (!['qwen', 'kimi', 'all'].includes(requested)) throw new Error(`HOST_INVALID: ${requested}`);
const hosts = requested === 'all' ? [qwenHost, kimiHost] : [requested === 'qwen' ? qwenHost : kimiHost];

async function writeManifest(host, out) {
  if (host.id === 'kimi') {
    await writeFile(join(out, 'kimi.plugin.json'), `${JSON.stringify(kimiManifest(version), null, 2)}\n`, 'utf8');
    return;
  }
  const manifest = {
    name: 'bughunter',
    version,
    description: 'Доказательный поиск багов в работающем приложении: воспроизведение, красные регрессионные тесты и отчёт.',
    skills: [
      './skills/bughunter',
      './skills/bughunter-oracles',
      './skills/bughunter-red-test',
      './skills/bughunter-preset-card-web',
      './skills/bughunter-preset-card-node',
      './skills/bughunter-preset-guide',
      './skills/bughunter-core-contract',
    ],
    agents: [
      './agents/bh-explorer.md',
      './agents/bh-reviewer.md',
      './agents/bh-test-writer.md',
      './agents/bh-explorer-node.md',
      './agents/bh-reviewer-node.md',
      './agents/bh-test-writer-node.md',
    ],
    mcpServers: {
      bughunter: {
        command: 'node',
        args: ['${CLAUDE_PLUGIN_ROOT}/server/mcp.mjs'],
      },
    },
  };
  await mkdir(join(out, '.claude-plugin'), { recursive: true });
  await writeFile(join(out, '.claude-plugin', 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function validateQwen(out) {
  const result = spawnSync('qwen', ['plugins', 'validate', '--json', '--strict', out], { encoding: 'utf8' });
  if (result.error !== undefined) {
    console.warn(`qwen not found; skipping plugin validation: ${result.error.message}`);
    return;
  }
  if (result.status !== 0) {
    console.error(result.stdout || result.stderr);
    throw new Error(`PLUGIN_INVALID: ${out}`);
  }
  const report = JSON.parse(result.stdout);
  if (report.ok !== true) {
    console.error(JSON.stringify(report.report?.diagnostics ?? report, null, 2));
    throw new Error(`PLUGIN_INVALID: ${out}`);
  }
  console.log(`plugin validation: ${report.report?.summary?.componentCount ?? '?'} components`);
}

async function sizeOf(path) {
  const info = await stat(path);
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    total += await sizeOf(join(path, entry.name));
  }
  return total;
}

async function copyAuthoring(out) {
  const examples = join(repoRoot, 'docs', 'concept', 'examples', 'cli-preset');
  await cp(examples, join(out, 'template', 'cli-preset'), {
    recursive: true,
    filter: (path) => {
      const rel = relative(examples, path);
      if (rel === '') return true;
      const parts = rel.split(sep);
      if (parts.some((part) => part === 'node_modules' || part.startsWith('.test-') || part === '.DS_Store')) return false;
      return !(parts.includes('state') && (parts.includes('runs') || parts.includes('auth')));
    },
  });
  await cp(join(pluginRoot, 'authoring-brief.md'), join(out, 'template', 'authoring-brief.md'));
  await cp(join(pluginRoot, 'AUTHORING.md'), join(out, 'AUTHORING.md'));
}

async function copySetupLayer(server) {
  await mkdir(join(server, 'hosts'), { recursive: true });
  await cp(join(pluginRoot, 'setup.mjs'), join(server, 'setup.mjs'));
  await cp(join(pluginRoot, 'preflight.mjs'), join(server, 'preflight.mjs'));
  await cp(join(pluginRoot, 'hosts', 'descriptor.mjs'), join(server, 'hosts', 'descriptor.mjs'));
}

async function writeKimiMarketplace() {
  const catalog = {
    version: '2',
    plugins: [{
      id: 'bughunter',
      displayName: 'Bughunter',
      description: kimiManifest(version).description,
      version,
      source: join(pluginRoot, kimiHost.outDir),
      clients: ['cli', 'desktop'],
      platforms: ['darwin', 'win32', 'linux'],
    }],
  };
  await writeFile(join(pluginRoot, 'dist', 'kimi-marketplace.json'), `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
}

async function main() {
  const shared = join(pluginRoot, 'dist', '.shared-server');
  try {
    await buildServerPayload({ workspace, server: shared });
    for (const host of hosts) {
      const out = join(pluginRoot, host.outDir);
      const server = join(out, 'server');
      await rm(out, { recursive: true, force: true });
      await cp(shared, server, { recursive: true, dereference: true });
      await writeLauncher({ pluginRoot, server, host, version });
      await copySetupLayer(server);
      await renderPromptLayer({ host, source, workspace, out });
      await writeManifest(host, out);
      await copyAuthoring(out);
      const readme = host.id === 'kimi'
        ? join(pluginRoot, 'hosts', 'kimi.README.md')
        : join(pluginRoot, 'README.md');
      await cp(readme, join(out, 'README.md'));
      if (host.id === 'qwen') {
        await rm(join(pluginRoot, 'dist', 'qwen-marketplace'), { recursive: true, force: true });
        validateQwen(out);
        await buildQwenMarketplace({
          pluginDir: out,
          marketplaceRoot: join(pluginRoot, 'dist', 'qwen-marketplace'),
          version,
        });
      } else {
        await cp(join(pluginRoot, 'hooks'), join(out, 'hooks'), { recursive: true });
        await writeKimiMarketplace();
      }
      const megabytes = (await sizeOf(out)) / 1024 / 1024;
      console.log(`built ${out} (${megabytes.toFixed(1)} MB)`);
    }
  } finally {
    await rm(shared, { recursive: true, force: true });
  }
}

await main();
