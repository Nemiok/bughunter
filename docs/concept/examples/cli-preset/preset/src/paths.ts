import { resolve } from 'node:path';

/** Состояние живёт внутри пакета пресета: установка переносима и не смешивается с приложением. */
export const defaultStateDir: string = resolve(import.meta.dirname, '../state');
