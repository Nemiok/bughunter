import { useEffect, useRef, useState } from 'react';
import { registerWidget } from '../bh-profile.ts';
import { formatNumber } from '../format.ts';
import type { Dataset } from '../mocks/seed.ts';

type TableData = Dataset['widgets']['table'];

const ROW_HEIGHT = 28;
const VISIBLE_ROWS = 8;
/** Проекция ограничена: экстрактор не должен возвращать 5000 строк в сценарии big. */
const MAX_EXTRACTED_ROWS = 200;

export function TableWidget({ data }: { data: TableData }) {
  const [scrollTop, setScrollTop] = useState(0);
  const container = useRef<HTMLDivElement>(null);

  const first = Math.floor(scrollTop / ROW_HEIGHT);

  // Регистрация зависит и от позиции скролла: проекция виртуализированной таблицы обязана
  // показывать текущее видимое окно, иначе скролл контейнера ненаблюдаем снаружи.
  useEffect(() => registerWidget({
    descriptor: { widget: 'table', kind: 'table', node: '[data-testid="widget-table"]' },
    extract: () => ({
      rowCount: data.rows.length,
      total: data.total,
      firstVisibleId: data.rows[first]?.id ?? null,
      rows: data.rows.slice(0, MAX_EXTRACTED_ROWS).map(({ id, region, value }) => ({ id, region, value })),
    }),
  }), [data, first]);

  const slice = data.rows.slice(first, first + VISIBLE_ROWS);

  return (
    <section className="widget" data-testid="widget-table">
      <h2>Продажи по позициям</h2>
      <table>
        <thead>
          <tr><th>id</th><th>Позиция</th><th>Регион</th><th>Значение</th></tr>
        </thead>
      </table>
      <div
        ref={container}
        data-testid="table-scroll"
        tabIndex={0}
        style={{ height: ROW_HEIGHT * VISIBLE_ROWS, overflow: 'auto', position: 'relative' }}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        <div style={{ height: Math.max(data.rows.length, 1) * ROW_HEIGHT, position: 'relative' }}>
          <table style={{ position: 'absolute', top: first * ROW_HEIGHT, width: '100%' }}>
            <tbody>
              {slice.map((row) => (
                <tr key={row.id} data-testid={`table-row-${row.id}`} style={{ height: ROW_HEIGHT }}>
                  <td>{row.id}</td>
                  <td>{row.label}</td>
                  <td>{row.region}</td>
                  <td>{formatNumber(row.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p data-testid="table-total">Итого: {formatNumber(data.total)}</p>
      <p data-testid="table-count">Строк: {data.rows.length}</p>
    </section>
  );
}
