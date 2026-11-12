import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.tsx';
import { installProfileHook } from './bh-profile.ts';
import { startMocks } from './mocks/browser.ts';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('root container is missing');

installProfileHook();

// Объявление стрелкой, а не function-декларацией: декларация всплывает выше проверки
// на null, и TypeScript теряет сужение типа для root.
const render = (): void => {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
};

// Приложение не рендерится до запуска моков: ни один fetch не должен уйти мимо хука эталона.
void startMocks()
  .catch((error: unknown) => {
    window.__bhMockError = String(error);
  })
  .then(render);
