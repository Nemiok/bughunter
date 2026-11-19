import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

async function addPackage(directory, packages) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw new Error(`THIRD_PARTY_MANIFEST_INVALID: ${directory}`);
  }
  if (typeof manifest.name !== 'string' || manifest.name === ''
    || typeof manifest.version !== 'string' || manifest.version === '') {
    throw new Error(`THIRD_PARTY_MANIFEST_INVALID: ${directory}`);
  }
  const license = typeof manifest.license === 'string' ? manifest.license : JSON.stringify(manifest.license);
  let text;
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE']) {
    try {
      text = await readFile(join(directory, name), 'utf8');
      break;
    } catch {}
  }
  if (!license || !text) {
    throw new Error(`THIRD_PARTY_LICENSE_MISSING: ${directory}`);
  }
  packages.set(`${manifest.name}@${manifest.version}`, {
    name: manifest.name, version: manifest.version, license, text,
  });
}

async function walkModules(nodeModules, packages) {
  for (const entry of await readdir(nodeModules, { withFileTypes: true })) {
    if (entry.name === '.bin' || entry.isSymbolicLink() || !entry.isDirectory()) continue;
    if (entry.name.startsWith('@')) {
      const scope = join(nodeModules, entry.name);
      for (const child of await readdir(scope, { withFileTypes: true })) {
        if (child.isSymbolicLink() || !child.isDirectory()) continue;
        await addPackage(join(scope, child.name), packages);
        await walkNested(join(scope, child.name), packages);
      }
      continue;
    }
    const directory = join(nodeModules, entry.name);
    await addPackage(directory, packages);
    await walkNested(directory, packages);
  }
}

async function walkNested(directory, packages) {
  try {
    await walkModules(join(directory, 'node_modules'), packages);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export async function generateNotices({ nodeModules, out }) {
  const packages = new Map();
  await walkModules(nodeModules, packages);
  const sections = [...packages.values()]
    .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`))
    .map((item) => [
      `## ${item.name}@${item.version}`,
      '',
      `License: ${item.license}`,
      '',
      ...item.text.trim().split('\n').map((line) => {
        const cleaned = line.replace(/[ \t]+$/, '');
        return cleaned === '' ? '' : `    ${cleaned}`;
      }),
    ].join('\n'));
  const content = ['# Third-party notices', '', 'Bundled production packages and their license texts.', '', ...sections, ''].join('\n');
  await writeFile(out, content, 'utf8');
  return packages.size;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const args = process.argv.slice(2);
  const nodeModules = args[args.indexOf('--node-modules') + 1];
  const out = args[args.indexOf('--out') + 1];
  if (!nodeModules || !out) throw new Error('USAGE: node notices.mjs --node-modules <dir> --out <file>');
  const count = await generateNotices({ nodeModules, out });
  console.log(`third-party packages: ${count}`);
}
