import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const pluginRoot = resolve(import.meta.dirname);

const KNOWN_TOKENS = new Set(['card', 'explorer', 'reviewer', 'writer', 'preset', 'template', 'path', 'pointer', 'refresh']);

function assertNoUnknownTokens(text, where) {
  for (const match of text.matchAll(/<([a-z-]+)>/g)) {
    if (!KNOWN_TOKENS.has(match[1])) {
      throw new Error(`PROMPT_TOKEN_UNKNOWN: ${match[0]} in ${where}`);
    }
  }
}

function hostText(text, host) {
  const rendered = text
    .replaceAll('<optIn>', host.optInPath)
    .replaceAll('<setupTool>', `${host.mcpToolPrefix}bh_setup`)
    .replaceAll('<reload>', host.reloadInstruction)
    .replaceAll('<refresh>', host.refreshInstruction)
    .replaceAll('mcp__bughunter__', host.mcpToolPrefix)
    .replaceAll('.qwen/bughunter.json', host.optInPath)
    .replaceAll('.qwen/bughunter/state/<preset>/', `${host.stateRoot}/<preset>/`)
    .replaceAll('.qwen/bughunter/presets/web/state/', `${host.stateRoot}/web/`)
    .replaceAll('.qwen/bughunter/presets/node/state/', `${host.stateRoot}/node/`)
    .replaceAll('.qwen/bughunter/state/', `${host.stateRoot}/`)
    .replaceAll('/plugins reload', host.reloadInstruction);
  assertNoUnknownTokens(rendered, host.id);
  return rendered;
}

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

async function renderEntry(source, host) {
  let text = await readFile(join(source, 'skills', 'bughunter', 'SKILL.md'), 'utf8');
  text = text.replace(/^disable-model-invocation:\s*true\s*$/m, 'disable-model-invocation: false');
  const setupName = host.setupMode === 'cli' ? 'setup-cli.md' : 'setup.md';
  const setup = await readFile(join(pluginRoot, 'prompts', setupName), 'utf8');
  text = text
    .replaceAll('bughunter-preset-card', '<card>')
    .replaceAll('bh-test-writer', '<writer>')
    .replaceAll('bh-reviewer', '<reviewer>')
    .replaceAll('bh-explorer', '<explorer>')
    .replace(
      '`Read` для `run.json` и файла инвентаря пресета при resume',
      '`Read` для `run.json`, файла инвентаря пресета и `.qwen/bughunter.json`',
    );
  const presetInstruction = host.setupMode === 'cli'
    ? 'Сначала определи пресет проекта: прочитай `.qwen/bughunter.json` в корне проекта (`Read`). Поле `preset` — `web` или `node`. Если файла нет, выполни setup-инструкцию ниже; не останавливайся и не проси ручной installer.'
    : 'Сначала определи пресет проекта: прочитай `.qwen/bughunter.json` в корне проекта (`Read`). Поле `preset` — `web` или `node`; по умолчанию `web`. Если файла нет или в нём нет `preset`, остановись и скажи оператору выполнить установку Bughunter для этого проекта.';
  const stateInstruction = host.setupMode === 'cli'
    ? 'Состояние прогона: `.qwen/bughunter/state/<preset>/`. При `CONFIG_CREATED` от setup CLI заполни config по инструкции ниже и продолжи validate; не останавливайся.'
    : 'Состояние прогона: `.qwen/bughunter/state/<preset>/`. Если инструмент вернул `CONFIG_CREATED`, покажи путь оператору и остановись.';
  const preamble = [
    '',
    presetInstruction,
    '',
    'Подстановки для вызовов ниже: для web — `<card>=bughunter:bughunter-preset-card-web`, `<explorer>=bughunter:bh-explorer`, `<reviewer>=bughunter:bh-reviewer`, `<writer>=bughunter:bh-test-writer`; для node — `<card>=bughunter:bughunter-preset-card-node`, `<explorer>=bughunter:bh-explorer-node`, `<reviewer>=bughunter:bh-reviewer-node`, `<writer>=bughunter:bh-test-writer-node`. Подставляй эти значения вместо угловых скобок.',
    '',
    stateInstruction,
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

export async function renderPromptLayer({ host, source, workspace, out }) {
  await mkdir(join(out, 'skills'), { recursive: true });
  await cp(join(source, 'skills', 'bughunter-oracles'), join(out, 'skills', 'bughunter-oracles'), { recursive: true });
  await cp(join(source, 'skills', 'bughunter-red-test'), join(out, 'skills', 'bughunter-red-test'), { recursive: true });
  for (const [name, sourcePath, preamble] of [
    ['bughunter-core-contract', join(source, 'skills', 'bughunter-core-contract', 'SKILL.md'), '\nВ плагине пути ниже даны для репозитория Bughunter; установленный шаблон — `<installPath>/template/cli-preset`, core — `<installPath>/server/core`.\n'],
    ['bughunter-preset-guide', join(source, 'skills', 'bughunter-preset-guide', 'SKILL.md'), '\nВ плагине шаблон — `<installPath>/template/cli-preset`, core — `<installPath>/server/core`, бриф — `<installPath>/template/authoring-brief.md`, порядок — `<installPath>/AUTHORING.md`. Не создавай репозиторные presets или `.mcp.json`.\n'],
  ]) {
    await mkdir(join(out, 'skills', name), { recursive: true });
    await writeFile(join(out, 'skills', name, 'SKILL.md'), await renderAuthoringSkill(sourcePath, preamble), 'utf8');
  }
  await mkdir(join(out, 'skills', 'bughunter'), { recursive: true });
  await writeFile(join(out, 'skills', 'bughunter', 'SKILL.md'), hostText(await renderEntry(source, host), host));
  for (const [suffix, preset] of [['web', 'web'], ['node', 'node']]) {
    const name = `bughunter-preset-card-${suffix}`;
    const from = preset === 'web'
      ? join(source, 'skills', 'bughunter-preset-card', 'SKILL.md')
      : join(workspace, 'presets', 'node', 'skills', 'preset-card', 'SKILL.md');
    await mkdir(join(out, 'skills', name), { recursive: true });
    await writeFile(join(out, 'skills', name, 'SKILL.md'), hostText(await renderCard(from, name, suffix === 'node' ? '-node' : ''), host));
  }
  await mkdir(join(out, 'agents'), { recursive: true });
  for (const name of ['bh-explorer', 'bh-reviewer', 'bh-test-writer']) {
    const webAgent = hostText(await renderAgent(join(source, 'agents', `${name}.md`), '', 'bughunter-preset-card-web'), host);
    const nodeAgent = hostText(await renderAgent(join(workspace, 'presets', 'node', 'agents', `${name}.md`), '-node', 'bughunter-preset-card-node'), host);
    await writeFile(join(out, 'agents', `${name}.md`), webAgent);
    await writeFile(join(out, 'agents', `${name}-node.md`), nodeAgent);
  }
}
