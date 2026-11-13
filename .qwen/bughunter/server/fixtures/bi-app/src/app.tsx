import { useEffect, useState } from 'react';
import { currentPath, onNavigate } from './router.ts';
import { CleanScreen } from './screens/clean.tsx';
import { DashboardScreen } from './screens/dashboard.tsx';
import { DashboardsScreen } from './screens/dashboards.tsx';
import { ReportScreen } from './screens/report.tsx';
import { ReportsScreen } from './screens/reports.tsx';
import { SettingsScreen } from './screens/settings.tsx';
import { WizardScreen } from './screens/wizard.tsx';
import type { Meta } from './meta.ts';

const links: Array<{ path: string; label: string }> = [
  { path: '/', label: 'Главная' },
  { path: '/dashboards', label: 'Дашборды' },
  { path: '/reports', label: 'Отчёты' },
  { path: '/wizard', label: 'Мастер' },
  { path: '/settings', label: 'Настройки' },
  { path: '/clean', label: 'Чистый экран' },
];

function Screen({ path }: { path: string }) {
  if (path === '/dashboards') return <DashboardsScreen />;
  if (path.startsWith('/dashboard/')) return <DashboardScreen id={path.slice('/dashboard/'.length)} />;
  if (path === '/reports') return <ReportsScreen />;
  if (path.startsWith('/report/')) return <ReportScreen slug={path.slice('/report/'.length)} />;
  if (path === '/wizard') return <WizardScreen />;
  if (path === '/settings') return <SettingsScreen />;
  if (path === '/clean') return <CleanScreen />;
  if (path === '/') {
    return (
      <section>
        <p data-testid="home-panel">
          Учебная BI-платформа для приёмки Bughunter: {links.length - 1} разделов, четыре технологии
          рендеринга на одном дашборде и сценарии данных MSW.
        </p>
      </section>
    );
  }
  return <p data-testid="unknown-route">Неизвестный экран: {path}</p>;
}

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
        {/* Внешняя ссылка обязательна: обход инвентаря должен записать её как blocked, а не выполнить. */}
        <a href="https://docs.example.invalid/bi" data-testid="nav-docs" rel="noreferrer">Документация</a>
      </nav>
      <main>
        <h1>Bughunter BI</h1>
        <p data-testid="seed-info">
          Данные: {meta === null ? 'загрузка' : `${meta.seedVersion} · сценарий ${meta.scenario}`}
        </p>
        <p data-testid="route-marker">Маршрут: {path}</p>
        <Screen path={path} />
      </main>
    </>
  );
}
