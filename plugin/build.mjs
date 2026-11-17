import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

import { qwenHost } from './hosts/qwen.mjs';
import { buildServerPayload } from './payload.mjs';
import { writeLauncher } from './write-launcher.mjs';

const pluginRoot = resolve(import.meta.dirname);
const repoRoot = resolve(pluginRoot, '..');
const source = join(repoRoot, '.qwen');
const workspace = join(source, 'bughunter');
const out = join(pluginRoot, 'dist', 'bughunter');
const server = join(out, 'server');
const version = JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8')).version;

function insertAfterFrontmatter(text, block) {
  const lines = text.split('\n');
  let seen = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== '---') continue;
    seen += 1;
    if (seen === 2) {
      lines.splice(index + 1, 0, ...block.split('\n'));
      return lines.join('\n');
    }
  }
  throw new Error('SKILL_FRONTMATTER_NOT_FOUND');
}

function splitFrontmatter(text) {
  const lines = text.split('\n');
  let seen = 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== '---') continue;
    seen += 1;
    if (seen === 2) {
      return { head: lines.slice(0, index + 1).join('\n'), body: lines.slice(index + 1).join('\n') };
    }
  }
  throw new Error('SKILL_FRONTMATTER_NOT_FOUND');
}

function namedAgents(text, suffix) {
  return text
    .replace(/(?<![\w:-])bh-test-writer/g, `bughunter:bh-test-writer${suffix}`)
    .replace(/(?<![\w:-])bh-reviewer/g, `bughunter:bh-reviewer${suffix}`)
    .replace(/(?<![\w:-])bh-explorer/g, `bughunter:bh-explorer${suffix}`)
    .replace(/(?<!bughunter:)bughunter-oracles/g, 'bughunter:bughunter-oracles')
    .replace(/(?<!bughunter:)bughunter-red-test/g, 'bughunter:bughunter-red-test');
}

function namespacedSkillRefs(text) {
  return text.replace(
    /(?<!bughunter:)bughunter-(core-contract|preset-guide|oracles|red-test)/g,
    'bughunter:bughunter-$1',
  );
}

async function renderEntry() {
  let text = await readFile(join(source, 'skills', 'bughunter', 'SKILL.md'), 'utf8');
  const setup = await readFile(join(pluginRoot, 'prompts', 'setup.md'), 'utf8');
  text = text
    .replaceAll('bughunter-preset-card', '<card>')
    .replaceAll('bh-test-writer', '<writer>')
    .replaceAll('bh-reviewer', '<reviewer>')
    .replaceAll('bh-explorer', '<explorer>')
    .replace(
      '`Read` для `run.json` и файла инвентаря пресета при resume',
      '`Read` для `run.json`, файла инвентаря пресета и `.qwen/bughunter.json`',
    );
  const preamble = [
    '',
    'Сначала определи пресет проекта: прочитай `.qwen/bughunter.json` в корне проекта (`Read`). Поле `preset` — `web` или `node`; по умолчанию `web`. Если файла нет или в нём нет `preset`, остановись и скажи оператору выполнить установку Bughunter для этого проекта.',
    '',
    'Подстановки для вызовов ниже: для web — `<card>=bughunter:bughunter-preset-card-web`, `<explorer>=bughunter:bh-explorer`, `<reviewer>=bughunter:bh-reviewer`, `<writer>=bughunter:bh-test-writer`; для node — `<card>=bughunter:bughunter-preset-card-node`, `<explorer>=bughunter:bh-explorer-node`, `<reviewer>=bughunter:bh-reviewer-node`, `<writer>=bughunter:bh-test-writer-node`. Подставляй эти значения вместо угловых скобок.',
    '',
    'Состояние прогона: `.qwen/bughunter/state/<preset>/`. Если инструмент вернул `CONFIG_CREATED`, покажи путь оператору и остановись.',
    '',
    setup.trim(),
    '',
  ].join('\n');
  return insertAfterFrontmatter(text, preamble);
}

async function renderCard(from, name, suffix) {
  const { head, body } = splitFrontmatter(await readFile(from, 'utf8'));
  const title = head.replace(/^name:\s*bughunter-preset-card\s*$/m, `name: ${name}`);
  return `${title}\n${namedAgents(body, suffix)}`;
}

async function renderAgent(from, suffix, card) {
  const { head, body } = splitFrontmatter(await readFile(from, 'utf8'));
  const title = head.replace(/^(name:\s*\S+)\s*$/m, `$1${suffix}`);
  const rendered = namedAgents(body, suffix)
    .replace(/(?<!bughunter:)bughunter-preset-card/g, `bughunter:${card}`)
    .replaceAll('.qwen/bughunter/presets/web/state/', '.qwen/bughunter/state/web/')
    .replaceAll('.qwen/bughunter/presets/node/state/', '.qwen/bughunter/state/node/');
  return `${title}\n${rendered}`;
}

