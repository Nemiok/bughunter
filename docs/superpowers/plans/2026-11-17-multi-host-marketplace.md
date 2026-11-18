# Multi-Host Marketplace Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Собирать из одного Bughunter source commit нативные Qwen, Kimi и Claude плагины с marketplace-установкой, безопасным first-run setup, сохранением state и доказанными уровнями full/MCP-only.

**Architecture:** Общий core/presets payload не знает о хостах; descriptors и renderers в `plugin/hosts/` создают нативные пакеты. Один launcher использует descriptor для opt-in/state, а dormant MCP отдаёт только `bh_setup`. Каждый хост получает независимые install/update gates, а статус `full` появляется только после живых модельных гейтов.

**Tech Stack:** Node.js >=22.18, JavaScript `.mjs`, TypeScript presets с Node type stripping, `node:test`, `node:assert/strict`, Zod, MCP SDK, npm workspaces, Qwen Code CLI, Kimi Code CLI/Desktop, Claude Code CLI/Desktop, Agent Plugins v1 JSON Schema.

## Global Constraints

- Канонический дизайн: `docs/superpowers/specs/2026-11-17-multi-host-marketplace-design.md`; все его границы обязательны.
- Не добавлять runtime-зависимости. Использовать Node builtins, существующие MCP SDK/Zod и уже установленные CLI. Не менять lockfiles без новой dependency-необходимости; этот план её не предполагает.
- Core и presets не импортируют host adapters и не получают host-specific branches/paths. Существующие `presets/*/src/cli-host.ts` удаляются в пользу нейтрального dependency message.
- Qwen сохраняет `.qwen/bughunter.json`, `.qwen/bughunter/state/<preset>/`, `dist/bughunter` и текущий `install.mjs` flow. Kimi использует `.kimi-code/`, Claude — `.claude/`.
- Полный web/node наборы остаются 19/16 tools. Dormant отдаёт ровно один `bh_setup` и не создаёт state до вызова; активный набор не включает `bh_setup`.
- `BUGHUNTER_PRESET` и `BUGHUNTER_STATE_DIR` сохраняются как явные operator/test overrides.
- Полный пакет называется `bughunter`; ограниченный — `bughunter-mcp`. Нет незаметного fallback между ними.
- Не редактировать вручную `plugin/dist/` или `plugin/release/`; не подменять артефакты `v0.1.0` и его SHA/marketplace.
- Не читать реальные credentials, auth state или секретные config files. Изолированные тесты используют временные HOME/config dirs и dummy values.
- Все модельные прогоны — только после отдельного явного разрешения, на локальных фикстурах `127.0.0.1`. Этот план сам по себе таким разрешением не является.
- Push, official/curated submission и публикация marketplace — только после отдельного явного разрешения.
- Commit-шаги выполняются только если пользователь отдельно разрешил implementation commits. Иначе шаг пропускается, а незакоммиченные файлы перечисляются в отчёте.
- На момент планирования доступны Qwen `1.0.0-preview.1` и Kimi `2.5.3`; `claude` в PATH отсутствует. Claude install/model gates нельзя отмечать выполненными до установки клиента и записи его версии.
- Команды запускаются из `/Users/nemiok/Desktop/projects/vault/bughunter`, если блок явно не делает `cd`. После блока возвращаться в этот корень.
- После node acceptance восстановить `.qwen/bughunter/fixtures/node-api-app/ACCEPTANCE.md` из Git; не удалять существующий untracked `docs/superpowers/plans/2026-11-17-docs-c1-c20.md`.

## File Structure

- `plugin/hosts/descriptor.mjs` — общая валидация descriptor, host paths и MCP tool naming.
- `plugin/hosts/qwen.mjs`, `kimi.mjs`, `claude.mjs` — единственное место host-specific paths, manifest и prompt conventions.
- `plugin/launcher.mjs` — тонкий выбор dormant/preset и state override.
- `plugin/setup.mjs` — транзакционный first-run setup; `plugin/preflight.mjs` — Node/Git/Chrome checks.
- `plugin/build.mjs` — orchestration; `plugin/payload.mjs` — общий server payload; `plugin/prompts.mjs` — общий prompt renderer.
- `plugin/marketplace.mjs` — native marketplace generation; `plugin/release.mjs` — versioned bundles/checksums/support matrix.
- `plugin/test/*.test.mjs` — быстрые unit/artifact tests; `plugin/test/*-install.mjs` — реальные CLI/MCP integration gates.
- `plugin/evidence/<host>/...` — только локальные machine-readable gate results; в release попадают проверенные ссылки, не секреты/полные transcripts.
- Активные README/operator docs обновляются в задаче соответствующего хоста; исторические reports/handoff не переписываются.

---

### Task 1: Host Descriptor Contract

**Files:**
- Create: `plugin/hosts/descriptor.mjs`
- Create: `plugin/hosts/qwen.mjs`
- Create: `plugin/test/host-descriptors.test.mjs`
- Modify: `plugin/package.json`

**Interfaces:**
- Consumes: ничего из новых задач; использует только Node builtins.
- Produces: `defineHostDescriptor(value)`, `hostPaths(host, projectRoot, preset)`, `mcpToolName(host, tool)`, `qwenHost`/`host`. Все последующие задачи используют поля `id`, `pluginId`, `outDir`, `pluginRoot`, `optInPath`, `stateRoot`, `mcpToolPrefix`, `skillNamespace`, `agentNamespace`, `reloadInstruction`, `refreshInstruction`.

- [ ] **Step 1: Написать failing tests на paths, tool names и запрет unsafe paths**

```js
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { defineHostDescriptor, hostPaths, mcpToolName } from '../hosts/descriptor.mjs';
import { qwenHost } from '../hosts/qwen.mjs';

test('qwen descriptor preserves the installed layout', () => {
  assert.equal(qwenHost.id, 'qwen');
  assert.equal(qwenHost.outDir, 'dist/bughunter');
  assert.equal(qwenHost.pluginRoot, '${CLAUDE_PLUGIN_ROOT}');
  assert.equal(mcpToolName(qwenHost, 'bh_start_run'), 'mcp__bughunter__bh_start_run');
  const paths = hostPaths(qwenHost, '/tmp/project', 'web');
  assert.equal(paths.optIn, join('/tmp/project', '.qwen', 'bughunter.json'));
  assert.equal(paths.stateDir, join('/tmp/project', '.qwen', 'bughunter', 'state', 'web'));
  assert.equal(paths.configPath, join(paths.stateDir, 'config.json'));
});

test('descriptor rejects absolute and escaping project paths', () => {
  for (const [field, value] of [['optInPath', '/tmp/x'], ['stateRoot', '../x']]) {
    assert.throws(
      () => defineHostDescriptor({ ...qwenHost, [field]: value }),
      new Error(`HOST_DESCRIPTOR_INVALID: ${field}`),
    );
  }
});

test('MCP tool naming accepts only Bughunter tool identifiers', () => {
  assert.throws(() => mcpToolName(qwenHost, 'Read'), /MCP_TOOL_INVALID: Read/);
});
```

- [ ] **Step 2: Запустить тест и убедиться в RED**

Run: `node --test plugin/test/host-descriptors.test.mjs`
Expected: FAIL с `Cannot find module .../plugin/hosts/descriptor.mjs`.

- [ ] **Step 3: Добавить минимальную реализацию descriptor**

`plugin/hosts/descriptor.mjs`:

```js
import { isAbsolute, join } from 'node:path';

const fields = [
  'id', 'pluginId', 'outDir', 'pluginRoot', 'optInPath', 'stateRoot',
  'mcpToolPrefix', 'skillNamespace', 'agentNamespace', 'reloadInstruction', 'refreshInstruction',
];

export function defineHostDescriptor(value) {
  for (const field of fields) {
    if (typeof value?.[field] !== 'string' || value[field].length === 0) {
      throw new Error(`HOST_DESCRIPTOR_INVALID: ${field}`);
    }
  }
  for (const field of ['optInPath', 'stateRoot']) {
    const parts = value[field].split(/[\\/]/);
    if (isAbsolute(value[field]) || parts.includes('..')) {
      throw new Error(`HOST_DESCRIPTOR_INVALID: ${field}`);
    }
  }
  if (!/^mcp__[a-z0-9_-]+__$/.test(value.mcpToolPrefix)) {
    throw new Error('HOST_DESCRIPTOR_INVALID: mcpToolPrefix');
  }
  return Object.freeze({ ...value });
}

export function hostPaths(host, projectRoot, preset) {
  if (!['web', 'node'].includes(preset)) throw new Error(`BUGHUNTER_PRESET_INVALID: ${preset}`);
  const stateDir = join(projectRoot, host.stateRoot, preset);
  return {
    optIn: join(projectRoot, host.optInPath),
    stateDir,
    configPath: join(stateDir, 'config.json'),
  };
}

export function mcpToolName(host, tool) {
  if (!/^bh_[a-z_]+$/.test(tool)) throw new Error(`MCP_TOOL_INVALID: ${tool}`);
  return `${host.mcpToolPrefix}${tool}`;
}
```

`plugin/hosts/qwen.mjs`:

```js
import { defineHostDescriptor } from './descriptor.mjs';

export const qwenHost = defineHostDescriptor({
  id: 'qwen',
  pluginId: 'bughunter',
  outDir: 'dist/bughunter',
  pluginRoot: '${CLAUDE_PLUGIN_ROOT}',
  optInPath: '.qwen/bughunter.json',
  stateRoot: '.qwen/bughunter/state',
  mcpToolPrefix: 'mcp__bughunter__',
  skillNamespace: 'bughunter:',
  agentNamespace: 'bughunter:',
  reloadInstruction: '/plugins reload',
  refreshInstruction: '`/plugins reload` (или открой новую сессию)',
});

export const host = qwenHost;
```

- [ ] **Step 4: Подключить `node:test` и проверить GREEN**

Добавить в `plugin/package.json` scripts, сохранив существующие:

```json
{
  "scripts": {
    "build": "node build.mjs",
    "setup": "node install.mjs",
    "test": "node --test --test-concurrency=1 test/*.test.mjs",
    "test:install": "node test-install.mjs"
  }
}
```

Run: `cd plugin && npm test`
Expected: `tests 3`, `pass 3`, `fail 0`.

- [ ] **Step 5: Commit при разрешении**

```sh
git add plugin/hosts/descriptor.mjs plugin/hosts/qwen.mjs plugin/test/host-descriptors.test.mjs plugin/package.json
git commit -m "feat: add host descriptor contract"
```

---

### Task 2: Host-Neutral Launcher and Qwen Regression

**Files:**
- Create: `plugin/payload.mjs`
- Create: `plugin/write-launcher.mjs`
- Create: `plugin/test/launcher.test.mjs`
- Modify: `plugin/launcher.mjs`
- Modify: `plugin/build.mjs`
- Modify: `.qwen/bughunter/presets/web/src/index.ts:3,10`
- Modify: `.qwen/bughunter/presets/node/src/index.ts`
- Modify: `.qwen/bughunter/presets/web/test/core-integration.bhtest.ts:496`
- Delete: `.qwen/bughunter/presets/web/src/cli-host.ts`
- Delete: `.qwen/bughunter/presets/node/src/cli-host.ts`

**Interfaces:**
- Consumes: `host`, `hostPaths` из Task 1.
- Produces: `buildServerPayload({ workspace, server })`, `writeLauncher({ pluginRoot, server, host, version })`; launcher импортирует bundled `./host.mjs` и `./descriptor.mjs`. `webConfigTemplate` остаётся внутренним до Task 3.

- [ ] **Step 1: Добавить failing artifact/boundary test**

```js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('launcher and preset runtime contain no hard-coded host directory', async () => {
  const launcher = await readFile('plugin/launcher.mjs', 'utf8');
  assert.ok(!launcher.includes("'.qwen'"));
  for (const preset of ['web', 'node']) {
    const entry = await readFile(`.qwen/bughunter/presets/${preset}/src/index.ts`, 'utf8');
    assert.ok(!entry.includes('cli-host.ts'));
    assert.ok(!entry.includes('cd .qwen/'));
  }
});
```

Run: `node --test plugin/test/launcher.test.mjs`
Expected: FAIL на `launcher.includes("'.qwen'")`.

