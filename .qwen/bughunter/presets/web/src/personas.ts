import type { Personas } from '@bughunter/core';

/** Ростер персон веб-пресета: механизм очереди «цель × персона» живёт в core, состав — здесь. */
export const EXPLORER_PERSONAS = ['новичок', 'нетерпеливый', 'граничный ввод'] as const;

/**
 * Роль персоны одной фразой. Развёрнутый сценарий поведения — в `.qwen/agents/bh-explorer.md`:
 * агент-исследователь получает его вместе со своим промптом, а не в ответе инструмента.
 */
const personaBriefs: Record<(typeof EXPLORER_PERSONAS)[number], string> = {
  'новичок': 'Последовательно проходит основные сценарии экрана и читает подсказки интерфейса.',
  'нетерпеливый': 'Действует, не дожидаясь результата предыдущего действия: дублирует нажатия кнопки отправки и быстро переключается между экранами.',
  'граничный ввод': 'Подставляет пустые, очень длинные, юникодные, отрицательные, дробные и специальные значения, в том числе в query-параметры маршрута.',
};

export function personaBrief(persona: string): string {
  const brief = personaBriefs[persona as (typeof EXPLORER_PERSONAS)[number]];
  if (brief === undefined) throw new Error(`PERSONA_UNKNOWN: ${persona}`);
  return brief;
}

export const webPersonas: Personas = { roster: EXPLORER_PERSONAS, brief: personaBrief };
