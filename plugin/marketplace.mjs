import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function buildQwenMarketplace({ pluginDir, marketplaceRoot, version }) {
  const destination = join(marketplaceRoot, 'plugins', 'bughunter');
  await mkdir(join(marketplaceRoot, '.claude-plugin'), { recursive: true });
  await cp(pluginDir, destination, { recursive: true });
  const catalog = {
    name: 'bughunter-market',
    description: 'Bughunter releases: evidence-based bug hunting for Qwen Code',
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