- [ ] **Step 2: Перенести payload-сборку в отдельную функцию**

Создать `plugin/payload.mjs` с экспортом ниже. Перенести в него существующие `copyTree`, `walk`, `rewriteCoreImports` из `build.mjs` без изменения их алгоритма; добавить экспорт только через названную функцию:

```js
import { spawnSync } from 'node:child_process';
import { cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

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
```

В перенесённой `rewriteCoreImports(server)` вычислить `coreEntry = join(server, 'core', 'src', 'index.ts')`; больше она не читает глобальный `server` из `build.mjs`. В `build.mjs` удалить старые копии и заменить блок `main()` до `writeLauncher()` на:

```js
await buildServerPayload({ workspace, server });
```

- [ ] **Step 3: Сделать launcher host-driven, сохранив Qwen behavior**

Полный `plugin/launcher.mjs` до появления setup:

```js
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { hostPaths } from './descriptor.mjs';
import { host } from './host.mjs';

const version = '__PLUGIN_VERSION__';

function selectedPreset() {
  if (process.env.BUGHUNTER_PRESET !== undefined) return process.env.BUGHUNTER_PRESET;
  const file = hostPaths(host, process.cwd(), 'web').optIn;
  if (!existsSync(file)) return undefined;
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return typeof value.preset === 'string' ? value.preset : undefined;
  } catch {
    return undefined;
  }
}

async function dormant() {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const server = new McpServer({ name: 'bughunter', version });
  await server.connect(new StdioServerTransport());
}

async function main() {
  const preset = selectedPreset();
  if (preset === undefined) return dormant();
  if (!['web', 'node'].includes(preset)) {
    console.error(`BUGHUNTER_PRESET_INVALID: ${preset}`);
    process.exit(1);
  }
  const paths = hostPaths(host, process.cwd(), preset);
  const stateDir = process.env.BUGHUNTER_STATE_DIR ?? paths.stateDir;
  mkdirSync(stateDir, { recursive: true });
  const ignore = join(stateDir, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, 'runs/\nauth/\n', 'utf8');
  process.env.BUGHUNTER_STATE_DIR = stateDir;
  await import(join(import.meta.dirname, 'presets', preset, 'src', 'index.ts'));
}

await main();
```

Создать общий `plugin/write-launcher.mjs`, который используется и full, и MCP-only builds:

```js
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
```

В `build.mjs` удалить старую локальную `writeLauncher()` и вызывать `writeLauncher({ pluginRoot, server, host: qwenHost, version })`.

- [ ] **Step 4: Убрать Qwen hint из preset runtime**

В web/node `src/index.ts` удалить импорт `cliInstallHint` и заменить сообщение на:

```ts
const missingDependenciesMessage = 'Зависимости Bughunter недоступны. Переустановите плагин или выполните npm ci в workspace Bughunter.';
```

Удалить оба `cli-host.ts`. В `core-integration.bhtest.ts` заменить ожидание старого Qwen path на:

```ts
assert.ok(stderr.includes('Переустановите плагин или выполните npm ci в workspace Bughunter.'));
```

- [ ] **Step 5: Прогнать unit и Qwen install regression**

Run:

```sh
cd plugin && npm test && node build.mjs && node test-install.mjs
```

Expected: новые tests GREEN; plugin validation 14 components; web 19 tools/7 skills/6 agents, node 16 tools; dormant пока 0 tools/state=false.

Run дополнительно:

```sh
cd .qwen/bughunter/core && npm test && npm run typecheck
cd ../presets/web && npm test && npm run typecheck
cd ../node && npm test && npm run typecheck
```

Expected: все `fail 0`, typecheck clean; baseline counts фиксируются по фактическому выводу, без подгонки ожиданий.

- [ ] **Step 6: Commit при разрешении**

```sh
git add plugin .qwen/bughunter/core/test .qwen/bughunter/presets
git commit -m "refactor: make plugin launcher host-driven"
```

---

### Task 3: Dormant `bh_setup` and Config-Safe First Run

**Files:**
- Create: `plugin/preflight.mjs`
- Create: `plugin/setup.mjs`
- Create: `plugin/prompts/setup.md`
- Create: `plugin/test/setup.test.mjs`
- Create: `plugin/test/mcp-client.mjs`
- Modify: `plugin/launcher.mjs`
- Modify: `plugin/build.mjs`
- Modify: `plugin/test-install.mjs`
- Modify: `.qwen/bughunter/presets/web/src/config.ts:47,71`
- Modify: `.qwen/bughunter/presets/web/test/config-store.bhtest.ts`

**Interfaces:**
- Consumes: `qwenHost`, `hostPaths`, `host.reloadInstruction` из Tasks 1–2.
- Produces: `checkPrerequisites(preset, io?)`, `setupProject({ host, projectRoot, preset, serverRoot, preflight? })`, `startDormantServer({ host, version, serverRoot, projectRoot })`; MCP client helper `withMcpClient(serverRoot, cwd, callback)`.

- [ ] **Step 1: Написать failing unit tests на создание, сохранность и конфликт**

```js
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { qwenHost } from '../hosts/qwen.mjs';
import { setupProject } from '../setup.mjs';

const serverRoot = resolve('.qwen/bughunter');
const noMissing = async () => [];

test('setup creates only selected host state and preserves it on repeat', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'bh-setup-'));
  const first = await setupProject({ host: qwenHost, projectRoot, preset: 'web', serverRoot, preflight: noMissing });
  assert.equal(first.code, 'CONFIG_CREATED');
  const config = JSON.parse(await readFile(first.configPath, 'utf8'));
  assert.equal(config.baseUrl, 'https://dev-stand.example.local');
  assert.ok(!existsSync(join(projectRoot, '.kimi-code')));
  assert.ok(!existsSync(join(projectRoot, '.claude')));
  await writeFile(first.configPath, '{"sentinel":true}\n');
  const second = await setupProject({ host: qwenHost, projectRoot, preset: 'web', serverRoot, preflight: noMissing });
  assert.equal(second.code, 'SETUP_READY');
  assert.equal(await readFile(first.configPath, 'utf8'), '{"sentinel":true}\n');
});

test('setup rejects preset conflict without touching existing files', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'bh-setup-conflict-'));
  const first = await setupProject({ host: qwenHost, projectRoot, preset: 'web', serverRoot, preflight: noMissing });
  await assert.rejects(
    setupProject({ host: qwenHost, projectRoot, preset: 'node', serverRoot, preflight: noMissing }),
    /SETUP_PRESET_CONFLICT/,
  );
  assert.equal(JSON.parse(await readFile(first.configPath, 'utf8')).baseUrl, 'https://dev-stand.example.local');
});

test('setup stops before writes when prerequisites are missing', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'bh-setup-prereq-'));
  await assert.rejects(
    setupProject({
      host: qwenHost, projectRoot, preset: 'web', serverRoot,
      preflight: async () => ['Google Chrome'],
    }),
    /PREREQUISITES_MISSING: Google Chrome/,
  );
  assert.equal(existsSync(join(projectRoot, '.qwen')), false);
});
```

Run: `node --test plugin/test/setup.test.mjs`
Expected: RED `Cannot find module .../plugin/setup.mjs`.

- [ ] **Step 2: Экспортировать canonical web template**

В `web/src/config.ts` изменить private function и её вызов:

```ts
export function webConfigTemplate(): WebConfig {
  return {
    baseUrl: 'https://dev-stand.example.local',
    allowedOrigins: ['https://dev-stand.example.local'],
    routes: ['/', '/orders', '/orders/new', '/profile'],
    targetMap: { 'src/pages/orders/**': ['/orders', '/orders/new'] },
    baseBranch: 'main',
    limits: { stepsPerSession: 60, candidatesPerRun: 20, elementsPerSnapshot: defaultElementsPerSnapshot },
    safety: { forbiddenActionText: ['удалить', 'delete', 'оплатить'], readOnly: false },
    testDataPrefix: 'bh_',
    detectors: {
      ignoreConsole: [], ignoreRequests: [],
      anomalyTexts: ['undefined', 'NaN', '[object Object]', 'Invalid Date'],
      errorBoundarySelector: '[data-error-boundary]',
    },
    tests: { unit: { command: null }, generated: { dir: 'e2e/bughunter' } },
  };
}

export async function ensureConfig(stateDir?: string): Promise<{ config?: WebConfig; createdPath?: string }> {
  return ensureCoreConfig(stateDir ?? defaultStateDir, webConfigSchema, webConfigTemplate());
}
```

Добавить в web config test:

```ts
test('web template is exported for host setup without duplicating JSON', async () => {
  const { webConfigTemplate } = await import('../src/config.ts');
  assert.deepEqual(webConfigSchema.parse(webConfigTemplate()), webConfigTemplate());
});
```

Run: `cd .qwen/bughunter/presets/web && node --test --test-concurrency=1 test/config-store.bhtest.ts`
Expected: GREEN; это доказывает наличие canonical template до setup implementation.

- [ ] **Step 3: Реализовать preflight**

`plugin/preflight.mjs`:

```js
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

function available(command, run) {
  return run(command, ['--version']).status === 0;
}

export async function checkPrerequisites(preset, io = {}) {
  const run = io.run ?? ((command, args) => spawnSync(command, args, { encoding: 'utf8' }));
  const exists = io.exists ?? existsSync;
  const env = io.env ?? process.env;
  const platform = io.platform ?? process.platform;
  const nodeVersion = io.nodeVersion ?? process.versions.node;
  const [major = 0, minor = 0] = nodeVersion.split('.').map(Number);
  const missing = [];
  if (major < 22 || (major === 22 && minor < 18)) missing.push('Node.js >=22.18');
  if (!available('git', run)) missing.push('Git');
  if (preset === 'web') {
    let chrome = false;
    if (platform === 'darwin') chrome = exists('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    if (platform === 'linux') chrome = available('google-chrome', run) || available('google-chrome-stable', run);
    if (platform === 'win32') {
      chrome = [
        env.CHROME_PATH,
        env.PROGRAMFILES && join(env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        env['PROGRAMFILES(X86)'] && join(env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
        env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ].filter(Boolean).some((file) => exists(file));
    }
    if (!chrome) missing.push('Google Chrome');
  }
  return missing;
}
```

Добавить в `setup.test.mjs` отдельный test с injected `run`, `exists`, `nodeVersion`, покрывающий Node 22.17 и отсутствие Git/Chrome; ожидание — массив всех трёх имён в заданном порядке.

- [ ] **Step 4: Реализовать транзакционный setup**

`plugin/setup.mjs`:

```js
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { hostPaths } from './hosts/descriptor.mjs';
import { checkPrerequisites } from './preflight.mjs';

async function writeNew(file, text, created) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' });
    await link(temporary, file);
    created.push(file);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function templateFor(serverRoot, preset) {
  const file = join(serverRoot, 'presets', preset, 'src', 'config.ts');
  const module = await import(pathToFileURL(file).href);
  return preset === 'web' ? module.webConfigTemplate() : module.nodeConfigTemplate();
}

export async function setupProject({ host, projectRoot, preset, serverRoot, preflight = checkPrerequisites }) {
  if (!['web', 'node'].includes(preset)) throw new Error(`BUGHUNTER_PRESET_INVALID: ${preset}`);
  const missing = await preflight(preset);
  if (missing.length > 0) throw new Error(`PREREQUISITES_MISSING: ${missing.join(', ')}`);
  const paths = hostPaths(host, projectRoot, preset);
  if (existsSync(paths.optIn)) {
    let existing;
    try { existing = JSON.parse(await readFile(paths.optIn, 'utf8')); }
    catch { throw new Error(`SETUP_OPT_IN_INVALID: ${paths.optIn}`); }
    if (existing.preset !== preset) throw new Error(`SETUP_PRESET_CONFLICT: ${paths.optIn}`);
  }
  const created = [];
  try {
    if (!existsSync(paths.optIn)) {
      await writeNew(paths.optIn, `${JSON.stringify({ preset }, null, 2)}\n`, created);
    }
    if (!existsSync(paths.configPath)) {
      const template = await templateFor(serverRoot, preset);
      await writeNew(paths.configPath, `${JSON.stringify(template, null, 2)}\n`, created);
    }
    const ignore = join(paths.stateDir, '.gitignore');
    if (!existsSync(ignore)) await writeNew(ignore, 'runs/\nauth/\n', created);
  } catch (error) {
    await Promise.all(created.reverse().map((file) => rm(file, { force: true })));
    throw error;
  }
  return {
    code: created.includes(paths.configPath) ? 'CONFIG_CREATED' : 'SETUP_READY',
    optInPath: paths.optIn,
    configPath: paths.configPath,
    reload: host.refreshInstruction,
  };
}

export async function startDormantServer({ host, version, serverRoot, projectRoot }) {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { z } = await import('zod');
  const server = new McpServer({ name: 'bughunter', version });
  server.registerTool('bh_setup', {
    description: 'Создать opt-in и config после явного выбора web/node; не запускает исследование',
    inputSchema: { preset: z.enum(['web', 'node']) },
  }, async ({ preset }) => {
    try {
      const value = await setupProject({ host, projectRoot, preset, serverRoot });
      return { content: [{ type: 'text', text: JSON.stringify(value) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text', text: message }], isError: true };
    }
  });
  await server.connect(new StdioServerTransport());
}
```

