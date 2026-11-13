import { delay, http, HttpResponse } from 'msw';
import { duplicateOnSecondPage } from './bugs.ts';
import { dataset, SEED_VERSION, type Dataset } from './seed.ts';
import { RESET_ENDPOINT, type ScenarioName } from './scenarios.ts';

function json(body: object) {
  return HttpResponse.json(body, { headers: { 'x-bh-seed': SEED_VERSION } });
}

/**
 * Обработчики пересобираются на каждый сценарий: worker.use(...) из страницы заменяет набор
 * в service worker'е, поэтому storage-флаг остаётся единственным источником правды о сценарии.
 */
export function buildHandlers(scenario: ScenarioName) {
  const data: Dataset = dataset(scenario);
  const wait = async (): Promise<void> => {
    if (scenario === 'latency') await delay(800);
  };
  let savedReports = 0;

  return [
    http.post(RESET_ENDPOINT, () => new HttpResponse(null, { status: 204 })),

    http.get('/api/meta', () => json({ seedVersion: SEED_VERSION, scenario })),

    http.get('/api/dashboards', async () => {
      await wait();
      return json(data.dashboards);
    }),

    http.get('/api/dashboards/:id', async ({ params }) => {
      await wait();
      const dashboard = data.dashboards.find((item) => String(item.id) === String(params.id));
      if (dashboard === undefined) return new HttpResponse(null, { status: 404 });
      return json(dashboard);
    }),

    http.get('/api/dashboards/:id/widgets/:widget', async ({ params, request }) => {
      await wait();
      if (scenario === 'error500' && params.widget === 'table') {
        return HttpResponse.json(
          { error: 'Widget backend failed' },
          { status: 500, headers: { 'x-bh-seed': SEED_VERSION } },
        );
      }
      const url = new URL(request.url);
      if (params.widget === 'table') {
        const rows = data.widgets.table.rows;
        if (url.searchParams.get('page') === '2') {
          // D5: вторая страница отдаёт строку id 7 повторно.
          return json({ rows: duplicateOnSecondPage(rows), total: data.widgets.table.total, page: 2 });
        }
        const region = url.searchParams.get('region');
        const filtered = region === null ? rows : rows.filter((row) => row.region === region);
        return json({ rows: filtered, total: data.widgets.table.total, page: 1 });
      }
      const widget = data.widgets[params.widget as keyof Dataset['widgets']];
      if (widget === undefined) return new HttpResponse(null, { status: 404 });
      return json(widget);
    }),

    http.get('/api/reports', async () => {
      await wait();
      return json(data.reports);
    }),

    http.get('/api/reports/:slug', async ({ params }) => {
      await wait();
      const report = data.reports.find((item) => item.slug === String(params.slug));
      if (report === undefined) return new HttpResponse(null, { status: 404 });
      return json(report);
    }),

    // Счётчик намеренно не идемпотентен: двойная отправка мастера должна создать две записи.
    http.post('/api/wizard/save', async ({ request }) => {
      await wait();
      savedReports += 1;
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      return HttpResponse.json(
        { id: savedReports, savedAt: new Date().toISOString(), ...body },
        { status: 201 },
      );
    }),
  ];
}
