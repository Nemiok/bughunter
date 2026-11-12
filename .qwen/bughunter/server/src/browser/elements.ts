import { randomUUID } from 'node:crypto';
import type { Locator, Page } from 'playwright-core';
import type { ElementBox, ElementSnapshot, SemanticLocator } from '../types.ts';

export type { ElementBox, ElementSnapshot, SemanticLocator } from '../types.ts';

const interactiveSelector = [
  'button',
  'a[href]',
  'input:not([type="hidden"])',
  'textarea',
  'select',
  '[role="button"]',
  '[role="link"]',
  '[role="textbox"]',
  '[role="checkbox"]',
  '[role="combobox"]',
  '[role="radio"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="searchbox"]',
  '[role="switch"]',
  '[tabindex]',
  '[onclick]',
  '[contenteditable="true"]',
].join(',');

type RawElement = {
  position: number;
  role: string;
  type: string;
  testid?: string;
  testidIndex?: number;
  testidCount?: number;
  fallbackName: string;
  text: string;
  css: string;
  semanticRole: boolean;
  formControl: boolean;
  box: ElementBox;
};

function locatorKey(locator: SemanticLocator): string {
  return JSON.stringify(locator);
}

async function accessibleName(locator: Locator, fallback: string): Promise<string> {
  const snapshot = await locator.ariaSnapshot();
  const firstLine = snapshot.split('\n')[0] ?? '';
  const quoted = firstLine.match(/"(?:[^"\\]|\\.)*/)?.[0];
  if (!quoted) return fallback.trim();
  try {
    return JSON.parse(quoted) as string;
  } catch {
    return fallback.trim();
  }
}

/**
 * Один `evaluate` на оба сценария — снимок всех интерактивных элементов и поиск цели по точке.
 * Инпейдж-хелперы (роль, имя, css-путь) существуют в одном экземпляре: разделись они на две копии,
 * координатное действие и снимок начали бы расходиться в определении одного и того же элемента.
 * `position` — индекс в списке `interactiveSelector`, для точки вне этого списка он равен -1.
 */