В `launcher.mjs` заменить старую `dormant()` на делегирование:

```js
return startDormantServer({
  host,
  version,
  serverRoot: import.meta.dirname,
  projectRoot: process.cwd(),
});
```

Добавить импорт `startDormantServer` из `./setup.mjs`; `McpServer` больше не импортируется в launcher. В `build.mjs` копировать `plugin/setup.mjs`, `plugin/preflight.mjs` в `server/`; setup также копировать `hosts/descriptor.mjs` в `server/hosts/descriptor.mjs`, потому что импорт `./hosts/descriptor.mjs` должен разрешаться из bundled setup. Сохранить `server/descriptor.mjs` для launcher.

- [ ] **Step 5: Добавить setup instructions в общий plugin prompt**

`plugin/prompts/setup.md`:

```md
Если `.qwen/bughunter.json` отсутствует, не проси ручной installer и не вызывай рабочие tools. Спроси пользователя `web` или `node` через нативный interaction mechanism. После явного выбора вызови ровно один `mcp__bughunter__bh_setup` с `preset`. При `CONFIG_CREATED` покажи `configPath`, попроси заполнить config и выполни `/plugins reload` или открой новую сессию. При `PREREQUISITES_MISSING`, `SETUP_OPT_IN_INVALID` или `SETUP_PRESET_CONFLICT` покажи ошибку и остановись. Не выбирай пресет сам и не перезаписывай существующие файлы.
```

В `renderEntry()` добавить содержимое этого файла в `preamble` после существующего абзаца про state. Пока Qwen path в блоке корректен; Tasks 5/7 вынесут paths/tool/reload в descriptor placeholders.

- [ ] **Step 6: Проверить setup через настоящий MCP и Qwen reload**

`plugin/test/mcp-client.mjs`:

```js
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

async function load(serverRoot, relative) {
  return import(pathToFileURL(join(serverRoot, 'node_modules', '@modelcontextprotocol', 'sdk', relative)).href);
}

export async function withMcpClient(serverRoot, cwd, callback) {
  const { Client } = await load(serverRoot, 'client/index.js');
  const { StdioClientTransport } = await load(serverRoot, 'client/stdio.js');
  const client = new Client({ name: 'bh-install-test', version: '0.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(serverRoot, 'mcp.mjs')],
    cwd,
    env: { ...process.env },
  });
  try {
    await client.connect(transport);
    return await callback(client);
  } finally {
    await client.close();
  }
}
```

В `test-install.mjs` после существующего dormant init изменить ожидание tools на 1, затем:

```js
const setup = await withMcpClient(join(dist, 'server'), project, async (client) => {
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), ['bh_setup']);
  return client.callTool({ name: 'bh_setup', arguments: { preset: 'web' } });
});
assert.equal(setup.isError, undefined);
assert.equal(JSON.parse(setup.content[0].text).code, 'CONFIG_CREATED');
const afterSetup = summarize(await initOf());
assert.equal(afterSetup.bhTools.length, 19);
```

Импортировать helper. Проверить, что до setup `.qwen/bughunter` отсутствует, а после существуют opt-in/config и `runs/`/`auth/` не созданы. Изменить final JSON dormant на `{ tools: 1, state: false }`, добавить `afterSetup.tools = 19`.

Run:

```sh
cd plugin && npm test && node build.mjs && node test-install.mjs
```

Expected: setup unit GREEN; real MCP `bh_setup` GREEN; Qwen после нового `initOf` видит 19 tools; dormant state=false.

- [ ] **Step 7: Commit при разрешении**

```sh
git add plugin .qwen/bughunter/presets/web/src/config.ts .qwen/bughunter/presets/web/test/config-store.bhtest.ts
git commit -m "feat: add dormant project setup"
```

---

### Task 4: Qwen Native Marketplace Install and Update

**Files:**
- Create: `plugin/marketplace.mjs`
- Create: `plugin/test/qwen-harness.mjs`
- Create: `plugin/test/qwen-marketplace-install.mjs`
- Modify: `plugin/build.mjs`
- Modify: `plugin/test-install.mjs`
- Modify: `plugin/package.json`
- Modify: `plugin/README.md`

**Interfaces:**
- Consumes: `qwenHost`, setup client и `afterSetup` flow из Task 3.
- Produces: `buildQwenMarketplace({ pluginDir, marketplaceRoot, version })`, `qwenInit({ configDir, project })`; Qwen marketplace root содержит `.claude-plugin/marketplace.json` и полную копию `plugins/bughunter`.

- [ ] **Step 1: Написать failing marketplace generator test**

Добавить `plugin/test/marketplace.test.mjs`:

```js
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildQwenMarketplace } from '../marketplace.mjs';

test('qwen marketplace contains a self-contained relative plugin source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bh-qwen-market-'));
  const pluginDir = join(root, 'plugin');
  const marketplaceRoot = join(root, 'marketplace');
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(join(pluginDir, '.claude-plugin'), { recursive: true });
  await writeFile(join(pluginDir, '.claude-plugin', 'plugin.json'), '{"name":"bughunter","version":"0.1.0"}\n');
  await buildQwenMarketplace({ pluginDir, marketplaceRoot, version: '0.1.0' });
  const catalog = JSON.parse(await readFile(join(marketplaceRoot, '.claude-plugin', 'marketplace.json'), 'utf8'));
  assert.equal(catalog.name, 'bughunter-market');
  assert.deepEqual(catalog.plugins[0].source, './plugins/bughunter');
  assert.equal(catalog.plugins[0].version, '0.1.0');
  assert.equal(existsSync(join(marketplaceRoot, 'plugins', 'bughunter', '.claude-plugin', 'plugin.json')), true);
});
```

Run: `node --test plugin/test/marketplace.test.mjs`
Expected: RED `Cannot find module .../plugin/marketplace.mjs`.

- [ ] **Step 2: Реализовать Qwen marketplace и подключить build**

```js
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
```

В `build.mjs` после `validate()` вызывать:

```js
await buildQwenMarketplace({
  pluginDir: out,
  marketplaceRoot: join(pluginRoot, 'dist', 'qwen-marketplace'),
  version,
});
```

Перед основной сборкой удалять и `dist/qwen-marketplace`, чтобы старые файлы не попали в новый снимок.

- [ ] **Step 3: Вынести Qwen init harness**

Создать `qwen-harness.mjs` с полным harness:

```js
import { spawn } from 'node:child_process';

export function qwenInit({ qwen, configDir, project }) {
  return new Promise((resolveInit, reject) => {
    const child = spawn(qwen, [
      '--config-dir', configDir, '-p', 'hi', '--output-format', 'stream-json',
      '--no-session-persistence', '--allowed-mcp-server-names', 'bughunter',
    ], { cwd: project, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      if (error) reject(error); else resolveInit(value);
    };
    const timer = setTimeout(() => finish(new Error(`qwen init timed out\n${stderr}`)), 30_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const line = stdout.split('\n').find((value) => value.includes('"subtype":"init"'));
      if (line !== undefined) finish(undefined, JSON.parse(line));
    });
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => {
      if (!settled) finish(new Error(`qwen exited before init (${code})\n${stderr}\n${stdout}`));
    });
  });
}

export function summarize(event) {
  return {
    mcp: event.mcp_servers.map((server) => `${server.name}:${server.status}`),
    bhTools: event.tools.filter((tool) => tool.startsWith('mcp__bughunter__')),
    skills: event.skills.filter((skill) => skill.startsWith('bughunter:')),
    agents: event.agents.filter((agent) => agent.startsWith('bughunter:')),
  };
}
```

В `test-install.mjs` удалить старые `initOf`/`summarize` и вызывать `qwenInit({ qwen, configDir, project })`.

- [ ] **Step 4: Написать реальный marketplace install/update test**

`qwen-marketplace-install.mjs` создаёт temp config/project и выполняет:

```js
run(qwen, ['--config-dir', configDir, 'plugins', 'marketplace', 'add', marketplaceRoot]);
run(qwen, ['--config-dir', configDir, 'plugins', 'install', 'bughunter@bughunter-market', '--json']);
const installed = JSON.parse(run(qwen, ['--config-dir', configDir, 'plugins', 'list', '--json']).stdout);
assert.equal(installed.find((plugin) => plugin.id === 'bughunter@bughunter-market').enabled, true);

const dormant = summarize(await qwenInit({ qwen, configDir, project }));
assert.deepEqual(dormant.mcp, ['bughunter:connected']);
assert.deepEqual(dormant.bhTools, ['mcp__bughunter__bh_setup']);

const setup = await withMcpClient(join(marketplaceRoot, 'plugins', 'bughunter', 'server'), project, (client) =>
  client.callTool({ name: 'bh_setup', arguments: { preset: 'web' } }));
assert.equal(setup.isError, undefined);
const configPath = JSON.parse(setup.content[0].text).configPath;
await writeFile(configPath, '{"sentinel":"preserve-me"}\n');
await writeFile(join(project, '.qwen', 'bughunter', 'state', 'web', 'runs', 'sentinel.json'), '{}\n');
```

Создать `runs/` перед записью sentinel. Не создавать реальный auth secret; для update test достаточно `auth/README` с dummy `not-a-credential`. Для update увеличить до `0.1.1-test.1` оба значения в локальном marketplace: `plugins/bughunter/.claude-plugin/plugin.json.version` и `.claude-plugin/marketplace.json.plugins[0].version`, затем:

```js
run(qwen, ['--config-dir', configDir, 'plugins', 'marketplace', 'update', 'bughunter-market']);
run(qwen, ['--config-dir', configDir, 'plugins', 'update', 'bughunter@bughunter-market']);
assert.equal(await readFile(configPath, 'utf8'), '{"sentinel":"preserve-me"}\n');
assert.equal(await readFile(join(project, '.qwen', 'bughunter', 'state', 'web', 'runs', 'sentinel.json'), 'utf8'), '{}\n');
```

Добавить script `"test:qwen-marketplace": "node test/qwen-marketplace-install.mjs"`.

- [ ] **Step 5: Запустить Qwen gates и обновить operator docs**

Run:

```sh
cd plugin && npm test && npm run test:install && npm run test:qwen-marketplace
```

Expected: local install и marketplace install оба GREEN; dormant tools=1; web=19; update сохраняет sentinel. Если CLI marketplace command отличается, остановиться и зафиксировать фактический help/error; не заменять проверку простым копированием plugin.

В `plugin/README.md` обновить dormant description: подключён MCP, доступен только `bh_setup`, state до setup не создаётся. Добавить exact local test command и предупреждение, что custom marketplace не означает official listing.

- [ ] **Step 6: Commit при разрешении**

```sh
git add plugin
git commit -m "test: verify Qwen marketplace install and update"
```

---

### Task 5: Kimi Native Descriptor, Manifest and Prompt Rendering

**Files:**
- Create: `plugin/hosts/kimi.mjs`
- Create: `plugin/prompts.mjs`
- Create: `plugin/hosts/kimi.README.md`
- Create: `plugin/test/kimi-artifact.test.mjs`
- Modify: `plugin/hosts/qwen.mjs`
- Modify: `plugin/hosts/descriptor.mjs`
- Modify: `plugin/prompts/setup.md`
- Modify: `plugin/build.mjs`
- Modify: `plugin/package.json`

