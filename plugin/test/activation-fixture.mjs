import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const BUGHUNTER_WEB_TOOLS = [
  'bh_act',
  'bh_close',
  'bh_crawl',
  'bh_detect_tests',
  'bh_explore_next',
  'bh_export_test',
  'bh_finish_run',
  'bh_navigate',
  'bh_open',
  'bh_probe',
  'bh_promote_finding',
  'bh_report_candidate',
  'bh_reproduce',
  'bh_resume_run',
  'bh_start_run',
  'bh_state',
  'bh_sweep',
  'bh_triage',
  'bh_verify_red',
].map((name) => `mcp__bughunter__${name}`);

export const BUGHUNTER_SKILLS = [
  'bughunter',
  'bughunter-oracles',
  'bughunter-red-test',
  'bughunter-preset-card-web',
  'bughunter-preset-card-node',
  'bughunter-preset-guide',
  'bughunter-core-contract',
];

export const BUGHUNTER_AGENTS = [
  'bh-explorer',
  'bh-reviewer',
  'bh-test-writer',
  'bh-explorer-node',
  'bh-reviewer-node',
  'bh-test-writer-node',
];

const NATIVE_TOOLS = ['Agent', 'Bash', 'CodeMode', 'Edit', 'Read', 'Write'];

export function toolUse(name, input, id) {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  };
}

export function toolResult(id, content, isError = false) {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
  };
}

export function userText(text) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
}

function initEvent({ sessionId, cwd, pluginRoot, tools, skills, agents, mcpStatus = 'connected' }) {
  return {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    cwd,
    tools,
    skills,
    agents,
    mcp_servers: [{ name: 'bughunter', status: mcpStatus }],
    plugins: [{ name: 'bughunter', path: pluginRoot }],
  };
}

export async function writeActivationTranscript(path, events) {
  await writeFile(path, events.map((event) => `${JSON.stringify(event)}\n`).join(''), 'utf8');
}

export function createActivationFixture(root) {
  const projectRoot = join(root, 'project');
  const pluginRoot = join(root, 'plugin');
  const stateDir = join(projectRoot, '.qwen', 'bughunter', 'state', 'web');
  const beforeTranscriptPath = join(root, 'before.jsonl');
  const afterTranscriptPath = join(root, 'after.jsonl');
  const beforeInit = initEvent({
    sessionId: 'session-A',
    cwd: projectRoot,
    pluginRoot,
    tools: [...NATIVE_TOOLS, 'mcp__bughunter__bh_setup'],
    skills: ['bughunter'],
    agents: [],
  });
  const afterInit = initEvent({
    sessionId: 'session-B',
    cwd: projectRoot,
    pluginRoot,
    tools: [...NATIVE_TOOLS, ...BUGHUNTER_WEB_TOOLS],
    skills: [...BUGHUNTER_SKILLS],
    agents: [...BUGHUNTER_AGENTS],
  });
  const create = toolUse(
    'Bash',
    { command: `node ${join(pluginRoot, 'server', 'setup-cli.mjs')} --action create --preset web` },
    'setup-create',
  );
  const validate = toolUse(
    'Bash',
    { command: `node ${join(pluginRoot, 'server', 'setup-cli.mjs')} --action validate --preset web` },
    'setup-validate',
  );
  const inventory = toolUse(
    'CodeMode',
    { code: "return ALL_TOOLS.filter((tool) => tool.name.startsWith('mcp__bughunter__'))" },
    'activation-inventory',
  );
  return {
    root,
    projectRoot,
    pluginRoot,
    stateDir,
    beforeTranscriptPath,
    afterTranscriptPath,
    beforeInit,
    afterInit,
    beforeEvents: [
      beforeInit,
      userText('Настрой Bughunter для /orders/new'),
      create,
      toolResult('setup-create', JSON.stringify({ code: 'SETUP_CREATED', preset: 'web' })),
      validate,
      toolResult('setup-validate', JSON.stringify({ code: 'SETUP_VALID', preset: 'web' })),
    ],
    afterEvents: [
      afterInit,
      userText('Продолжай'),
      inventory,
      toolResult('activation-inventory', JSON.stringify({
        tools: BUGHUNTER_WEB_TOOLS,
        skills: BUGHUNTER_SKILLS,
        agents: BUGHUNTER_AGENTS,
      })),
    ],
  };
}

