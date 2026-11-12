import { useEffect, useState } from 'react';
import { currentPath, onNavigate } from './router.ts';

const links: Array<{ path: string; label: string }> = [
  { path: '/', label: 'Главная' },
  { path: '/dashboards', label: 'Дашборды' },
  { path: '/reports', label: 'Отчёты' },
  { path: '/wizard', label: 'Мастер' },
  { path: '/settings', label: 'Настройки' },
  { path: '/clean', label: 'Чистый экран' },
];

export function App() {
  const [path, setPath] = useState(currentPath());

  useEffect(() => onNavigate(setPath), []);

  return (
    <>
      <nav>
        {links.map((link) => (
          <a key={link.path} href={link.path} data-testid={`nav-${link.path === '/' ? 'home' : link.path.slice(1).split('/')[0]}`}>
            {link.label}
          </a>
        ))}
      </nav>
      <main>
        <h1>Bughunter BI</h1>
        <p data-testid="route-marker">Маршрут: {path}</p>
      </main>
    </>
  );
}