**Interfaces:**
- Consumes: `defineHostDescriptor`, общий payload и Qwen render behavior.
- Produces: `kimiHost`, `renderPromptLayer({ host, source, workspace, out })`, `buildHostPlugin(host)`. Kimi artifact — `plugin/dist/kimi/bughunter`, manifest `kimi.plugin.json`, entry `/skill:bughunter:bughunter`, marketplace `plugin/dist/kimi-marketplace.json`.

- [ ] **Step 1: Написать failing artifact test**

```js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const out = join('plugin', 'dist', 'kimi', 'bughunter');

test('kimi artifact has native manifest and no Qwen paths', async () => {
  const manifest = JSON.parse(await readFile(join(out, 'kimi.plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'bughunter');
  assert.equal(manifest.mcpServers.bughunter.args[0], '${KIMI_PLUGIN_ROOT}/server/mcp.mjs');
  assert.equal(manifest.skills.length, 7);
  assert.equal(manifest.agents.length, 6);
  assert.equal(existsSync(join(out, '.claude-plugin', 'plugin.json')), false);
  const entry = await readFile(join(out, 'skills', 'bughunter', 'SKILL.md'), 'utf8');
  assert.ok(entry.includes('.kimi-code/bughunter.json'));
  assert.ok(entry.includes('.kimi-code/bughunter/state/<preset>/'));
  assert.ok(entry.includes('/reload'));
  assert.ok(!entry.includes('.qwen/'));
});

test('kimi marketplace is version 2 and targets CLI and desktop', async () => {
  const catalog = JSON.parse(await readFile('plugin/dist/kimi-marketplace.json', 'utf8'));
  assert.equal(catalog.version, '2');
  assert.deepEqual(catalog.plugins[0].clients, ['cli', 'desktop']);
  assert.equal(catalog.plugins[0].id, 'bughunter');
  assert.equal(catalog.plugins[0].source, join(process.cwd(), 'plugin', 'dist', 'kimi', 'bughunter'));
});
```

Run: `node --test plugin/test/kimi-artifact.test.mjs`
Expected: RED, файл `kimi.plugin.json` отсутствует.

- [ ] **Step 2: Добавить Kimi descriptor и нативный manifest**

```js
import { defineHostDescriptor } from './descriptor.mjs';

export const kimiHost = defineHostDescriptor({
  id: 'kimi',
  pluginId: 'bughunter',
  outDir: 'dist/kimi/bughunter',
  pluginRoot: '${KIMI_PLUGIN_ROOT}',
  optInPath: '.kimi-code/bughunter.json',
  stateRoot: '.kimi-code/bughunter/state',
  // Верифицировано на 2.5.3: Kimi именует плагинные MCP tools по runtime server name.
  mcpToolPrefix: 'mcp__plugin-bughunter_bughunter__',
  skillNamespace: 'bughunter:',
  agentNamespace: 'bughunter:',
  reloadInstruction: '/reload',
  refreshInstruction: '`/reload` (без него новая сессия продолжит видеть прежний набор инструментов)',
  entryInvocation: '/skill:bughunter:bughunter',
  clients: ['cli', 'desktop'],
});

export const host = kimiHost;

export function kimiManifest(version) {
  return {
    name: 'bughunter',
    version,
    description: 'Доказательный поиск багов с воспроизведением и красными регрессионными тестами.',
    skills: [
      './skills/bughunter', './skills/bughunter-oracles', './skills/bughunter-red-test',
      './skills/bughunter-preset-card-web', './skills/bughunter-preset-card-node',
      './skills/bughunter-preset-guide', './skills/bughunter-core-contract',
    ],
    agents: [
      './agents/bh-explorer.md', './agents/bh-reviewer.md', './agents/bh-test-writer.md',
      './agents/bh-explorer-node.md', './agents/bh-reviewer-node.md', './agents/bh-test-writer-node.md',
    ],
    mcpServers: {
      bughunter: { command: 'node', args: ['${KIMI_PLUGIN_ROOT}/server/mcp.mjs'] },
    },
    interface: {
      displayName: 'Bughunter',
      shortDescription: 'Evidence-based bug hunting with red regression tests.',
    },
  };
}
```

Расширить `defineHostDescriptor` необязательными полями `entryInvocation` и `clients`; обязательными их делать только для новых Kimi/Claude descriptors. Qwen получает `entryInvocation: '/bughunter:bughunter'`, `clients: ['cli']`.

- [ ] **Step 3: Параметризовать prompt renderer**

Перенести существующие `splitFrontmatter`, `insertAfterFrontmatter`, `namedAgents`, `namespacedSkillRefs`, `renderEntry`, `renderCard`, `renderAgent`, `renderAuthoringSkill` и `writePromptLayer` в `plugin/prompts.mjs`. Итоговый orchestration code:

```js
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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
  await writeFile(join(out, 'skills', 'bughunter', 'SKILL.md'), hostText(await renderEntry(source), host));
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
```

Внутри helpers выполнять замены:

```js
function hostText(text, host) {
  return text
    .replaceAll('mcp__bughunter__', host.mcpToolPrefix)
    .replaceAll('.qwen/bughunter.json', host.optInPath)
    .replaceAll('.qwen/bughunter/state/<preset>/', `${host.stateRoot}/<preset>/`)
    .replaceAll('.qwen/bughunter/presets/web/state/', `${host.stateRoot}/web/`)
    .replaceAll('.qwen/bughunter/presets/node/state/', `${host.stateRoot}/node/`)
    .replaceAll('/plugins reload', host.reloadInstruction);
}
```

Применять `hostText` к entry, cards и agents после существующего Qwen-specific rendering. Для Qwen replacements должны быть no-op по значениям. Проверить `!/<[a-z-]+>/` только для неизвестных tokens; известные `<card>`, `<explorer>`, `<reviewer>`, `<writer>`, `<preset>` остаются по контракту и проверяются отдельно, а не общим reject.

`plugin/prompts/setup.md` сделать generic:

```md
Если `<optIn>` отсутствует, не проси ручной installer и не вызывай рабочие tools. Спроси пользователя `web` или `node` через нативный interaction mechanism. После явного выбора вызови ровно один `<setupTool>` с `preset`. При `CONFIG_CREATED` покажи `configPath`, попроси заполнить config и выполни `<refresh>`. При `PREREQUISITES_MISSING`, `SETUP_OPT_IN_INVALID` или `SETUP_PRESET_CONFLICT` покажи ошибку и остановись. Не выбирай пресет сам и не перезаписывай существующие файлы.
```

Renderer заменяет `<optIn>`, `<setupTool>`, `<refresh>` (host-specific шаг обновления toolset) до записи artifact; Qwen test должен видеть прежние значения.

- [ ] **Step 4: Сделать сборку multi-host с одним payload**

`build.mjs` принимает `--host qwen|kimi|all` (default `qwen`). Использовать общий staged payload:

```js
const requested = args.includes('--host') ? args[args.indexOf('--host') + 1] : 'qwen';
if (!['qwen', 'kimi', 'all'].includes(requested)) throw new Error(`HOST_INVALID: ${requested}`);
const hosts = requested === 'all' ? [qwenHost, kimiHost] : [requested === 'qwen' ? qwenHost : kimiHost];
const shared = join(pluginRoot, 'dist', '.shared-server');
try {
  await buildServerPayload({ workspace, server: shared });
  for (const host of hosts) {
    const out = join(pluginRoot, host.outDir);
    const server = join(out, 'server');
    await rm(out, { recursive: true, force: true });
    await cp(shared, server, { recursive: true });
    await writeLauncher({ pluginRoot, server, host, version });
    await renderPromptLayer({ host, source, workspace, out });
    await writeManifest(host, out, version);
    await copyAuthoring(out);
  }
} finally {
  await rm(shared, { recursive: true, force: true });
}
```

`copyAuthoring(out)` теперь использует параметр `out` вместо глобального. `writeManifest` для Qwen использует текущий `.claude-plugin/plugin.json`, для Kimi — `kimiManifest(version)` и `kimi.plugin.json`; Qwen validator вызывается только для Qwen artifact, Kimi validation принадлежит Task 6. Kimi marketplace записывается с абсолютным local source только для local gate:

```js
{
  version: '2',
  plugins: [{
    id: 'bughunter', displayName: 'Bughunter', description: kimiManifest(version).description,
    version, source: join(pluginRoot, kimiHost.outDir), clients: ['cli', 'desktop'],
    platforms: ['darwin', 'win32', 'linux'],
  }],
}
```

Kimi artifact копирует `hosts/kimi.README.md` в `README.md`, Qwen продолжает копировать `plugin/README.md`. Не оставлять staged `.shared-server` после успеха или ошибки (`try/finally`).

- [ ] **Step 5: Написать Kimi README и проверить artifact**

`kimi.README.md` должен содержать точный путь:

```md
1. Settings → Plugins → добавить custom marketplace JSON.
2. Установить `bughunter`, затем выполнить `/reload` — без него новая сессия не подхватит плагин.
3. В проекте вызвать `/skill:bughunter:bughunter`, выбрать web/node и заполнить `.kimi-code/bughunter/state/<preset>/config.json`.
4. После заполнения повторить `/skill:bughunter:bughunter target /orders`, заменив route на значение из `routes`.
5. Проверить `.kimi-code/bughunter/state/<preset>/runs/<runId>/report.md`.
```

Добавить prerequisites Node >=22.18/Git/Chrome, auth script из `<installPath>/server/presets/web/src/auth.ts` с `BUGHUNTER_STATE_DIR="$PWD/.kimi-code/bughunter/state/web"`. Не использовать Qwen `/bughunter:bughunter` как Kimi command.

Run:

```sh
cd plugin && node build.mjs --host all && npm test && npm run test:install
```

Expected: Qwen regression GREEN; Kimi artifact tests GREEN; Qwen output сохраняет 19/16, 7 skills/6 agents.

- [ ] **Step 6: Commit при разрешении**

```sh
git add plugin
git commit -m "feat: build native Kimi plugin"
```

---

### Task 6: Kimi Marketplace/API Install and State Preservation Gate

**Files:**
- Create: `plugin/test/kimi-server.mjs`
- Create: `plugin/test/kimi-marketplace-install.mjs`
- Modify: `plugin/package.json`
- Modify: `plugin/hosts/kimi.README.md`

**Interfaces:**
- Consumes: Kimi `2.5.3`, `dist/kimi-marketplace.json`, `withMcpClient` и Kimi managed plugin `root` из REST response.
- Produces: `withKimiServer({ home, marketplace, project }, callback)`, `kimiRequest(baseUrl, token, method, path, body?)`; integration result `plugin/evidence/kimi/install.json` без token.

- [ ] **Step 1: Написать failing server helper и lifecycle test**

Использовать `node:net` для free port, `KIMI_CODE_HOME` для isolation и никогда не читать реальный `~/.kimi-code/server.token`:

```js
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

async function port() {
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const value = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return value;
}

export async function withKimiServer({ home, marketplace, project }, callback) {
  const bindPort = await port();
  const child = spawn('kimi', ['web', '--no-open', '--host', '127.0.0.1', '--port', String(bindPort)], {
    cwd: project,
    env: { ...process.env, KIMI_CODE_HOME: home, KIMI_CODE_PLUGIN_MARKETPLACE_URL: marketplace },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const baseUrl = `http://127.0.0.1:${bindPort}`;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        if ((await fetch(`${baseUrl}/api/v1/healthz`)).ok) { ready = true; break; }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error('KIMI_SERVER_NOT_READY');
    const token = await readFile(join(home, 'server.token'), 'utf8');
    return await callback({ baseUrl, token: token.trim() });
  } finally {
    child.kill('SIGTERM');
  }
}

