import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// API отдаёт MSW из service worker, поэтому vite-плагин с фейковым бэкендом здесь не нужен
// (в отличие от fixtures/buggy-app, где ответы генерирует middleware дев-сервера).
export default defineConfig({
  plugins: [react()],
});
