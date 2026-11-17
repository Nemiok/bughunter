import { spawnSync } from 'node:child_process';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

async function copyTree(from, to) {
  await cp(from, to, {
    recursive: true,
    filter: (path) => {
      const rel = relative(from, path);
      if (rel === '') return true;
      return !rel.split(sep).some((part) => ['node_modules', 'test', 'state'].includes(part))
        && !path.endsWith('ACCEPTANCE.md')
        && !path.endsWith('.tsbuildinfo');
    },
  });
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else files.push(path);
  }
  return files;
}

async function rewriteCoreImports(server) {
  const coreEntry = join(server, 'core', 'src', 'index.ts');
  for (const file of await walk(join(server, 'presets'))) {
    if (!file.endsWith('.ts')) continue;
    let text = await readFile(file, 'utf8');
    if (!text.includes('@bughunter/core')) continue;
    let rel = relative(dirname(file), coreEntry).split(sep).join('/');
    if (!rel.startsWith('.')) rel = `./${rel}`;
    text = text
      .replaceAll("'@bughunter/core'", `'${rel}'`)
      .replaceAll('"@bughunter/core"', `"${rel}"`);
    await writeFile(file, text, 'utf8');
  }
  const leftovers = (await walk(join(server, 'presets')))
    .filter((file) => file.endsWith('.ts'))
    .filter((file) => existsSync(file));
  for (const file of leftovers) {
    if ((await readFile(file, 'utf8')).includes('@bughunter/core')) {
      throw new Error(`CORE_IMPORT_NOT_REWRITTEN: ${file}`);
    }
  }
}

export async function buildServerPayload({ workspace, server }) {
  await rm(server, { recursive: true, force: true });
  await mkdir(server, { recursive: true });
  await copyTree(join(workspace, 'core'), join(server, 'core'));
  await cp(join(workspace, 'presets'), join(server, 'presets'), {
    recursive: true,
    filter: (path) => !path.split(/[\\/]/).some((part) =>
      ['node_modules', 'test', 'state'].includes(part)),
  });
  await cp(join(workspace, 'package.json'), join(server, 'package.json'));
  await cp(join(workspace, 'package-lock.json'), join(server, 'package-lock.json'));
  const install = spawnSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: server,
    stdio: 'inherit',
  });
  if (install.status !== 0) throw new Error(`NPM_CI_FAILED: ${server}`);
  await rm(join(server, 'node_modules', '@bughunter'), { recursive: true, force: true });
  await rewriteCoreImports(server);
}
