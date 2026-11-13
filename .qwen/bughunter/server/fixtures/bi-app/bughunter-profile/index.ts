/**
 * Профиль приложения `bi` для фикстуры bi-app.
 *
 * Модуль самодостаточен: загрузчик профиля копирует его в `<stateDir>/profiles/bi/index.ts`
 * и импортирует оттуда, поэтому импортов из исходников фикстуры здесь быть не должно.
 */

/**
 * Скрипт экстрактора обязан различать «виджет не зарегистрирован на этом экране» и «экстрактор
 * сломался»: обход вызывает все экстракторы профиля на каждом экране, а ядро пишет находку
 * `extract-failed` на каждую ошибку. Без проверки `widgets()` экраны без виджетов дали бы
 * по четыре ложных находки каждый.
 */
function extractor(widget: string): string {
  return `() => {
    const hook = window.__BHProfile;
    if (hook === undefined || hook === null) return null;
    const present = hook.widgets().some((descriptor) => descriptor.widget === '${widget}');
    return present ? hook.extract('${widget}') : null;
  }`;
}

export default {
  name: 'bi',
  extractors: [
    { name: 'bi-table', widget: 'table', kind: 'table', script: extractor('table') },
    { name: 'bi-line', widget: 'line', kind: 'chart', script: extractor('line') },
    { name: 'bi-bars', widget: 'bars', kind: 'chart', script: extractor('bars') },
    { name: 'bi-scene', widget: 'scene', kind: 'scene', script: extractor('scene') },
  ],
  // urlPattern в ядре сопоставляется как подстрока (`CapturedResponse.url.includes(pattern)`),
  // поэтому здесь реальные фрагменты URL, а не шаблоны с `:id`.
  oracles: [
    { urlPattern: '/widgets/table', widget: 'table', fields: ['rows', 'total'] },
    { urlPattern: '/widgets/line', widget: 'line', fields: ['points'] },
    { urlPattern: '/widgets/bars', widget: 'bars', fields: ['bars'] },
    { urlPattern: '/widgets/scene', widget: 'scene', fields: ['objects'] },
  ],
  navigation: { idSegmentPattern: '^\\d+$|^[0-9a-f]{8,}$' },
  reset: { kind: 'storage-flag', key: 'bhScenario' },
  interactions: { resolvePoint: '(point) => window.__BHProfile.resolvePoint(point)' },
  responseSource: 'playwright',
};