export async function persistActivationFixture(fixture) {
  const stateDir = fixture.stateDir;
  await mkdir(join(fixture.projectRoot, '.qwen'), { recursive: true });
  await mkdir(join(stateDir, 'profiles'), { recursive: true });
  await mkdir(join(stateDir, 'scenarios'), { recursive: true });
  await mkdir(join(stateDir, 'runs', 'run-existing'), { recursive: true });
  await mkdir(join(stateDir, 'auth'), { recursive: true });
  await mkdir(fixture.pluginRoot, { recursive: true });
  await writeFile(join(fixture.projectRoot, '.qwen', 'bughunter.json'), `${JSON.stringify({ preset: 'web' }, null, 2)}\n`);
  await writeFile(join(stateDir, 'config.json'), `${JSON.stringify({
    baseUrl: 'http://127.0.0.1:4311/',
    allowedOrigins: ['http://127.0.0.1:4311'],
    routes: ['/orders/new'],
    targetMap: {},
    baseBranch: 'main',
    limits: { stepsPerSession: 60, candidatesPerRun: 20 },
    safety: { forbiddenActionText: [], readOnly: false },
    testDataPrefix: 'bh_',
    detectors: { ignoreConsole: [], ignoreRequests: [], anomalyTexts: [], errorBoundarySelector: '[data-error-boundary]' },
    tests: { unit: { command: null }, generated: { dir: 'e2e/bughunter' } },
  }, null, 2)}\n`);
  await writeFile(join(stateDir, 'profiles', 'default.json'), `${JSON.stringify({ name: 'default' }, null, 2)}\n`);
  await writeFile(join(stateDir, 'scenarios', 'orders-new.json'), `${JSON.stringify({ name: 'orders-new' }, null, 2)}\n`);
  await writeFile(join(stateDir, 'runs', 'run-existing', 'run.json'), `${JSON.stringify({ id: 'run-existing' })}\n`);
  await writeFile(join(stateDir, 'auth', 'storage-state.json'), `${JSON.stringify({ cookies: [], origins: [] })}\n`);
  await writeFile(join(fixture.pluginRoot, 'package.json'), `${JSON.stringify({ name: 'bughunter', version: '0.2.4' }, null, 2)}\n`);
  await writeActivationTranscript(fixture.beforeTranscriptPath, fixture.beforeEvents);
  await writeActivationTranscript(fixture.afterTranscriptPath, fixture.afterEvents);
  return fixture;
}

export async function validActivationFixture() {
  const root = await mkdtemp(join(tmpdir(), 'bh-activation-'));
  return persistActivationFixture(createActivationFixture(root));
}

export async function activationWriterFixture() {
  const fixture = await validActivationFixture();
  const configDir = fixture.root;
  const installPath = fixture.pluginRoot;
  const evidenceDir = join(fixture.root, 'evidence');
  const publicInstallEvidencePath = join(fixture.root, 'public-install.json');
  const publicEvidence = {
    host: 'qwen',
    surface: 'cli',
    gate: 'public-install',
    status: 'passed',
    source: 'github-marketplace',
    public: true,
    sha256Verified: true,
    statePreserved: true,
    sourceCommit: 'a'.repeat(40),
    clientVersion: '1.0.0-preview.2',
    installedFrom: '0.2.3',
    updatedTo: '0.2.4',
    pluginId: 'bughunter@bughunter-market',
    installPathWithinConfig: true,
    archiveSha256: 'b'.repeat(64),
    sentinels: ['auth', 'config', 'profiles', 'runs'],
  };
  await writeFile(publicInstallEvidencePath, `${JSON.stringify(publicEvidence, null, 2)}\n`, 'utf8');
  return {
    ...fixture,
    configDir,
    installPath,
    evidenceDir,
    publicInstallEvidencePath,
    publicEvidence,
    installList: [{
      id: 'bughunter@bughunter-market',
      name: 'bughunter',
      version: '0.2.4',
      enabled: true,
      installPath,
    }],
    spawn: () => ({ status: 0, stdout: '1.0.0-preview.2\n', stderr: '' }),
  };
}

export async function cleanupActivationFixture(fixture) {
  await rm(fixture.root, { recursive: true, force: true });
}