export async function kimiRequest(baseUrl, token, method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const envelope = await response.json();
  if (!response.ok || envelope.code !== 0) throw new Error(`KIMI_API_FAILED: ${path}: ${JSON.stringify(envelope)}`);
  return envelope.data;
}
```

Lifecycle script:

```js
const data = await kimiRequest(baseUrl, token, 'GET', '/api/v1/plugins/marketplace');
const entry = data.entries.find((value) => value.id === 'bughunter');
assert.equal(entry.version, version);
const installed = await kimiRequest(baseUrl, token, 'POST', '/api/v1/plugins', {
  marketplaceId: 'bughunter', expectedVersion: version,
});
assert.equal(installed.id, 'bughunter');
assert.equal(installed.enabled, true);
const details = await kimiRequest(baseUrl, token, 'GET', '/api/v1/plugins/bughunter');
assert.equal(details.skillCount, 7);
assert.equal(details.mcpServerCount, 1);
assert.deepEqual(details.diagnostics, []);
```

До реализации helper запуск должен дать RED `KIMI_SERVER_NOT_READY` либо import failure; не считать timeout PASS.

- [ ] **Step 2: Проверить main session MCP/skills без model turn**

Через API создать session без model turn:

```js
const session = await kimiRequest(baseUrl, token, 'POST', '/api/v1/sessions', {
  metadata: { cwd: project },
});
const skills = await kimiRequest(baseUrl, token, 'GET', `/api/v1/sessions/${session.id}/skills`);
assert.equal(skills.skills.filter((skill) => skill.name.startsWith('bughunter:')).length, 7);
const tools = await kimiRequest(baseUrl, token, 'GET', `/api/v1/tools?session_id=${encodeURIComponent(session.id)}`);
assert.equal(tools.tools.filter((tool) => tool.name === 'mcp__plugin-bughunter_bughunter__bh_setup').length, 1); // верифицированный runtime prefix 2.5.3
```

Если API требует настроенную модель даже без turn, записать точный envelope и пометить install gate `blocked`; не подменять его вызовом платной модели. Agent discovery проверяется шестью файлами в `details.root/agents` здесь и фактическим native delegation в Task 13.

- [ ] **Step 3: Вызвать setup через managed plugin MCP и проверить web/node**

Вызвать setup:

```js
const setup = await withMcpClient(join(details.root, 'server'), project, (client) =>
  client.callTool({ name: 'bh_setup', arguments: { preset: 'web' } }));
assert.equal(setup.isError, undefined);
const configPath = JSON.parse(setup.content[0].text).configPath;
```

После web setup проверить 19 tools с верифицированным prefix `mcp__plugin-bughunter_bughunter__` через `GET /api/v1/tools`; новая сессия сама по себе набор не обновляет — нужен `POST /api/v1/mcp/servers/plugin-bughunter%3Abughunter:restart` (тело `{}`) или `/reload`. Записать sentinel config, `runs/sentinel.json` и dummy `auth/README`. Для update увеличить `version` в managed source `kimi.plugin.json` и локальном catalog entry до `0.1.1-test.1`, обновить managed source в local marketplace, затем вызвать:

```js
const updated = await kimiRequest(baseUrl, token, 'POST', '/api/v1/plugins', {
  marketplaceId: 'bughunter', expectedVersion: '0.1.1-test.1',
});
assert.equal(updated.version, '0.1.1-test.1');
assert.equal(await readFile(configPath, 'utf8'), '{"sentinel":"preserve-me"}\n');
```

Если POST install не выполняет update, использовать native Plugins UI update в Desktop/manual gate и оставить CLI update blocked; не выдавать reinstall как update.

Затем в отдельном temp project выбрать node, вызвать setup и проверить 16 tools. Не запускать исследование. Для `clients` filter дополнительно прочитать marketplace catalog через CLI surface и Desktop surface, когда Desktop gate выполняется; не имитировать Desktop просто изменив строку запроса.

- [ ] **Step 4: Запустить и сохранить sanitized evidence**

Добавить script:

```json
"test:kimi-marketplace": "node test/kimi-marketplace-install.mjs"
```

Run: `cd plugin && npm run test:kimi-marketplace`
Expected: exit 0, installed enabled, 7 skills/1 MCP server/0 diagnostics, dormant setup=1, web=19, node=16, sentinel unchanged.

В evidence записать только:

```json
{
  "host": "kimi",
  "clientVersion": "2.5.3",
  "surface": "cli",
  "gate": "install",
  "status": "passed",
  "webTools": 19,
  "nodeTools": 16,
  "skills": 7,
  "statePreserved": true
}
```

Не записывать token, Authorization header, config providers или полный server log.

- [ ] **Step 5: Commit при разрешении**

```sh
git add plugin
git commit -m "test: verify Kimi marketplace lifecycle"
```

---

### Task 7: Claude Native Descriptor and Tool Names

**Files:**
- Create: `plugin/hosts/claude.mjs`
- Create: `plugin/hosts/claude.README.md`
- Create: `plugin/test/claude-artifact.test.mjs`
- Modify: `plugin/build.mjs`
- Modify: `plugin/marketplace.mjs`
- Modify: `plugin/prompts.mjs`

**Interfaces:**
- Consumes: `renderPromptLayer`, staged payload и marketplace helper из Tasks 4–5.
- Produces: `claudeHost`, `claudeManifest(version)`, `buildClaudeMarketplace(...)`; artifact `dist/claude/bughunter`, marketplace `dist/claude-marketplace`, MCP prefix `mcp__plugin_bughunter_bughunter__`.

- [ ] **Step 1: Написать failing Claude artifact test**

```js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const out = 'plugin/dist/claude/bughunter';

test('claude artifact uses native root, state and MCP tool names', async () => {
  const manifest = JSON.parse(await readFile(`${out}/.claude-plugin/plugin.json`, 'utf8'));
  assert.equal(manifest.name, 'bughunter');
  assert.equal(manifest.mcpServers.bughunter.args[0], '${CLAUDE_PLUGIN_ROOT}/server/mcp.mjs');
  const entry = await readFile(`${out}/skills/bughunter/SKILL.md`, 'utf8');
  assert.ok(entry.includes('.claude/bughunter.json'));
  assert.ok(entry.includes('/reload-plugins'));
  assert.ok(!entry.includes('.qwen/'));
  assert.ok(!entry.includes('.kimi-code/'));
  const explorer = await readFile(`${out}/agents/bh-explorer.md`, 'utf8');
  assert.ok(explorer.includes('mcp__plugin_bughunter_bughunter__bh_open'));
  assert.ok(explorer.includes('.claude/bughunter/state/web/runs/'));
  assert.ok(!explorer.includes('mcp__bughunter__'));
});
```

Run: `node --test plugin/test/claude-artifact.test.mjs`
Expected: RED, Claude manifest отсутствует.

- [ ] **Step 2: Добавить Claude descriptor**

```js
import { defineHostDescriptor } from './descriptor.mjs';

export const claudeHost = defineHostDescriptor({
  id: 'claude',
  pluginId: 'bughunter',
  outDir: 'dist/claude/bughunter',
  pluginRoot: '${CLAUDE_PLUGIN_ROOT}',
  optInPath: '.claude/bughunter.json',
  stateRoot: '.claude/bughunter/state',
  mcpToolPrefix: 'mcp__plugin_bughunter_bughunter__',
  skillNamespace: 'bughunter:',
  agentNamespace: 'bughunter:',
  reloadInstruction: '/reload-plugins',
  refreshInstruction: '`/reload-plugins`',
  entryInvocation: '/bughunter:bughunter',
  clients: ['cli', 'desktop'],
});

export const host = claudeHost;

export function claudeManifest(version) {
  return {
    name: 'bughunter',
    displayName: 'Bughunter',
    version,
    description: 'Evidence-based bug hunting with reproduction and red regression tests.',
    author: { name: 'Bughunter' },
    skills: [
      './skills/bughunter', './skills/bughunter-oracles', './skills/bughunter-red-test',
      './skills/bughunter-preset-card-web', './skills/bughunter-preset-card-node',
      './skills/bughunter-preset-guide', './skills/bughunter-core-contract',
    ],
    agents: [
      './agents/bh-explorer.md', './agents/bh-reviewer.md', './agents/bh-test-writer.md',
      './agents/bh-explorer-node.md', './agents/bh-reviewer-node.md', './agents/bh-test-writer-node.md',
    ],
    mcpServers: {
      bughunter: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server/mcp.mjs'] },
    },
  };
}
```

Не добавлять выдуманные homepage/repository/license identifiers. Их release source получает только из фактической publisher configuration в Task 10.

- [ ] **Step 3: Подключить Claude к generic render/build**

В `build.mjs` расширить `--host` значением `claude`; `all` означает `[qwenHost, kimiHost, claudeHost]`. `writeManifest` вызывает `claudeManifest` и пишет `.claude-plugin/plugin.json`. `renderPromptLayer` уже заменяет MCP prefix через `hostText`; добавить artifact assertion, что replacements происходят и в YAML frontmatter, не только в body.

Добавить `buildClaudeMarketplace` как wrapper над общим helper из Task 4:

```js
export async function buildClaudeMarketplace({ pluginDir, marketplaceRoot, version }) {
  return buildNativeMarketplace({
    pluginDir,
    marketplaceRoot,
    version,
    marketplaceName: 'bughunter-market',
    description: 'Bughunter releases for Claude Code CLI and Desktop Code sessions',
  });
}
```

В Task 4 переименовать внутреннюю реализацию в `buildNativeMarketplace`, оставив `buildQwenMarketplace` wrapper с прежней сигнатурой. Оба marketplace содержат полную копию plugin и `./plugins/bughunter`.

- [ ] **Step 4: Добавить Claude install/auth instructions**

`claude.README.md`:

```md
1. `/plugin marketplace add <configured-source>` один раз, затем `/plugin install bughunter@bughunter-market`.
2. Выбрать user scope, открыть local CLI/Desktop Code session и при необходимости выполнить `/reload-plugins`.
3. Вызвать `/bughunter:bughunter`, явно выбрать web/node и заполнить `.claude/bughunter/state/<preset>/config.json`.
4. Начать с `/bughunter:bughunter target /orders`, подставив route из `routes`.
5. Проверить `.claude/bughunter/state/<preset>/runs/<runId>/report.md`.
```

Auth:

```sh
BUGHUNTER_STATE_DIR="$PWD/.claude/bughunter/state/web" \
  node "<installPath>/server/presets/web/src/auth.ts"
