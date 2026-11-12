import { useState } from 'react';
import type { Dashboard } from '../mocks/seed.ts';
import { useApi } from '../useApi.ts';
import { formatDate } from '../format.ts';

const PAGE_SIZE = 10;

/**
 * Список дашбордов с клиентской пагинацией. Все ссылки остаются в DOM (невидимые строки
 * скрыты атрибутом hidden), поэтому обход находит все 120 экранов, а снимок страницы —
 * только видимые: так же устроены реальные списки с подгрузкой.
 */
export function DashboardsScreen() {
  const { data, status } = useApi<Dashboard[]>('/api/dashboards');
  const [page, setPage] = useState(0);
  const dashboards = data ?? [];
  const pages = Math.max(Math.ceil(dashboards.length / PAGE_SIZE), 1);

  return (
    <section>
      <h2>Дашборды</h2>
      <p data-testid="dashboards-status">Статус: {status ?? 'загрузка'}</p>
      <ul data-testid="dashboards-list">
        {dashboards.length === 0 && (
          <li data-testid="dashboards-empty">{status === null ? 'Загрузка…' : 'Нет данных'}</li>
        )}
        {dashboards.map((dashboard, index) => (
          <li key={dashboard.id} hidden={Math.floor(index / PAGE_SIZE) !== page}>
            <a href={`/dashboard/${dashboard.id}`} data-testid={`dashboard-link-${dashboard.id}`}>
              {dashboard.title}
            </a>
            <span> · {dashboard.owner} · {formatDate(dashboard.updatedAt)}</span>
          </li>
        ))}
      </ul>
      <nav data-testid="dashboards-pager">
        <button type="button" data-testid="pager-prev" onClick={() => setPage((value) => Math.max(0, value - 1))}>
          Назад
        </button>
        <span data-testid="pager-current">{`${page + 1} / ${pages}`}</span>
        <button type="button" data-testid="pager-next" onClick={() => setPage((value) => Math.min(pages - 1, value + 1))}>
          Вперёд
        </button>
      </nav>
    </section>
  );
}
