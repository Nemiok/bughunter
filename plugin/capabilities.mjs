import { spawnSync } from 'node:child_process';

const RUN_OPTIONS = { encoding: 'utf8', timeout: 10_000, shell: false };

function invoke(run, binary, args, options) {
  try {
    return run(binary, args, options) ?? {};
  } catch {
    return {};
  }
}

function runHelp(run, binary, command) {
  return invoke(run, binary, [command, '--help'], RUN_OPTIONS).status === 0;
}

export function probeClientCommands({
  binary,
  family,
  run = (command, args, options) => spawnSync(command, args, options),
}) {
  const version = invoke(run, binary, ['--version'], RUN_OPTIONS);
  const plugins = runHelp(run, binary, 'plugins');
  const extensions = runHelp(run, binary, 'extensions');
  const stdout = typeof version.stdout === 'string' ? version.stdout.trim() : '';
  return {
    family: family ?? 'unknown',
    binary,
    clientVersion: version.status === 0 && stdout !== '' ? stdout : 'unknown',
    commands: { plugins, extensions },
  };
}

export function selectInstallCandidate({ family, binary, commands }) {
  if (family === 'qwen' && commands.plugins === true) {
    return { family, binary, channel: 'plugins', artifact: 'qwen' };
  }
  if ((family === 'qwen' || family === 'gigacode') && commands.extensions === true) {
    return {
      family, binary, channel: 'extensions',
      artifact: family === 'qwen' ? 'qwen-extension' : 'gigacode',
    };
  }
  if (family !== 'qwen' && family !== 'gigacode') {
    throw new Error('CLIENT_CAPABILITY_MISSING: supported client family');
  }
  throw new Error('CLIENT_CAPABILITY_MISSING: plugins or extensions installation');
}

function nonempty(value) {
  return typeof value === 'string' && value.length > 0;
}

export function validateRuntimeCapabilities(report, expectedHost) {
  if (!['qwen', 'gigacode'].includes(expectedHost) || report?.host !== expectedHost) {
    throw new Error(`CAPABILITY_REPORT_HOST_MISMATCH: ${expectedHost}`);
  }
  if (report.channel !== 'extensions') {
    throw new Error('CLIENT_CAPABILITY_MISSING: extensions channel');
  }
  const manifest = expectedHost === 'qwen' ? 'qwen-extension.json' : 'gigacode-extension.json';
  if (report.manifest !== manifest) {
    throw new Error('CLIENT_CAPABILITY_MISSING: native extension manifest');
  }
  for (const component of ['mcp', 'skills', 'agents']) {
    if (report.components?.[component] !== true) {
      throw new Error(`CLIENT_CAPABILITY_MISSING: ${component}`);
    }
  }
  if (!nonempty(report.workspaceExpression)) {
    throw new Error('CLIENT_CAPABILITY_MISSING: workspace project cannot be resolved');
  }
  for (const field of [
    'clientVersion', 'extensionRootExpression', 'mcpToolPrefix', 'skillNamespace',
    'agentNamespace', 'reloadInstruction', 'refreshInstruction', 'entryInvocation',
  ]) {
    if (!nonempty(report[field])) throw new Error(`CAPABILITY_REPORT_INVALID: ${field}`);
  }
  if (report.status !== 'passed' || !/^[a-f0-9]{40}$/.test(report.sourceCommit)) {
    throw new Error('CAPABILITY_REPORT_INVALID: passed runtime evidence and sourceCommit required');
  }
  for (const tool of ['Read', 'Write', 'Edit', 'Bash', 'Agent', 'Skill', 'Grep', 'Glob']) {
    if (!nonempty(report.tools?.[tool])) throw new Error(`CAPABILITY_REPORT_INVALID: tools.${tool}`);
  }
  return report;
}
