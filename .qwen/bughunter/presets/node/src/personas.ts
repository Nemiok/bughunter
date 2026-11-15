import type { Personas } from '@bughunter/core';

/** Ростер персон node-пресета: механизм очереди «цель × персона» живёт в core, состав — здесь. */
export const NODE_PERSONAS = ['интегратор', 'ревизор', 'нетерпеливый'] as const;

/**
 * Роль персоны одной фразой. Развёрнутый сценарий поведения агент-исследователь получает
 * в своём промпте (`presets/node/agents/bh-explorer.md`), а не в ответе инструмента.
 */
const personaBriefs: Record<(typeof NODE_PERSONAS)[number], string> = {
  'интегратор': 'Ходит по контракту API: корректные запросы, обязательные поля, типы, коды ответов.',
  'ревизор': 'Проверяет границы и невалидный ввод: чужие и несуществующие идентификаторы, неверные типы, пустые и отрицательные значения.',
  'нетерпеливый': 'Повторяет и дублирует запросы одним ключом идемпотентности, отправляет их параллельно и обрывает соединения.',
};

export function personaBrief(persona: string): string {
  const brief = personaBriefs[persona as (typeof NODE_PERSONAS)[number]];
  if (brief === undefined) throw new Error(`PERSONA_UNKNOWN: ${persona}`);
  return brief;
}

export const nodePersonas: Personas = { roster: NODE_PERSONAS, brief: personaBrief };
