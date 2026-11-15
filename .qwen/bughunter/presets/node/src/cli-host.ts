/** Каталог хоста Qwen Code CLI относительно корня проекта. */
export const CLI_HOST_DIR = '.qwen';

export function cliInstallHint(): string {
  return `cd ${CLI_HOST_DIR}/bughunter && npm ci`;
}
