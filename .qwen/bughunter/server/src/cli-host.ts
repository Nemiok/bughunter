/** Project-relative host directory for Qwen Code CLI artifacts (.qwen/). */
export const CLI_HOST_DIR = '.qwen';

export function cliInstallHint(): string {
  return `cd ${CLI_HOST_DIR}/bughunter/server && npm ci`;
}