async function renderAuthoringSkill(from, preamble) {
  const { head, body } = splitFrontmatter(await readFile(from, 'utf8'));
  return insertAfterFrontmatter(`${head}\n${namespacedSkillRefs(body)}`, preamble);
}

async function writePromptLayer() {
  await mkdir(join(out, 'skills'), { recursive: true });
  await cp(join(source, 'skills', 'bughunter-oracles'), join(out, 'skills', 'bughunter-oracles'), { recursive: true });
  await cp(join(source, 'skills', 'bughunter-red-test'), join(out, 'skills', 'bughunter-red-test'), { recursive: true });
  await mkdir(join(out, 'skills', 'bughunter-core-contract'), { recursive: true });
  await writeFile(
    join(out, 'skills', 'bughunter-core-contract', 'SKILL.md'),
    await renderAuthoringSkill(
      join(source, 'skills', 'bughunter-core-contract', 'SKILL.md'),
      '\nВ плагине пути ниже даны для репозитория Bughunter; установленный шаблон — `<installPath>/template/cli-preset`, core — `<installPath>/server/core`, где `installPath` — поле из `qwen plugins list --json`.\n',
    ),
    'utf8',
  );
  await mkdir(join(out, 'skills', 'bughunter-preset-guide'), { recursive: true });
  await writeFile(
    join(out, 'skills', 'bughunter-preset-guide', 'SKILL.md'),
    await renderAuthoringSkill(
      join(source, 'skills', 'bughunter-preset-guide', 'SKILL.md'),
      '\nВ плагине шаблон — `<installPath>/template/cli-preset` (готовый CLI-пресет с фикстурой и приёмкой), core — `<installPath>/server/core`, бриф — `<installPath>/template/authoring-brief.md`, порядок — `<installPath>/AUTHORING.md`. `<installPath>` — поле из `qwen plugins list --json`. Шаги 1–2 ниже описывают репозиторную установку; в плагине не создавай `presets/<name>` и `.mcp.json` — копируй CLI-шаблон и работай по `AUTHORING.md`.\n',
    ),
    'utf8',
  );
  await mkdir(join(out, 'skills', 'bughunter'), { recursive: true });
  await writeFile(join(out, 'skills', 'bughunter', 'SKILL.md'), await renderEntry(), 'utf8');
  await mkdir(join(out, 'skills', 'bughunter-preset-card-web'), { recursive: true });
  await writeFile(
    join(out, 'skills', 'bughunter-preset-card-web', 'SKILL.md'),
    await renderCard(join(source, 'skills', 'bughunter-preset-card', 'SKILL.md'), 'bughunter-preset-card-web', ''),
    'utf8',
  );
  await mkdir(join(out, 'skills', 'bughunter-preset-card-node'), { recursive: true });
  await writeFile(
    join(out, 'skills', 'bughunter-preset-card-node', 'SKILL.md'),
    await renderCard(join(workspace, 'presets', 'node', 'skills', 'preset-card', 'SKILL.md'), 'bughunter-preset-card-node', '-node'),
    'utf8',
  );

  await mkdir(join(out, 'agents'), { recursive: true });
  for (const name of ['bh-explorer', 'bh-reviewer', 'bh-test-writer']) {
    await writeFile(
      join(out, 'agents', `${name}.md`),
      await renderAgent(join(source, 'agents', `${name}.md`), '', 'bughunter-preset-card-web'),
      'utf8',
    );
    await writeFile(
      join(out, 'agents', `${name}-node.md`),
      await renderAgent(join(workspace, 'presets', 'node', 'agents', `${name}.md`), '-node', 'bughunter-preset-card-node'),
      'utf8',
    );
  }
}

async function writeManifest() {
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

function validate() {
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

async function copyAuthoring() {
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

async function copySetupLayer() {
  await mkdir(join(server, 'hosts'), { recursive: true });
  await cp(join(pluginRoot, 'setup.mjs'), join(server, 'setup.mjs'));
  await cp(join(pluginRoot, 'preflight.mjs'), join(server, 'preflight.mjs'));
  await cp(join(pluginRoot, 'hosts', 'descriptor.mjs'), join(server, 'hosts', 'descriptor.mjs'));
}

async function main() {
  await rm(out, { recursive: true, force: true });
  await buildServerPayload({ workspace, server });
  await writeLauncher({ pluginRoot, server, host: qwenHost, version });
  await copySetupLayer();
  await writePromptLayer();
  await writeManifest();
  await cp(join(pluginRoot, 'README.md'), join(out, 'README.md'));
  await copyAuthoring();
  validate();
  const megabytes = (await sizeOf(out)) / 1024 / 1024;
  console.log(`built ${out} (${megabytes.toFixed(1)} MB)`);
}

await main();
