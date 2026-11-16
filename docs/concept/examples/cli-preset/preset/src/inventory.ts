import type { TargetInventory } from '@bughunter/core';

import { loadCliConfig } from './config.ts';
import { loadCliProfile } from './profile.ts';
import type { CliCommand } from './types.ts';

/**
 * Шаблоны известных команд мини-фикстуры. `templateOf` синхронный и не получает `stateDir`,
 * поэтому профиль ему недоступен; для целей harness этого словаря достаточно.
 */
const knownTemplates: Record<string, (args: string[]) => string> = {
  add: () => 'add <name> <qty>',
  show: () => 'show <name>',
  list: () => 'list',
};

export function commandTemplate(value: string): string {
  const parts = value.trim().split(/\s+/).filter((part) => part.length > 0);
  const command = parts[0] ?? '';
  const template = knownTemplates[command];
  return template === undefined ? value.trim() : template(parts.slice(1));
}

/** Цель команды по профилю: первое слово обязано совпасть с объявленной командой. */
export function targetOfArgv(commands: readonly CliCommand[], argv: readonly string[]): string | undefined {
  const command = commands.find((entry) => entry.command === argv[0]);
  return command?.template;
}

export const cliInventory: TargetInventory = {
  /** Инвентарь — профиль команд: автообхода справки CLI в учебном пресете нет. */
  list: async (stateDir) => {
    const config = await loadCliConfig(stateDir);
    const profile = await loadCliProfile(stateDir, config.profile);
    return profile.commands.map((command) => command.template);
  },
  templateOf: (value) => commandTemplate(value),
};
