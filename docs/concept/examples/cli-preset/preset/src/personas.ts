import type { Personas } from '@bughunter/core';

/** Ростер персон CLI-пресета: механизм очереди «цель × персона» живёт в core, состав — здесь. */
export const CLI_PERSONAS = ['бухгалтер', 'ревизор', 'нетерпеливый'] as const;

/**
 * Роль персоны одной фразой. Развёрнутый сценарий поведения агент-исследователь получает
 * в своём промпте (`presets/cli/agents/bh-explorer.md`), а не в ответе инструмента.
 */
const personaBriefs: Record<(typeof CLI_PERSONAS)[number], string> = {
  'бухгалтер': 'Работает по объявленным сценариям: добавляет заказы, показывает их, смотрит список и сверяет stdout с контрактом.',
  'ревизор': 'Проверяет границы и невалидный ввод: пропущенные аргументы, нечисловое и отрицательное количество, несуществующие имена и лишние аргументы.',
  'нетерпеливый': 'Повторяет одну команду дважды, смешивает подготовку и чтение, вводит пробелы и специальные символы в имя заказа.',
};

export function personaBrief(persona: string): string {
  const brief = personaBriefs[persona as (typeof CLI_PERSONAS)[number]];
  if (brief === undefined) throw new Error(`PERSONA_UNKNOWN: ${persona}`);
  return brief;
}

export const cliPersonas: Personas = { roster: CLI_PERSONAS, brief: personaBrief };
