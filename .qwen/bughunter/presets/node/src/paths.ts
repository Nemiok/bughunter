import { resolve } from 'node:path';

/**
 * Единственный резолвер каталога состояния node-пресета. Core своего пути не знает: `stateDir`
 * всегда приходит аргументом. Состояние живёт внутри пакета пресета, поэтому установка переносима
 * и не смешивается с файлами проверяемого приложения.
 */
export const defaultStateDir: string = resolve(import.meta.dirname, '../state');