async function collectRaw(page: Page, point?: { x: number; y: number }): Promise<RawElement[]> {
  return page.evaluate(({ selector, point }): RawElement[] => {
    function inferredRole(element: Element): string | null {
      const explicit = element.getAttribute('role');
      if (explicit) return explicit;
      if (element instanceof HTMLAnchorElement) return 'link';
      if (element instanceof HTMLButtonElement) return 'button';
      if (element instanceof HTMLSelectElement) return 'combobox';
      if (element instanceof HTMLTextAreaElement) return 'textbox';
      if (element instanceof HTMLInputElement) {
        if (element.type === 'checkbox') return 'checkbox';
        if (element.type === 'radio') return 'radio';
        if (element.type === 'range') return 'slider';
        if (element.type === 'number') return 'spinbutton';
        if (['text', 'search', 'email', 'tel', 'url'].includes(element.type) && element.hasAttribute('list')) return 'combobox';
        if (element.type === 'search') return 'searchbox';
        // HTML-AAM: input[type=file] отображается в роль button.
        if (['button', 'submit', 'reset', 'image', 'file'].includes(element.type)) return 'button';
        if (['text', 'email', 'tel', 'url', 'password'].includes(element.type)) return 'textbox';
        return null;
      }
      return 'generic';
    }

    function inferredName(element: HTMLElement): string {
      const ariaLabel = element.getAttribute('aria-label');
      if (ariaLabel) return ariaLabel;
      const labelledBy = element.getAttribute('aria-labelledby');
      if (labelledBy) {
        return labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
      }
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
        const labels = Array.from(element.labels ?? []).map((label) => label.textContent ?? '').join(' ');
        if (labels) return labels;
      }
      return element.textContent ?? element.getAttribute('placeholder') ?? element.getAttribute('title') ?? '';
    }

    function cssSelector(element: HTMLElement): string {
      if (element.id) return `#${CSS.escape(element.id)}`;
      const parts: string[] = [];
      let current: HTMLElement | null = element;
      while (current && current.tagName !== 'BODY') {
        const tag = current.tagName.toLowerCase();
        const siblings = current.parentElement
          ? Array.from(current.parentElement.children).filter((sibling) => sibling.tagName === current!.tagName)
          : [];
        parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(current) + 1})` : tag);
        current = current.parentElement;
      }
      return ['body', ...parts].join(' > ');
    }

    const testIdGroups = new Map<string, HTMLElement[]>();
    for (const element of document.querySelectorAll<HTMLElement>('[data-testid]')) {
      const testid = element.dataset.testid!;
      const group = testIdGroups.get(testid) ?? [];
      group.push(element);
      testIdGroups.set(testid, group);
    }

    function describe(element: HTMLElement, position: number, role: string): RawElement {
      const testid = element.dataset.testid;
      const testIdGroup = testid === undefined ? [] : testIdGroups.get(testid)!;
      const rect = element.getBoundingClientRect();
      return {
        position,
        role,
        box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        type: element instanceof HTMLInputElement ? element.type : element.tagName.toLowerCase(),
        ...(testid === undefined ? {} : {
          testid,
          testidIndex: testIdGroup.indexOf(element),
          testidCount: testIdGroup.length,
        }),
        fallbackName: inferredName(element),
        text: (element.textContent ?? '').replace(/\s+/g, ' ').trim(),
        css: cssSelector(element),
        semanticRole: role !== 'generic',
        formControl: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement,
      };
    }

    if (point !== undefined) {
      const hit = document.elementFromPoint(point.x, point.y);
      if (!(hit instanceof HTMLElement)) return [];
      return [describe(hit, Array.from(document.querySelectorAll(selector)).indexOf(hit), inferredRole(hit) ?? 'generic')];
    }

    return Array.from(document.querySelectorAll<HTMLElement>(selector)).flatMap((element, position) => {
      const role = inferredRole(element);
      if (role === null) return [];
      return [describe(element, position, role)];
    });
  }, { selector: interactiveSelector, point });
}

async function toSnapshots(page: Page, entries: Array<{ raw: RawElement; locator: Locator }>): Promise<ElementSnapshot[]> {
  const visible: Array<Omit<ElementSnapshot, 'id' | 'name'> & { fullName: string }> = [];
  for (const { raw, locator } of entries) {
    if (!await locator.isVisible()) continue;
    const fullName = await accessibleName(locator, raw.fallbackName);
    let semanticLocator: SemanticLocator;
    if (raw.testid !== undefined) {
      semanticLocator = {
        kind: 'testid',
        value: raw.testid,
        ...((raw.testidCount ?? 0) > 1 ? { index: raw.testidIndex! } : {}),
      };
    } else if (raw.semanticRole) {
      semanticLocator = { kind: 'role', role: raw.role, name: fullName };
    } else if (raw.text) {
      semanticLocator = { kind: 'text', value: raw.text };
    } else {
      semanticLocator = { kind: 'css', value: raw.css };
    }
    visible.push({
      role: raw.role,
      type: raw.type,
      fullName,
      locator: semanticLocator,
      box: raw.box,
      ...(raw.formControl ? { value: await locator.inputValue() } : {}),
      disabled: await locator.isDisabled(),
    });
  }

  const counts = new Map<string, number>();
  for (const element of visible) {
    const key = locatorKey(element.locator);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const indexes = new Map<string, number>();
  return visible.map(({ fullName, ...element }) => {
    const key = locatorKey(element.locator);
    const index = indexes.get(key) ?? 0;
    indexes.set(key, index + 1);
    return {
      ...element,
      id: randomUUID(),
      name: fullName.slice(0, 80),
      locator: (counts.get(key) ?? 0) > 1 ? { ...element.locator, index } : element.locator,
    };
  });
}

export async function collectElements(page: Page): Promise<ElementSnapshot[]> {
  const rawElements = await collectRaw(page);
  const candidates = page.locator(interactiveSelector);
  return toSnapshots(page, rawElements.map((raw) => ({ raw, locator: candidates.nth(raw.position) })));
}

/** Элемент под точкой viewport: цель координатного действия, в том числе canvas без DOM-семантики. */
export async function elementAtPoint(page: Page, at: { x: number; y: number }): Promise<ElementSnapshot | null> {
  const [raw] = await collectRaw(page, at);
  if (raw === undefined) return null;
  const locator = raw.position >= 0
    ? page.locator(interactiveSelector).nth(raw.position)
    : page.locator(raw.css);
  const [snapshot] = await toSnapshots(page, [{ raw, locator }]);
  if (snapshot === undefined) return null;
  // Точка может попасть в контейнер вроде body: его текст не бывает точным локатором,
  // поэтому длинный текст заменяется css-путём до того же элемента.
  if (snapshot.locator.kind === 'text' && snapshot.locator.value.length > 80) {
    return { ...snapshot, locator: { kind: 'css', value: raw.css } };
  }
  return snapshot;
}

export type Viewport = { width: number; height: number };

export type SnapshotPage = {
  elements: ElementSnapshot[];
  nextCursor?: number;
  totalVisible: number;
  truncated: boolean;
};

/** Роли, которыми модель управляет приложением, важнее декоративных контейнеров. */
const roleWeights: Record<string, number> = {
  button: 0,
  link: 1,
  textbox: 2,
  searchbox: 2,
  combobox: 3,
  checkbox: 4,
  radio: 4,
  switch: 4,
  slider: 5,
  spinbutton: 5,
};

const semanticRoleWeight = 6;
const decorativeRoleWeight = 9;

function roleWeight(role: string): number {
  if (role in roleWeights) return roleWeights[role]!;
  return role === 'generic' ? decorativeRoleWeight : semanticRoleWeight;
}

function intersectsViewport(box: ElementBox, viewport: Viewport): boolean {
  return box.width > 0 && box.height > 0
    && box.x < viewport.width && box.y < viewport.height
    && box.x + box.width > 0 && box.y + box.height > 0;
}

/**
 * Порядок: пересечение с viewport → роль → позиция сверху вниз и слева направо.
 * Сортировка устойчива, поэтому равные элементы сохраняют порядок DOM-выборки,
 * а результат не зависит от того, в каком порядке страница отдала узлы.
 */
export function rankElements(elements: ElementSnapshot[], viewport: Viewport): ElementSnapshot[] {
  return [...elements].sort((left, right) => {
    const reach = Number(!intersectsViewport(left.box, viewport)) - Number(!intersectsViewport(right.box, viewport));
    if (reach !== 0) return reach;
    const weight = roleWeight(left.role) - roleWeight(right.role);
    if (weight !== 0) return weight;
    if (left.box.y !== right.box.y) return left.box.y - right.box.y;
    return left.box.x - right.box.x;
  });
}

export function paginateElements(elements: ElementSnapshot[], limit: number, cursor = 0): SnapshotPage {
  const start = Math.max(0, cursor);
  const slice = elements.slice(start, start + limit);
  const next = start + slice.length;
  return {
    elements: slice,
    totalVisible: elements.length,
    truncated: next < elements.length,
    ...(next < elements.length ? { nextCursor: next } : {}),
  };
}

export function toPlaywrightLocator(locator: SemanticLocator): string {
  let expression: string;
  switch (locator.kind) {
    case 'testid':
      expression = `page.getByTestId(${JSON.stringify(locator.value)})`;
      break;
    case 'role':
      expression = `page.getByRole(${JSON.stringify(locator.role)}, { name: ${JSON.stringify(locator.name)}, exact: true })`;
      break;
    case 'text':
      expression = `page.getByText(${JSON.stringify(locator.value)}, { exact: true })`;
      break;
    case 'css':
      expression = `page.locator(${JSON.stringify(locator.value)})`;
      break;
  }
  return locator.index === undefined ? expression : `${expression}.nth(${locator.index})`;
}
