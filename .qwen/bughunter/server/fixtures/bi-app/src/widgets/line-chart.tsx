import { useEffect } from 'react';
import { registerWidget } from '../bh-profile.ts';
import type { Dataset } from '../mocks/seed.ts';

type LineData = Dataset['widgets']['line'];

const WIDTH = 600;
const HEIGHT = 200;
const PAD = 24;

export function LineChart({ data }: { data: LineData }) {
  useEffect(() => registerWidget({
    descriptor: { widget: 'line', kind: 'chart', node: '[data-testid="widget-line"]' },
    extract: () => ({ points: data.points.map(({ month, revenue }) => ({ month, revenue })) }),
  }), [data]);

  const max = Math.max(...data.points.map((point) => point.revenue), 1);
  const stepX = (WIDTH - PAD * 2) / Math.max(data.points.length - 1, 1);
  const coordinates = data.points.map((point, index) => [
    PAD + index * stepX,
    HEIGHT - PAD - (point.revenue / max) * (HEIGHT - PAD * 2),
  ] as const);

  return (
    <section className="widget" data-testid="widget-line">
      <h2>Выручка по месяцам</h2>
      <svg width={WIDTH} height={HEIGHT} data-testid="line-svg" role="img" aria-label="Выручка по месяцам">
        <polyline
          fill="none"
          stroke="#2f6fed"
          strokeWidth={2}
          points={coordinates.map(([x, y]) => `${x},${y}`).join(' ')}
        />
        {coordinates.map(([x, y], index) => (
          <circle key={data.points[index]!.month} cx={x} cy={y} r={3} fill="#2f6fed" data-testid={`line-point-${index}`}>
            <title>{`${data.points[index]!.month}: ${data.points[index]!.revenue}`}</title>
          </circle>
        ))}
      </svg>
    </section>
  );
}
