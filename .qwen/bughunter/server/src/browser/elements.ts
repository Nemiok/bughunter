import { randomUUID } from 'node:crypto';
import type { Locator, Page } from 'playwright-core';
import type { ElementSnapshot, SemanticLocator } from '../types.ts';

export type { ElementSnapshot, SemanticLocator } from '../types.ts';

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

export async function collectElements(page: Page): Promise<ElementSnapshot[]> {
  const rawElements = await page.evaluate((selector): RawElement[] => {
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
        if (['button', 'submit', 'reset', 'image'].includes(element.type)) return 'button';
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

    return Array.from(document.querySelectorAll<HTMLElement>(selector)).flatMap((element, position) => {
      const role = inferredRole(element);
      if (role === null) return [];
      const testid = element.dataset.testid;
      const testIdGroup = testid === undefined ? [] : testIdGroups.get(testid)!;
      return [{
        position,
        role,
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
      }];
    });
  }, interactiveSelector);

  const visible: Array<Omit<ElementSnapshot, 'id' | 'name'> & { fullName: string }> = [];
  const candidates = page.locator(interactiveSelector);
  for (const raw of rawElements) {
    const locator = candidates.nth(raw.position);
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
