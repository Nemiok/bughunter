import { isAbsolute, resolve } from 'node:path';

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
  if (!['create', 'print'].includes(action)) throw new Error(`SETUP_ACTION_INVALID: ${action}`);
  if (!['web', 'node'].includes(preset)) throw new Error(`BUGHUNTER_PRESET_INVALID: ${preset}`);
  if (projectRoot === undefined || !isAbsolute(projectRoot)) {
    throw new Error('SETUP_PROJECT_ABSOLUTE_REQUIRED');
  }
  return { action, projectRoot: resolve(projectRoot), preset };
}

export async function runSetupCli(argv, {
  host,
  serverRoot,
  preflight = checkPrerequisites,
  log = console.log,
}) {
  const { action, projectRoot, preset } = parseSetupArgs(argv);
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
