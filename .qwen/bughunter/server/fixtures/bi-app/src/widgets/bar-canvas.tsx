import { useEffect, useMemo, useRef } from 'react';
import type Konva from 'konva';
import { Layer, Rect, Stage, Text } from 'react-konva';
import { registerWidget } from '../bh-profile.ts';
import type { Dataset } from '../mocks/seed.ts';

type BarsData = Dataset['widgets']['bars'];

const WIDTH = 600;
const HEIGHT = 240;
const PAD = 24;

/**
 * Canvas-виджет: у столбцов нет DOM-узлов, поэтому приложение само публикует их цели
 * (координаты + семантический локатор) через __BHProfile. Без этого координатное действие
 * нечему было бы разрешить в цель, а guard'ы нечего было бы проверить.
 */
export function BarCanvas({ dashboardId, data }: { dashboardId: string; data: BarsData }) {
  const stageRef = useRef<Konva.Stage>(null);

  const geometry = useMemo(() => {
    const max = Math.max(...data.bars.map((bar) => bar.value), 1);
    const step = (WIDTH - PAD * 2) / Math.max(data.bars.length, 1);
    const barWidth = step * 0.66;
    return data.bars.map((bar, index) => {
      const height = Math.max((bar.value / max) * (HEIGHT - PAD * 2), 1);
      return {
        ...bar,
        index,
        x: PAD + index * step + (step - barWidth) / 2,
        y: HEIGHT - PAD - height,
        width: barWidth,
        height,
      };
    });
  }, [data]);

  useEffect(() => registerWidget({
    descriptor: { widget: 'bars', kind: 'chart', node: '[data-testid="widget-bars"]' },
    extract: () => ({ bars: data.bars.map(({ month, value }) => ({ month, value })) }),
    points: () => {
      const box = stageRef.current?.container().getBoundingClientRect();
      if (box === undefined) return [];
      return geometry.map((bar) => ({
        locator: `konva://dashboard/${dashboardId}/bars/${bar.index}`,
        text: bar.month,
        box: { x: box.left + bar.x, y: box.top + bar.y, width: bar.width, height: bar.height },
      }));
    },
    resolvePoint: (point) => {
      const box = stageRef.current?.container().getBoundingClientRect();
      if (box === undefined) return null;
      const local = { x: point.x - box.left, y: point.y - box.top };
      const hit = geometry.find((bar) =>
        local.x >= bar.x && local.x <= bar.x + bar.width && local.y >= bar.y && local.y <= bar.y + bar.height);
      if (hit === undefined) return null;
      return {
        locator: `konva://dashboard/${dashboardId}/bars/${hit.index}`,
        text: hit.month,
        role: 'graphics-symbol',
      };
    },
  }), [dashboardId, data, geometry]);

  return (
    <section className="widget" data-testid="widget-bars">
      <h2>Столбцы по месяцам (canvas)</h2>
      <Stage ref={stageRef} width={WIDTH} height={HEIGHT}>
        <Layer>
          {geometry.map((bar) => (
            <Rect key={bar.index} x={bar.x} y={bar.y} width={bar.width} height={bar.height} fill="#2f6fed" />
          ))}
          {geometry.map((bar) => (
            <Text
              key={`label-${bar.index}`}
              x={bar.x - 4}
              y={HEIGHT - PAD + 6}
              width={bar.width + 8}
              text={bar.month.slice(0, 3)}
              fontSize={10}
              align="center"
            />
          ))}
        </Layer>
      </Stage>
    </section>
  );
}
