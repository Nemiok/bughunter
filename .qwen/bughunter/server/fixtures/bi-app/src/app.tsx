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

type Meta = { seedVersion: string; scenario: string };

export function App() {
  const [path, setPath] = useState(currentPath());
  const [meta, setMeta] = useState<Meta | null>(null);

  useEffect(() => onNavigate(setPath), []);

  // Версия seed-датасета видна на экране: по отчёту прогона должно быть понятно,
  // на каких данных он получен.
  useEffect(() => {
    let cancelled = false;
    void fetch('/api/meta')
      .then(async (response) => (await response.json()) as Meta)
      .then((value) => {
        if (!cancelled) setMeta(value);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [path]);

  return (
    <>
      <nav>
        {links.map((link) => (
          <a
            key={link.path}
            href={link.path}
            data-testid={`nav-${link.path === '/' ? 'home' : link.path.slice(1).split('/')[0]}`}
          >
            {link.label}
          </a>
        ))}
      </nav>
      <main>
        <h1>Bughunter BI</h1>
        <p data-testid="seed-info">
          Данные: {meta === null ? 'загрузка' : `${meta.seedVersion} · сценарий ${meta.scenario}`}
        </p>
        <p data-testid="route-marker">Маршрут: {path}</p>
      </main>
    </>
  );
}
