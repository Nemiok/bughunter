import type { Page } from 'playwright-core';
import type { ExtractorKind, Profile } from '../profile/types.ts';

/**
 * Предел размера одного `summary` в символах JSON: структура экрана уходит в контекст модели
 * целиком, поэтому экстрактор, вернувший десять тысяч строк, не должен съедать весь бюджет.
 */
export const maxExtractorSummaryLength = 16_384;

export type ScreenWidget = {
  widget: string;
  kind: ExtractorKind;
  extractor?: string;
  summary?: unknown;
  truncated: boolean;
  error?: string;
};

export type ScreenStructure = { widgets: ScreenWidget[] };

function capSummary(summary: unknown): { summary: unknown; truncated: boolean } {
  const encoded = JSON.stringify(summary) ?? 'null';
  if (encoded.length <= maxExtractorSummaryLength) return { summary, truncated: false };
  if (Array.isArray(summary)) {
    let items: unknown[] = summary;
    while (items.length > 1 && JSON.stringify(items).length > maxExtractorSummaryLength) {
      items = items.slice(0, Math.ceil(items.length / 2));
    }
    const shrunk = JSON.stringify(items) ?? 'null';
    if (shrunk.length <= maxExtractorSummaryLength) return { summary: items, truncated: true };
  }
  return { summary: encoded.slice(0, maxExtractorSummaryLength), truncated: true };
}

/**
 * Структура экрана по экстракторам профиля: то, что приложение само умеет рассказать о своих
 * виджетах (таблицы, графики, сцены). Ошибка экстрактора возвращается явно — молчаливый пропуск
 * выглядел бы как «виджет пуст», а это разные утверждения.
 */
export async function describeScreen(page: Page, profile: Profile | null): Promise<ScreenStructure> {
  const widgets: ScreenWidget[] = [];
  for (const extractor of profile?.extractors ?? []) {
    let summary: unknown;
    try {
      const evaluate = new Function(`return (${extractor.script})();`) as () => unknown;
      summary = await page.evaluate(evaluate);
    } catch {
      widgets.push({
        widget: extractor.widget,
        kind: extractor.kind,
        extractor: extractor.name,
        truncated: false,
        error: `EXTRACTOR_FAILED: ${extractor.name}`,
      });
      continue;
    }
    const capped = capSummary(summary);
    widgets.push({
      widget: extractor.widget,
      kind: extractor.kind,
      extractor: extractor.name,
      summary: capped.summary,
      truncated: capped.truncated,
    });
  }
  return { widgets };
}
