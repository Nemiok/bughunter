import { useState } from 'react';
import type { ReportMeta } from '../mocks/seed.ts';
import { useApi } from '../useApi.ts';

const PAGE_SIZE = 10;

export function ReportsScreen() {
  const { data, status } = useApi<ReportMeta[]>('/api/reports');
  const [page, setPage] = useState(0);
  const reports = data ?? [];
  const pages = Math.max(Math.ceil(reports.length / PAGE_SIZE), 1);

  return (
    <section>
      <h2>Отчёты</h2>
      <p data-testid="reports-status">Статус: {status ?? 'загрузка'}</p>
      <ul data-testid="reports-list">
        {reports.length === 0 && (
          <li data-testid="reports-empty">{status === null ? 'Загрузка…' : 'Нет данных'}</li>
        )}
        {reports.map((report, index) => (
          <li key={report.slug} hidden={Math.floor(index / PAGE_SIZE) !== page}>
            <a href={`/report/${report.slug}`} data-testid={`report-link-${report.slug}`}>
              {report.title}
            </a>
          </li>
        ))}
      </ul>
      <nav data-testid="reports-pager">
        <button type="button" data-testid="reports-pager-prev" onClick={() => setPage((value) => Math.max(0, value - 1))}>
          Назад
        </button>
        <span data-testid="reports-pager-current">{`${page + 1} / ${pages}`}</span>
        <button type="button" data-testid="reports-pager-next" onClick={() => setPage((value) => Math.min(pages - 1, value + 1))}>
          Вперёд
        </button>
      </nav>
    </section>
  );
}