```

Указать Node >=22.18, Git, Chrome для web; Claude Desktop chat/claude.ai не заявлять как local MCP targets. Desktop full означает только Desktop Code local session и требует Task 14 gate.

- [ ] **Step 5: Проверить все artifact tests и Qwen/Kimi regression**

Run:

```sh
cd plugin && node build.mjs --host all && npm test && npm run test:install && npm run test:kimi-marketplace
```

Expected: artifact GREEN; Qwen/Kimi поведение не изменилось. Claude install пока не запускать и не заявлять.

- [ ] **Step 6: Commit при разрешении**

```sh
git add plugin
git commit -m "feat: build native Claude plugin"
```

---

### Task 8: Claude Validation, Marketplace Install and Update Gate

**Files:**
- Create: `plugin/test/claude-marketplace-install.mjs`
- Modify: `plugin/package.json`
- Modify: `plugin/hosts/claude.README.md`

**Interfaces:**
- Consumes: `dist/claude-marketplace`, `withMcpClient`, `qwen marketplace test` как behavioral reference, но отдельные Claude commands.
- Produces: `plugin/evidence/claude/install.json` с фактической `claude --version`; отсутствие CLI — blocking failure, не skipped PASS.

- [ ] **Step 1: Добавить prerequisite guard и failing native validation**

```js
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const version = spawnSync('claude', ['--version'], { encoding: 'utf8' });
if (version.error?.code === 'ENOENT') {
  throw new Error('CLAUDE_CLI_MISSING: install Claude Code, authenticate it in the isolated gate config, then rerun');
}
assert.equal(version.status, 0, version.stderr);
const clientVersion = version.stdout.trim();
const valid = spawnSync('claude', ['plugin', 'validate', '--strict', 'plugin/dist/claude/bughunter'], { encoding: 'utf8' });
assert.equal(valid.status, 0, `${valid.stdout}\n${valid.stderr}`);
```

Run: `node plugin/test/claude-marketplace-install.mjs`
Expected на текущей машине: FAIL `CLAUDE_CLI_MISSING`. Это задокументированный blocker. После установки Claude повторить; следующий RED должен относиться к install/update assertion, если он появится.

- [ ] **Step 2: Реализовать isolated native install**

Использовать temp `CLAUDE_CONFIG_DIR` и `HOME`; не читать реальный `~/.claude`:

```js
const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir, HOME: home };
run('claude', ['plugin', 'marketplace', 'add', marketplaceRoot], { env });
run('claude', ['plugin', 'install', 'bughunter@bughunter-market', '--scope', 'user'], { env });
const list = run('claude', ['plugin', 'list'], { env });
assert.match(list.stdout, /bughunter@bughunter-market/);
assert.match(list.stdout, /loaded|enabled/i);
```

Выполнить real MCP handshake против marketplace server через `withMcpClient`; это не заменяет native loaded check выше. Dormant list должен быть ровно `['bh_setup']`. Вызвать setup web, проверить `.claude/bughunter.json` и 19 tools после нового server process. Отдельный node project даёт 16 tools.

- [ ] **Step 3: Проверить update и сохранность state**

Записать sentinel config, `runs/sentinel.json` и dummy auth file. В локальном marketplace изменить на `0.1.1-test.1` оба поля: `plugins/bughunter/.claude-plugin/plugin.json.version` и `.claude-plugin/marketplace.json.plugins[0].version`, затем:

```js
run('claude', ['plugin', 'marketplace', 'update', 'bughunter-market'], { env });
run('claude', ['plugin', 'update', 'bughunter@bughunter-market'], { env });
assert.equal(await readFile(configPath, 'utf8'), originalSentinel);
assert.equal(await readFile(runSentinel, 'utf8'), '{}\n');
```

Проверить `claude plugin list` после update и повторный MCP handshake. Если native update command требует другого ID, использовать фактический ID из `plugin list`, но не пропускать update.

- [ ] **Step 4: Подключить script и записать evidence**

`plugin/package.json`:

```json
{
  "scripts": {
    "test:claude-marketplace": "node test/claude-marketplace-install.mjs"
  }
}
```

Run: `cd plugin && npm run test:claude-marketplace`
Expected после установки клиента: exit 0, strict validation PASS, native loaded, dormant=1, web=19, node=16, state preserved.

Evidence содержит только clientVersion, surface=cli, gate=install, status=passed, counts и statePreserved=true. При blocker записать `status=blocked`, `blocker=CLAUDE_CLI_MISSING`, без статуса passed.

- [ ] **Step 5: Commit при разрешении**

```sh
git add plugin
git commit -m "test: verify Claude marketplace lifecycle"
```

---

### Task 9: Agent Plugins v1 MCP-Only Artifact

**Files:**
- Create: `plugin/mcp-only.mjs`
- Create: `plugin/prompts/mcp-only-setup.md`
- Create: `plugin/test/mcp-only.test.mjs`
- Create: `plugin/test/qwen-mcp-only-install.mjs`
- Create после реальных gates: `plugin/evidence/qwen/mcp-only/install.json`, `plugin/evidence/qwen/mcp-only/safety.json`
- Modify: `plugin/build.mjs`
- Modify: `plugin/package.json`

**Interfaces:**
- Consumes: общий payload, `qwenHost` для project paths, dormant setup.
- Produces: `buildQwenMcpOnly({ pluginRoot, sharedServer, out, version })`; artifact `dist/qwen/bughunter-mcp` с root `plugin.json`, `mcp.json`, одним setup skill и без `agents/`, full entry, `.claude-plugin/` или `kimi.plugin.json`.

- [ ] **Step 1: Написать failing closed-manifest и content test**

```js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { test } from 'node:test';

const out = 'plugin/dist/qwen/bughunter-mcp';

test('Agent Plugins v1 MCP-only artifact has only portable fields', async () => {
  const manifest = JSON.parse(await readFile(`${out}/plugin.json`, 'utf8'));
  assert.deepEqual(Object.keys(manifest).sort(), ['$schema', 'description', 'name', 'version'].sort());
  assert.equal(manifest.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.equal(manifest.name, 'bughunter-mcp');
  const mcp = JSON.parse(await readFile(`${out}/mcp.json`, 'utf8'));
  assert.deepEqual(mcp.mcpServers.bughunter, {
    type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/server/mcp.mjs'],
  });
  assert.equal(existsSync(`${out}/agents`), false);
  assert.equal(existsSync(`${out}/.claude-plugin`), false);
  assert.equal(existsSync(`${out}/skills/bughunter`), false);
  const readme = await readFile(`${out}/README.md`, 'utf8');
  assert.ok(readme.includes('MCP-only; full workflow not certified'));
});
```

Run: `node --test plugin/test/mcp-only.test.mjs`
Expected: RED, `plugin.json` отсутствует.

- [ ] **Step 2: Реализовать отдельный builder**

```js
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
```

`writeLauncher` копирует оба descriptor paths и применяет version. Не копировать full skills/agents/authoring template в MCP-only. Полный `mcp-only-setup.md`:

```md
---
name: bughunter-setup
description: Настраивает локальный Bughunter MCP в проекте после явного выбора пресета.
---
Спроси пользователя `web` или `node`. После явного выбора вызови `mcp__bughunter__bh_setup` с `preset`. При `CONFIG_CREATED` покажи configPath и попроси заполнить config, затем выполни `/plugins reload` или открой новую сессию. Не выбирай пресет сам. Не обещай автоматический full workflow, native reviewer/test-writer agents или сертифицированный прогон. Отдельные MCP calls разрешены только в рамках схемы и серверных защит.
```

README и skill не содержат full entry workflow.

- [ ] **Step 3: Добавить real Qwen extension install/MCP/safety gate**

В изолированном `--config-dir` выполнить:

```sh
qwen --config-dir "$CONFIG" extensions install "$PWD/plugin/dist/qwen/bughunter-mcp"
```

Через Qwen init и direct MCP client проверить dormant=`bh_setup`, state=false. Вызвать setup web, затем проверить 19 tools; node отдельно 16. Проверить `bh_open` без lease возвращает `LEASE_REQUIRED`/другую существующую lease ошибку до открытия браузера. Не вызывать browser run и не расходовать модель.

Добавить script `"test:qwen-mcp-only": "node test/qwen-mcp-only-install.mjs"`. Если Qwen portable installer отклоняет manifest, сохранить точную диагностику и исправить package по canonical schema; не добавлять agents/commands в root manifest.

- [ ] **Step 4: Запустить regression и commit при разрешении**

Run: `cd plugin && npm test && npm run test:qwen-mcp-only && npm run test:install`
Expected: portable install/MCP/safety GREEN; full Qwen 19/16 и 7/6 не изменились.

```sh
git add plugin
git commit -m "feat: add portable MCP-only package"
```

- [ ] **Step 5 (review fix, 2026-11-18): fail-closed workspace gate для portable хоста**

Critical review finding: Qwen Code CLI 0.28.0 поднимает extension MCP-сервер с `cwd` = корень
установки и env `PLUGIN_ROOT`; старый launcher проверял только Kimi roots, поэтому `bh_setup` писал
opt-in/config в установку. Исправление:

- `launcher.mjs`: `hostPluginRoot()` = `KIMI_PLUGIN_ROOT ?? PLUGIN_ROOT`; сравнение cwd с plugin
  root / Kimi home по realpath (macOS `/var` → `/private/var`); при совпадении проект считается
  unknown. `setup.mjs`: сообщение `BUGHUNTER_PROJECT_UNKNOWN` без привязки к Kimi. Поведение Kimi
  bridge, Qwen preview и Claude не меняется.
- `test/qwen-mcp-only-install.mjs`: добавлен workspace gate — CLI-identical spawn
  (`cwd` = installedRoot, `PLUGIN_ROOT` установлен), `bh_setup` обязан вернуть
  `BUGHUNTER_PROJECT_UNKNOWN`, снимок дерева расширения до/после доказывает ноль новых файлов.
  Direct-client probes (web 19 / node 16 / safety) сохранены как server diagnostics, не как
  доказательство host setup. Evidence: добавлен `workspace.json` со `status: "blocked"`,
  `blocker: "BUGHUNTER_PROJECT_UNKNOWN"` и `sourceCommit`; install/safety evidence тоже несут
  `sourceCommit` и `surface`.
- `support-matrix.mjs`: requirements `'qwen/mcp-only': ['install', 'safety', 'workspace']`; evidence
  со `status: "blocked"` и непустым `blocker` на текущем commit блокирует поверхность этим blocker'ом
  (приоритет над STALE_EVIDENCE). Реальный статус `qwen/mcp-only` — `blocked`, не `mcp-only`.
- `mcp-only.mjs`: `rm(out, { recursive: true, force: true })` перед сборкой (stale-артефакты);
  portable manifest не меняется. README/SKILL пакета явно останавливаются на
  `BUGHUNTER_PROJECT_UNKNOWN` и не сертифицируют настройку проекта на таком хосте.
- Дизайн-спека и план обновлены этим ограничением; регрессия: mcp-only unit, portable gate,
  support-matrix/release tests, `npm test`, preview `test:install`.

---

### Task 10: Evidence-Bound Support Matrix and Release Bundles

**Files:**
- Create: `plugin/support-matrix.mjs`
- Create: `plugin/release.mjs`
- Create: `plugin/test/support-matrix.test.mjs`
- Create: `plugin/test/release.test.mjs`
- Create: `plugin/evidence/README.md`
- Modify: `plugin/package.json`
- Modify: `plugin/.gitignore`

**Interfaces:**
- Consumes: install/model evidence из Tasks 4, 6, 8, 13, 14; versioned native artifacts из Tasks 5, 7, 9.
- Produces: `buildSupportMatrix({ evidenceDir, sourceCommit, version })`, `createRelease({ version, sourceCommit, evidenceDir, outDir })`, `support-matrix.json`, `COMPATIBILITY.md`, per-host zips и `.sha256`.

- [ ] **Step 1: Написать failing tests на запрет unsupported full**

```js
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildSupportMatrix } from '../support-matrix.mjs';

const base = {
  host: 'kimi', surface: 'cli', clientVersion: '2.5.3', status: 'passed',
  sourceCommit: 'a'.repeat(40),
};

test('full requires install, target and resume evidence on the same client', async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'bh-matrix-'));
  await mkdir(join(evidenceDir, 'kimi'), { recursive: true });
  for (const gate of ['install', 'target', 'resume']) {
    await writeFile(join(evidenceDir, 'kimi', `${gate}.json`), JSON.stringify({ ...base, gate }));
  }
  const matrix = await buildSupportMatrix({ evidenceDir, sourceCommit: 'a'.repeat(40), version: '0.2.0' });
  assert.equal(matrix.entries.find((entry) => entry.host === 'kimi' && entry.surface === 'cli').status, 'full');
});

