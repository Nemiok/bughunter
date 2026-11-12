import { useState } from 'react';
import { formatAbbreviated } from '../format.ts';
import type { Dashboard, Dataset } from '../mocks/seed.ts';
import { useApi } from '../useApi.ts';
import { BarCanvas } from '../widgets/bar-canvas.tsx';
import { LineChart } from '../widgets/line-chart.tsx';
import { Scene3d } from '../widgets/scene3d.tsx';
import { TableWidget } from '../widgets/table-widget.tsx';

const REGIONS = ['all', 'ural', 'siberia', 'northwest', 'south'];
const emptyTable: Dataset['widgets']['table'] = { rows: [], total: 0 };

export function DashboardScreen({ id }: { id: string }) {
  const [region, setRegion] = useState('all');
  const { data: dashboard } = useApi<Dashboard>(`/api/dashboards/${id}`);
  const query = region === 'all' ? '' : `?region=${region}`;
  const table = useApi<Dataset['widgets']['table']>(`/api/dashboards/${id}/widgets/table${query}`);
  const line = useApi<Dataset['widgets']['line']>(`/api/dashboards/${id}/widgets/line`);
  const bars = useApi<Dataset['widgets']['bars']>(`/api/dashboards/${id}/widgets/bars`);
  const scene = useApi<Dataset['widgets']['scene']>(`/api/dashboards/${id}/widgets/scene`);

  // Готовность определяется завершением всех четырёх запросов, а не успехом:
  // экран со сценарием error500 тоже должен доходить до измеримого состояния.
  const ready = [table, line, bars, scene].every((widget) => widget.status !== null);

  return (
    <section>
      <h2 data-testid="dashboard-title">{dashboard?.title ?? `Дашборд ${id}`}</h2>

      <label htmlFor="filter-region">Регион</label>
      <select
        id="filter-region"
        data-testid="filter-region"
        value={region}
        onChange={(event) => setRegion(event.target.value)}
      >
        {REGIONS.map((value) => (
          <option key={value} value={value}>{value === 'all' ? 'Все регионы' : value}</option>
        ))}
      </select>

      <p data-testid="dashboard-kpi">Суммарно: {formatAbbreviated(table.data?.total ?? 0)}</p>
      {table.status === 500 && <p data-testid="table-error">Виджет таблицы недоступен (HTTP 500)</p>}
      {ready && <p data-testid="dashboard-ready">данные загружены</p>}

      <TableWidget data={table.data ?? emptyTable} />
      <LineChart data={line.data ?? { points: [] }} />
      <BarCanvas dashboardId={id} data={bars.data ?? { bars: [] }} />
      <Scene3d data={scene.data ?? { objects: [] }} />
    </section>
  );
}
