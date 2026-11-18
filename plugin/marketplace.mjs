import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { archiveSource } from './archive.mjs';

export async function buildNativeMarketplace({ pluginDir, marketplaceRoot, version, marketplaceName, description }) {
  const destination = join(marketplaceRoot, 'plugins', 'bughunter');
  await mkdir(join(marketplaceRoot, '.claude-plugin'), { recursive: true });
  await cp(pluginDir, destination, { recursive: true });
  const catalog = {
    name: marketplaceName,
    description,
    owner: { name: 'Bughunter' },
    plugins: [{
      name: 'bughunter',
      description: 'Evidence-based bug hunting with reproduction and red regression tests.',
      version,
      source: './plugins/bughunter',
      author: { name: 'Bughunter' },
    }],
  };
  await writeFile(
    join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
    `${JSON.stringify(catalog, null, 2)}\n`,
    'utf8',
  );
}

export async function buildQwenMarketplace({ pluginDir, marketplaceRoot, version }) {
  return buildNativeMarketplace({
    pluginDir,
    marketplaceRoot,
    version,
    marketplaceName: 'bughunter-market',
    description: 'Bughunter releases: evidence-based bug hunting for Qwen Code',
  });
}

export async function buildClaudeMarketplace({ pluginDir, marketplaceRoot, version }) {
  return buildNativeMarketplace({
    pluginDir,
    marketplaceRoot,
    version,
    marketplaceName: 'bughunter-market',
    description: 'Bughunter releases for Claude Code CLI and Desktop Code sessions',
  });
}

export async function buildQwenArchiveMarketplace({
  marketplaceRoot, version, archiveUrl, sha256, payloadCommit, repository,
}) {
  if (!/^[a-f0-9]{40}$/.test(payloadCommit)) throw new Error('SOURCE_INVALID');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('MARKETPLACE_REPOSITORY_INVALID');
  await mkdir(join(marketplaceRoot, '.claude-plugin'), { recursive: true });
  const catalog = {
    name: 'bughunter-market',
    description: 'Bughunter releases: evidence-based bug hunting for Qwen Code',
    owner: { name: 'Bughunter' },
    plugins: [{
      name: 'bughunter',
      description: 'Evidence-based bug hunting with reproduction and red regression tests.',
      version,
      source: archiveSource({ url: archiveUrl, sha256 }),
      repository: `https://github.com/${repository}`,
      homepage: `https://github.com/${repository}`,
      author: { name: 'Bughunter' },
      metadata: { payloadCommit },
    }],
  };
  await writeFile(
    join(marketplaceRoot, '.claude-plugin', 'marketplace.json'),
    `${JSON.stringify(catalog, null, 2)}\n`,
    'utf8',
  );
}