test('missing resume cannot be manually promoted to full', async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'bh-matrix-missing-'));
  await mkdir(join(evidenceDir, 'kimi'), { recursive: true });
  await writeFile(join(evidenceDir, 'kimi', 'install.json'), JSON.stringify({ ...base, gate: 'install' }));
  await writeFile(join(evidenceDir, 'kimi', 'target.json'), JSON.stringify({ ...base, gate: 'target' }));
  const matrix = await buildSupportMatrix({ evidenceDir, sourceCommit: 'a'.repeat(40), version: '0.2.0' });
  assert.equal(matrix.entries.find((entry) => entry.host === 'kimi' && entry.surface === 'cli').status, 'experimental');
});
```

Run: `node --test plugin/test/support-matrix.test.mjs`
Expected: RED `Cannot find module .../support-matrix.mjs`.

- [ ] **Step 2: Реализовать matrix rules**

`support-matrix.mjs` содержит фиксированный required surfaces list: `qwen/cli`, `kimi/cli`, `kimi/desktop`, `claude/cli`, `claude/desktop`, `qwen/mcp-only`. Каждый entry:

```js
{
  host, surface, clientVersion, artifact, level,
  status: 'planned' | 'experimental' | 'full' | 'mcp-only' | 'blocked' | 'unsupported',
  evidence: [],
  blocker: undefined,
}
```

Правила:

```js
const requirements = {
  'qwen/cli': ['install', 'target'],
  'kimi/cli': ['install', 'target', 'resume'],
  'claude/cli': ['install', 'target', 'resume'],
  'kimi/desktop': ['install', 'target'],
  'claude/desktop': ['install', 'target'],
  'qwen/mcp-only': ['install', 'safety', 'workspace'],
};
```

(Amendment 2026-11-18: `qwen/mcp-only` дополнительно требует `workspace` gate — CLI-identical spawn с
`cwd` = plugin root. Evidence со `status: "blocked"` и непустым `blocker` на текущем sourceCommit
блокирует поверхность этим blocker'ом, приоритет над STALE_EVIDENCE; см. Task 9 Step 5.)

Функция читает CLI evidence из `<evidenceDir>/<host>/<gate>.json`, Desktop — `<evidenceDir>/<host>/desktop/<gate>.json`, MCP-only — `<evidenceDir>/<host>/mcp-only/<gate>.json`. Desktop требует отдельные `install.json` и `target.json` с `surface:'desktop'`; CLI install не подменяет Desktop install. Evidence принимается только при `status:'passed'`, совпадающих `sourceCommit`, host/surface/clientVersion и непустом `runId` для target/resume. `full` присваивается только если все required gates есть. `mcp-only` доступен только для `qwen/mcp-only`. Несовпадение sourceCommit даёт `STALE_EVIDENCE`, clientVersion — `CLIENT_VERSION_MISMATCH`; оба статуса blocked.

Qwen install evidence должен содержать `source:'marketplace'`, target evidence — новый run после host refactor. Старые historical runIds не заполняют это поле автоматически.

- [ ] **Step 3: Реализовать deterministic release layout и checksums**

`release.mjs` принимает:

```sh
node plugin/release.mjs --version 0.2.0 --source "$(git rev-parse HEAD)"
```

Перед сборкой проверить semver через `/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/`, `source` как 40 lowercase hex и `source === git rev-parse HEAD`. Проверить `git diff --quiet` и `git diff --cached --quiet`; release из tracked modified tree запрещён.

Layout:

```text
plugin/release/<version>/
  qwen/bughunter.zip + .sha256 + marketplace/
  kimi/bughunter.zip + .sha256 + marketplace.json
  claude/bughunter.zip + .sha256 + marketplace/
  qwen-mcp-only/bughunter-mcp.zip + .sha256
  support-matrix.json
  COMPATIBILITY.md
  release-summary.json
