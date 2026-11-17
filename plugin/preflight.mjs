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
