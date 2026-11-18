import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { hostPaths } from './hosts/descriptor.mjs';
import { checkPrerequisites } from './preflight.mjs';
import { setupProject } from './setup.mjs';

function option(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

export function parseSetupArgs(argv) {
  const action = option(argv, '--action');
  const projectRoot = option(argv, '--project-root');
  const preset = option(argv, '--preset');
  if (!['create', 'print', 'validate'].includes(action)) {
    throw new Error(`SETUP_ACTION_INVALID: ${action}`);
  }
  if (!['web', 'node'].includes(preset)) throw new Error(`BUGHUNTER_PRESET_INVALID: ${preset}`);
  if (projectRoot === undefined || !isAbsolute(projectRoot)) {
    throw new Error('SETUP_PROJECT_ABSOLUTE_REQUIRED');
  }
  return { action, projectRoot: resolve(projectRoot), preset };
}

export async function validateSetup({ host, projectRoot, preset, serverRoot }) {
  const paths = hostPaths(host, projectRoot, preset);
  let optIn;
  try {
    optIn = JSON.parse(await readFile(paths.optIn, 'utf8'));
  } catch (error) {
    throw new Error(`SETUP_OPT_IN_INVALID: ${paths.optIn}: ${error.message}`);
  }
  if (optIn.preset !== preset) throw new Error(`SETUP_PRESET_CONFLICT: ${paths.optIn}`);
  const configModule = await import(pathToFileURL(join(serverRoot, 'presets', preset, 'src', 'config.ts')).href);
  const config = preset === 'web'
    ? await configModule.loadConfig(paths.stateDir)
    : await configModule.loadNodeConfig(paths.stateDir);
  if (preset === 'node') {
    const profileModule = await import(pathToFileURL(join(serverRoot, 'presets', 'node', 'src', 'profile.ts')).href);
    await profileModule.loadNodeProfile(paths.stateDir, config.profile);
  }
  return {
    code: 'SETUP_VALID',
    optInPath: paths.optIn,
    configPath: paths.configPath,
    ...(preset === 'node' ? { profile: config.profile } : {}),
  };
}

export async function runSetupCli(argv, {
  host,
  serverRoot,
  preflight = checkPrerequisites,
  log = console.log,
}) {
  const { action, projectRoot, preset } = parseSetupArgs(argv);
  if (action === 'validate') {
    const result = await validateSetup({ host, projectRoot, preset, serverRoot });
    log(JSON.stringify(result));
    return result;
  }
  if (action === 'create') {
    const result = await setupProject({ host, projectRoot, preset, serverRoot, preflight });
    log(JSON.stringify(result));
    return result;
  }
  const paths = hostPaths(host, projectRoot, preset);
  const result = {
    code: 'SETUP_PATHS',
    host: host.id,
    preset,
    optInPath: paths.optIn,
    stateDir: paths.stateDir,
    configPath: paths.configPath,
    installPath: resolve(serverRoot, '..'),
  };
  log(JSON.stringify(result));
  return result;
}
