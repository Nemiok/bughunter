import { resolve } from 'node:path';

/**
 * Единственный резолвер каталога состояния веб-пресета. Core своего пути не знает:
 * `stateDir` всегда приходит аргументом. До переноса шесть модулей вычисляли путь сами,
 * причем `reproduce.ts` и `sweep.ts` указывали на несуществующий `server/state`.
 */
export const defaultStateDir = resolve(import.meta.dirname, '../state');