```

Для zip использовать `spawnSync('zip', ['-qr', zipPath, '.'], { cwd: artifactDir })`; checksum вычислять `createHash('sha256').update(await readFile(zipPath)).digest('hex')`. Каждый public marketplace source должен быть supplied release configuration (`--release-base-url` или `--marketplace-repo`), а не выдуманным URL. До реального значения генерировать только local test marketplaces и ставить publication=`not-configured`.

`release-summary.json` перечисляет каждый host как `ready`, `experimental` или `blocked`; команда не печатает общий PASS, если обязательный full host не full. Для экспериментального пакета имя zip допустимо, но marketplace entry обязан содержать description `experimental; full workflow not certified`.

- [ ] **Step 4: Потребовать реальные license materials перед публикацией**

Проверять наличие `plugin/LICENSE` и `plugin/THIRD_PARTY_NOTICES.md` перед созданием publishable marketplace. Не выбирать лицензию от имени пользователя. Если файлы отсутствуют, local artifacts можно тестировать, но `createRelease` возвращает `LICENSE_MATERIALS_MISSING` и `publication=blocked`.

`THIRD_PARTY_NOTICES.md` создаётся publisher/исполнителем из фактических production packages после `npm ci --omit=dev`; для каждого bundled package зафиксировать name/version/license и скопировать текст license/notice, если пакет его содержит. Не записывать `UNLICENSED` как разрешение и не утверждать legal review без него.

- [ ] **Step 5: Протестировать release и подключить scripts**

`release.test.mjs` использует temp artifact directories и fixture evidence, а не настоящий release output. Проверить: одинаковые version/source, sha256 совпадает с повторным вычислением, dirty source rejected, missing license rejected, missing Claude evidence не блокирует Qwen-only local bundle, но `--host all` не сообщает общий PASS.

Добавить:

```json
{
  "scripts": {
    "release": "node release.mjs",
    "test:release": "node --test test/release.test.mjs test/support-matrix.test.mjs"
  }
}
```

В `plugin/.gitignore` добавить `evidence/*.json` и host subdirectories, но оставить `evidence/README.md` trackable. README evidence описывает обязательные поля и запрет tokens/full transcripts.

Run: `cd plugin && npm test && npm run test:release`
Expected: все matrix/release unit tests GREEN; реальный public release не создан и не опубликован.

- [ ] **Step 6: Commit при разрешении**

```sh
git add plugin
git commit -m "feat: bind release support to host evidence"
```

---

### Task 11: Active Documentation and Prompt Contract Parity

**Files:**
- Modify: `README.md`
- Modify: `plugin/README.md`
- Modify: `.qwen/bughunter/README.md`
- Modify: `plugin/AUTHORING.md`
- Modify: `.qwen/bughunter/core/test/docs.bhtest.ts`
- Modify: `.qwen/bughunter/core/test/prompts-core.bhtest.ts`
- Modify: `.qwen/bughunter/presets/web/test/prompts.bhtest.ts`

**Interfaces:**
- Consumes: реальные paths/invocations из Tasks 1–10.
- Produces: одна актуальная support/install narrative; historical reports остаются неизменными.

- [ ] **Step 1: Сначала обновить docs/prompt tests под новый контракт**

Добавить assertions, которые падают на текущем Qwen-only тексте:

```ts
test('active docs distinguish native hosts and support levels', async () => {
  const readme = await readFile(join(projectRoot, 'README.md'), 'utf8');
  for (const token of ['Kimi', 'Claude', 'Qwen', 'bughunter-mcp', 'custom marketplace']) {
    assert.ok(readme.includes(token), token);
  }
  assert.ok(readme.includes('Полный workflow') || readme.includes('full workflow'));
  assert.ok(!readme.includes('Поддержка плагинных MCP-серверов и агентов проверена') || readme.includes('Qwen'));
});
```

В prompt tests проверить, что canonical source не получил Kimi/Claude branches, а rendered artifacts (через plugin tests) содержат правильные names. Не переносить artifact-specific assertions в core domain tests.

Run: `cd .qwen/bughunter/core && node --test --test-concurrency=1 test/docs.bhtest.ts test/prompts-core.bhtest.ts`
Expected: RED на отсутствующих новых active-doc tokens.

- [ ] **Step 2: Обновить root README**

Заменить Qwen-only install lead таблицей с точными командами:

```md
| Host | Full entry | Project state |
| --- | --- | --- |
| Qwen | `/bughunter:bughunter` | `.qwen/bughunter/state/<preset>/` |
| Kimi | `/skill:bughunter:bughunter` | `.kimi-code/bughunter/state/<preset>/` |
| Claude | `/bughunter:bughunter` | `.claude/bughunter/state/<preset>/` |
```

Добавить: custom marketplace добавляется один раз; official/curated acceptance не подразумевается; `bughunter-mcp` не означает full workflow; текущий статус берётся из `COMPATIBILITY.md`. Не объявлять Kimi/Claude full до Tasks 13–14.

- [ ] **Step 3: Обновить operator и authoring docs**

`.qwen/bughunter/README.md` остаётся Qwen/manual operator reference: явно отделить repo paths от plugin state и добавить ссылку на host-specific README. `plugin/AUTHORING.md` должен говорить, что preset authoring общий, а новый host требует descriptor и gates, не правки core. `plugin/README.md` становится Qwen-specific artifact readme и ссылается на общий root install matrix.

Не менять исторические `docs/superpowers/reports/*`, handoff или `v0.1.0` release notes. Не выдумывать publisher URLs.

- [ ] **Step 4: Проверить docs и все prompt tests**

Run:

```sh
cd .qwen/bughunter/core && node --test --test-concurrency=1 test/docs.bhtest.ts test/prompts-core.bhtest.ts
cd ../presets/web && node --test --test-concurrency=1 test/prompts.bhtest.ts
cd ../node && node --test --test-concurrency=1 test/prompts.bhtest.ts
```

Expected: все `fail 0`; artifact tests из Tasks 5/7 также остаются GREEN.

- [ ] **Step 5: Commit при разрешении**

```sh
git add README.md plugin/README.md plugin/AUTHORING.md .qwen/bughunter/README.md .qwen/bughunter/core/test .qwen/bughunter/presets/web/test .qwen/bughunter/presets/node/test
git commit -m "docs: describe native host installations"
```

---

### Task 12: Complete Automated Regression Line

**Files:**
- Modify только по фактически найденным regression causes; никаких planned feature files сверх Tasks 1–11.

**Interfaces:**
- Consumes: все предыдущие автоматические deliverables.
- Produces: свежий автоматический verdict для текущего source tree; model support пока остаётся experimental.

- [ ] **Step 1: Запустить core/web/node и template под caffeinate**

Run из `.qwen/bughunter`:

```sh
caffeinate -i bash -c 'npm test && npm run typecheck'
```

Expected: core/web/node `fail 0`, typecheck трёх пакетов clean. Запустить пакеты отдельно, если workspace runner останавливается на первом failure; сохранить фактические counts.

Run template:

```sh
cd docs/concept/examples/cli-preset/preset
npm test && npm run typecheck
```

Expected: все template tests `fail 0`, typecheck clean.

- [ ] **Step 2: Запустить node acceptance и восстановить report**

```sh
cd .qwen/bughunter/presets/node
BH_NODE_ACCEPTANCE=1 node --test --test-concurrency=1 test/node-api-acceptance.bhtest.ts
git checkout -- ../fixtures/node-api-app/ACCEPTANCE.md
```

Expected: 6/6. Проверить правильный относительный path `git checkout -- .qwen/bughunter/fixtures/node-api-app/ACCEPTANCE.md` из repo root, если предыдущий relative path из preset не совпадает; не оставлять generated acceptance diff.

- [ ] **Step 3: Запустить все доступные plugin gates**

```sh
cd plugin
node build.mjs --host all
npm test
npm run test:install
npm run test:qwen-marketplace
npm run test:kimi-marketplace
npm run test:qwen-mcp-only
npm run test:release
```

Если Claude установлен к этому моменту, добавить `npm run test:claude-marketplace`. Если нет, выполнить команду и зафиксировать ожидаемый blocking `CLAUDE_CLI_MISSING`; не включать её в зелёный сводный PASS.

Expected для доступных gates: Qwen 19/16 и 7/6; Kimi 19/16 и 7 skills; dormant=1/state=false; MCP-only safety PASS; state sentinel сохранён; release unit GREEN.

- [ ] **Step 4: Проверить source/artifact cleanliness**

```sh
git diff --check
git status --short --branch
```

Expected: нет whitespace errors; нет generated `dist`, acceptance, logs, test output или credentials среди tracked modifications. Удалять только файлы, созданные этими командами и не нужные deliverable. Существующий старый untracked plan не удалять.

- [ ] **Step 5: Зафиксировать automated evidence и commit при разрешении**

Создать `docs/superpowers/reports/2026-11-17-multi-host-automated.md` только если пользователь разрешил implementation deliverables с таким report; иначе итоговый response содержит counts без нового report file. Не создавать report автоматически ради scaffolding.

```sh
git add <только-фактически-изменённые-source-files>
git commit -m "test: verify multi-host automated gates"
```

---

### Task 13: Qwen/Kimi Full Model Gates and Desktop Evidence

**Files:**
- Create: `plugin/test/model-gate-fixture.mjs`
- Create: `plugin/test/record-model-evidence.mjs`
- Create: `plugin/evidence/qwen/target.json`, `plugin/evidence/kimi/target.json`, `plugin/evidence/kimi/resume.json` только после фактических прогонов (ignored runtime evidence)
- Create: `plugin/evidence/kimi/desktop/install.json` и `plugin/evidence/kimi/desktop/target.json` только после реальных Desktop install/run

**Interfaces:**
- Consumes: marketplace artifacts, отдельное пользовательское разрешение на модельные прогоны и настроенные providers в isolated gate config.
- Produces: `recordModelGate({ host, surface, gate, clientVersion, sourceCommit, runId, runDir, redCommand, redResult, orchestration })`; sanitized evidence с `status:'passed'` только после всех assertions.

- [ ] **Step 1: Получить отдельное разрешение и зафиксировать версии**

Не начинать task без явного разрешения на модельные прогоны. Записать:

```sh
qwen --version
kimi --version
```

Expected baseline: Qwen `1.0.0-preview.1`, Kimi `2.5.3` либо новая явно зафиксированная версия. Если version изменилась, install gate повторяется на ней.

- [ ] **Step 2: Создать одноразовую fixture без кода реального приложения**

`model-gate-fixture.mjs` принимает `--out <absolute-new-path> --port <free-port>` и выполняет только локальные операции:

```js
import { cp, mkdir } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';

export async function prepareFixture({ fixture, out, port }) {
  await mkdir(out, { recursive: true });
  await cp(fixture, out, { recursive: true, filter: (source) => !source.includes('node_modules') });
  for (const args of [['init', '-b', 'main'], ['add', '.']]) {
    const result = spawnSync('git', args, { cwd: out, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
  }
  const install = spawnSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: out, stdio: 'inherit' });
  if (install.status !== 0) throw new Error('FIXTURE_NPM_CI_FAILED');
  const child = spawn(process.execPath, [join(out, 'node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: out,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { child, baseUrl: `http://127.0.0.1:${port}` };
}
```

CLI ждёт HTTP 200 от baseUrl, печатает только baseUrl и PID, оставляет процесс для gate и останавливает его по SIGINT/SIGTERM. Не запускать на реальном Навигаторе BI или production.

- [ ] **Step 3: Выполнить Qwen target regression**

Установить Qwen plugin из local marketplace в isolated `--config-dir bughunter-gate/multi-host/qwen-config`, выполнить trust/setup через native flow и заполнить web config fixture. Запустить:

```sh
caffeinate -i qwen --config-dir "$PWD/bughunter-gate/multi-host/qwen-config" \
  -p '/bughunter:bughunter target /orders/new' --output-format stream-json \
  --no-session-persistence --allowed-mcp-server-names bughunter \
  > bughunter-gate/multi-host/qwen-target.jsonl 2> bughunter-gate/multi-host/qwen-target.stderr.log
```

Expected: exit 0, run finished, stages done, Pending None, минимум один ожидаемый confirmed, 0 confirmed false, foreground native agents, main не вызывает triage/export/verify. Проверить экспортированный Playwright test отдельно:

```sh
npx playwright test e2e/bughunter --workers=1
```

Expected: `failed > 0` именно на целевых assertions, не import/launch errors.

- [ ] **Step 4: Выполнить Kimi CLI target и resume**

Kimi entry:

```sh
KIMI_CODE_HOME="$PWD/bughunter-gate/multi-host/kimi-home" \
  caffeinate -i kimi -p '/skill:bughunter:bughunter target /orders/new' \
  --output-format stream-json \
  > bughunter-gate/multi-host/kimi-target.jsonl 2> bughunter-gate/multi-host/kimi-target.stderr.log
```

Expected такой же lifecycle/red criteria. Проверить в JSONL фактические `Agent` calls с `subagent_type` `bughunter:bh-explorer`, `bughunter:bh-reviewer`, `bughunter:bh-test-writer`; foreground only, один explorer за раз. Отсутствие событий — FAIL evidence, а не предположение об успехе.

Для resume начать новый target с записанным PID, дождаться `run.status=writing_tests` и минимум одного завершённого candidate, отправить SIGINT именно PID `kimi`, затем:

```sh
KIMI_CODE_HOME="$PWD/bughunter-gate/multi-host/kimi-home" \
  caffeinate -i kimi -p '/skill:bughunter:bughunter resume <runId>' --output-format stream-json
```

`<runId>` заменяется фактическим ID из run.json; это обязательный operator input, не placeholder в итоговом evidence. Expected: завершённые reproduction/review/test artifacts побайтово совпадают до/после для уже обработанных candidates, оставшиеся завершены, Pending None.

- [ ] **Step 5: Реализовать evidence validator**

`record-model-evidence.mjs` читает `run.json`, `report.md`, candidates и normalized orchestration report. Записываемый контракт:

```js
{
  host,
  surface,
  gate,
  clientVersion,
  sourceCommit,
  runId,
  status: 'passed',
  finished: true,
  pending: 0,
  confirmedFalse: 0,
  nativeForegroundAgents: true,
  singleExplorer: true,
  mainRestrictedTools: 0,
  red: { command: redCommand, failedAssertions: redResult.failedAssertions }
}
```

Validator отклоняет запись, если любое boolean false, `failedAssertions < 1`, runId не совпадает с `runDir`, report содержит pending work или candidate counts не соответствуют `confirmedFalse:0`. Orchestration report обязан содержать source transcript path и counts; его создаёт reviewer по фактическим native events, а не пустым `true`. Для Qwen группировать tool calls по `message.id`; для Kimi/Claude использовать их native tool/task event ids и сохранять правило одного foreground explorer.

- [ ] **Step 6: Выполнить Kimi Desktop target в реальном UI**

Открыть проект фикстуры через `kimi app <fixture-path>`, в Settings → Plugins использовать тот же local custom marketplace в изолированном gate home, если Desktop поддерживает такой isolation; иначе остановиться и согласовать временную пользовательскую установку до любых изменений. В реальном UI выполнить trust, install, setup `/reload`, config и `/skill:bughunter:bughunter target /orders/new`.

Expected: visible native agents, finished run, red independently. Записать Desktop version из About; после install/update создать `evidence/kimi/desktop/install.json`, после run — `evidence/kimi/desktop/target.json` с `surface:'desktop'`, `gate:'target'`, `runId` и текущим `sourceCommit`. Не использовать CLI result как Desktop evidence. При отсутствии Desktop app или custom marketplace UI статус `blocked` с конкретной причиной.

- [ ] **Step 7: Повторить support matrix и commit только tooling при разрешении**

Run: `cd plugin && npm run test:release`
Expected: Qwen CLI может стать full только при новом target+marketplace evidence; Kimi CLI full только при install+target+resume; Kimi Desktop full только при Desktop install+target. Иначе experimental/blocked.

```sh
git add plugin/test/model-gate-fixture.mjs plugin/test/record-model-evidence.mjs plugin/support-matrix.mjs
git commit -m "test: add native model evidence gates"
```

Не коммитить tokens, full transcripts, auth или ignored evidence.

---

### Task 14: Claude Full Model Gates and Desktop Evidence

**Files:**
- Create: `plugin/evidence/claude/target.json` и `plugin/evidence/claude/resume.json` только после фактических CLI прогонов
- Create: `plugin/evidence/claude/desktop/install.json` и `plugin/evidence/claude/desktop/target.json` только после реальных Desktop install/run
- Modify: `plugin/test/record-model-evidence.mjs` только если Claude native transcript требует новый parser
- Modify: `plugin/hosts/claude.README.md` с фактической проверенной версией

**Interfaces:**
- Consumes: Claude install gate из Task 8 и evidence validator из Task 13.
- Produces: Claude CLI/Desktop full или конкретный blocked status; никакого предполагаемого PASS.

- [ ] **Step 1: Устранить prerequisite blocker с разрешением пользователя**

Проверить `command -v claude && claude --version`. На текущем дереве ожидается `CLAUDE_CLI_MISSING` до установки. Установка Claude Code — отдельное пользовательское действие/разрешение; не устанавливать глобальный пакет автоматически. После установки повторить Task 8 и зафиксировать версию.

- [ ] **Step 2: Выполнить Claude CLI target и resume**

После отдельного разрешения на модельный прогон использовать local fixture и native plugin:

```sh
caffeinate -i claude -p '/bughunter:bughunter target /orders/new' --output-format stream-json \
  > bughunter-gate/multi-host/claude-target.jsonl 2> bughunter-gate/multi-host/claude-target.stderr.log
```

Если установленная версия использует другое output flag, получить `claude --help`, зафиксировать версию и использовать документированный streaming output; не запускать с `--dangerously-skip-permissions`.

Expected: plugin MCP runtime name `plugin:bughunter:bughunter`, agents `bughunter:bh-*`, finished/Pending None, 0 confirmed false, red independent. Resume выполняется по фактическому runId после SIGINT PID `claude`:

```sh
caffeinate -i claude -p '/bughunter:bughunter resume <runId>' --output-format stream-json
```

- [ ] **Step 3: Выполнить Claude Desktop Code target**

В Claude Desktop открыть local Code session на fixture, установить plugin через custom marketplace, выбрать scope, выполнить setup/config и `/bughunter:bughunter target /orders/new`. Проверить native agents и finished run. Обычный chat, claude.ai и Cowork не принимаются как substitute evidence для Desktop Code.

Записать Desktop client version, `desktop/install.json` после install/update и `desktop/target.json` после run с текущим `sourceCommit`. Если local stdio MCP или agents не поддерживаются на фактической surface, полный Claude Desktop не выпускается; поддерживаемый MCP-only, если вообще проверен, оформляется отдельно по дизайну.

- [ ] **Step 4: Обновить matrix без ручного full**

Run: `cd plugin && npm run test:release`
Expected: Claude CLI full только при install+target+resume на одной версии; Desktop full только при install+Desktop target. Любой missing gate оставляет experimental/blocked.

- [ ] **Step 5: Commit только tooling/docs при разрешении**

```sh
git add plugin/test/record-model-evidence.mjs plugin/hosts/claude.README.md plugin/support-matrix.mjs
git commit -m "test: certify Claude native workflow"
```

---

### Task 15: Final Whole-Branch Review and Release Handoff

**Files:**
- Modify: только issues, найденные review, каждый со своим failing regression test.
- Create: `docs/superpowers/reports/2026-11-17-multi-host-final-review.md` только если пользователь запросил report deliverable; иначе не создавать.

**Interfaces:**
- Consumes: все предыдущие tasks и фактические support statuses.
- Produces: финальный verdict по каждому host/surface и release handoff без публикации.

- [ ] **Step 1: Провести spec coverage review**

Для каждого раздела spec указать task/evidence: descriptor boundaries, native paths, setup, marketplace install, update preservation, full/MCP-only separation, Qwen regression, Kimi/Claude model gates, release provenance, license blockers. Любой непокрытый пункт получает новый failing test и исправление; не объявлять done по общему впечатлению.

- [ ] **Step 2: Проверить типы и cross-task interfaces**

```sh
cd plugin && npm test && node build.mjs --host all
cd ../.qwen/bughunter && npm run typecheck --workspaces
```

Проверить, что `hostPaths`, `mcpToolName`, `buildServerPayload`, `renderPromptLayer`, `withMcpClient`, `buildSupportMatrix`, `recordModelGate` имеют одинаковые names/signatures во всех imports. Найти unresolved host tokens и чужие paths в artifacts; результат должен быть пустым.

- [ ] **Step 3: Повторить только affected gates после fixes**

Если менялся launcher/setup — повторить local+marketplace install/update для всех доступных hosts и Qwen model regression. Если менялся prompt/agent text — повторить соответствующий model target. Не выдавать старый model result за доказательство нового diff.

- [ ] **Step 4: Сформировать release handoff без публикации**

Проверить:

```sh
git diff --check
git status --short --branch
git log --oneline -15
```

В response перечислить: commits, автоматические counts, model runIds, support matrix statuses, license/publisher blockers, точные release commands и оставшиеся external actions. Не выполнять `git push`, не загружать zip и не подавать Kimi/Claude directory заявки без нового явного разрешения.

- [ ] **Step 5: Финальный commit при разрешении**

```sh
git add <только-reviewed-files>
git commit -m "chore: finalize multi-host distribution gates"
```

Если implementation commits не разрешены, оставить изменения в рабочем дереве и явно перечислить их; не использовать commit-команды символически.

---

## Plan Self-Review Checklist for the Executor

Эти проверки не заменяют self-review автора плана; они помогают не потерять границы при исполнении:

- [ ] Ни один full support status не появился без target/resume/Desktop evidence, требуемого matrix.
- [ ] Dormant до setup не создаёт state и отдаёт только `bh_setup`; полный набор остаётся 19/16.
- [ ] Kimi/Claude artifacts не содержат `.qwen/`; Qwen artifact не содержит новых host paths.
- [ ] Claude agents используют `mcp__plugin_bughunter_bughunter__*`, Kimi/Qwen — `mcp__bughunter__*`.
- [ ] Agent Plugins v1 root manifest закрыт и не содержит agents/commands/mcpServers.
- [ ] Update/reinstall не меняет config/runs/auth sentinels.
- [ ] Public URLs, license, publisher identity и official listing не выдумываются.
- [ ] Старый docs plan и `v0.1.0` release assets не включены в новые commits.
