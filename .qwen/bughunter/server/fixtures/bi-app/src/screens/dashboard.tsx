import { useEffect, useMemo, useRef, useState } from 'react';
import { formatAbbreviated, formatNumber, formatShare } from '../format.ts';
import { KPI_AVG_CHECK, SHARE, formatDateWrongZone, truncateToCents } from '../mocks/bugs.ts';
import type { Dashboard, Dataset, TableRow } from '../mocks/seed.ts';
import { useApi } from '../useApi.ts';
import { BarCanvas } from '../widgets/bar-canvas.tsx';
import { LineChart } from '../widgets/line-chart.tsx';
import { Scene3d } from '../widgets/scene3d.tsx';
import { TableWidget } from '../widgets/table-widget.tsx';

const REGIONS = ['all', 'ural', 'siberia', 'northwest', 'south'];
const emptyTable: Dataset['widgets']['table'] = { rows: [], total: 0 };

type LineData = Dataset['widgets']['line'];

/**
 * D4 и N2 в одной обвязке: запрос линейного графика намеренно не включает регион,
 * а ответ применяется без отмены устаревшего запроса. При быстрой смене фильтра
 * более ранний ответ перекрывает актуальный, и приложение сообщает об этом в console.error.
 */
function useRacyLine(path: string, region: string): { data: LineData | null; status: number | null } {
  const [state, setState] = useState<{ data: LineData | null; status: number | null }>({ data: null, status: null });
  const latest = useRef(region);

  useEffect(() => {
    latest.current = region;
    void fetch(path)
      .then(async (response) => {
        const body = response.ok ? await response.json() as LineData : null;
        if (latest.current !== region) {
          console.error(`RACE: применён ответ устаревшего фильтра «${region}», актуальный — «${latest.current}»`);
        }
        setState({ data: body, status: response.status });
      })
      .catch(() => undefined);
  }, [path, region]);

  return state;
}

export function DashboardScreen({ id }: { id: string }) {
  const [region, setRegion] = useState('all');
  const [extraRows, setExtraRows] = useState<TableRow[]>([]);
  const { data: dashboard } = useApi<Dashboard>(`/api/dashboards/${id}`);
  const query = region === 'all' ? '' : `?region=${region}`;
  const table = useApi<Dataset['widgets']['table']>(`/api/dashboards/${id}/widgets/table${query}`);
  const line = useRacyLine(`/api/dashboards/${id}/widgets/line`, region);
  const bars = useApi<Dataset['widgets']['bars']>(`/api/dashboards/${id}/widgets/bars`);
  const scene = useApi<Dataset['widgets']['scene']>(`/api/dashboards/${id}/widgets/scene`);

  // Готовность определяется завершением всех четырёх запросов, а не успехом:
  // экран со сценарием error500 тоже должен доходить до измеримого состояния.
  const ready = [table, line, bars, scene].every((widget) => widget.status !== null);

  useEffect(() => {
    setExtraRows([]);
  }, [region]);

  const tableData = useMemo<Dataset['widgets']['table']>(() => ({
    rows: [...(table.data?.rows ?? []), ...extraRows],
    total: table.data?.total ?? 0,
  }), [extraRows, table.data]);

  async function loadMore(): Promise<void> {
    const response = await fetch(`/api/dashboards/${id}/widgets/table?page=2`);
    const body = await response.json() as { rows: TableRow[] };
    setExtraRows((previous) => [...previous, ...body.rows]);
  }

  return (
    <section>
      <h2 data-testid="dashboard-title">{dashboard?.title ?? `Дашборд ${id}`}</h2>
      <p data-testid="dashboard-updated">
        Обновлён: {dashboard === null ? '—' : formatDateWrongZone(dashboard.updatedAt)}
      </p>

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

      <p data-testid="dashboard-kpi">Суммарно: {formatAbbreviated(tableData.total)}</p>
      <p data-testid="kpi-avg">Средний чек: {formatNumber(truncateToCents(KPI_AVG_CHECK))}</p>
      <p data-testid="kpi-share">Доля региона: {formatShare(SHARE.part, SHARE.usedBase)}</p>
      {table.status === 500 && <p data-testid="table-error">Виджет таблицы недоступен (HTTP 500)</p>}
      {ready && <p data-testid="dashboard-ready">данные загружены</p>}

      <TableWidget data={tableData} />
      <button type="button" data-testid="table-more" onClick={() => void loadMore()}>
        Показать ещё
      </button>
      <LineChart data={line.data ?? { points: [] }} />
      <BarCanvas dashboardId={id} data={bars.data ?? { bars: [] }} />
      <Scene3d data={scene.data ?? { objects: [] }} />
    </section>
  );
}
