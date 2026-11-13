import type { ReportMeta } from '../mocks/seed.ts';
import { useApi } from '../useApi.ts';

export function ReportScreen({ slug }: { slug: string }) {
  const { data, status } = useApi<ReportMeta>(`/api/reports/${slug}`);

  return (
    <section>
      <h2 data-testid="report-title">{data?.title ?? 'Отчёт загружается'}</h2>
      <p data-testid="report-slug">slug: {slug}</p>
      <p data-testid="report-status">Статус: {status ?? 'загрузка'}</p>
      <a href="/reports" data-testid="report-back">К списку отчётов</a>
    </section>
  );
}
