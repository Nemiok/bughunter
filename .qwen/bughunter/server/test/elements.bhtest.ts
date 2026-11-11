import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright-core';
import { collectElements, toPlaywrightLocator } from '../src/browser/elements.ts';

let browser: Browser;
let page: Page;
const longName = `Long ${'accessible name '.repeat(6)}end`;

before(async () => {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage();
  await page.setContent(`
    <button style="display: none">Hidden</button>
    <button>Save</button>
    <button>Save</button>
    <button data-testid="primary-save" aria-label="Accessible Save">Ignored fallback</button>
    <label for="profile-name">Profile name</label>
    <input id="profile-name" value="Alice">
    <label for="blocked">Blocked</label>
    <input id="blocked" value="Cannot edit" disabled>
    <label><input type="checkbox" checked> Accept terms</label>
    <label for="choice">Choice</label>
    <select id="choice"><option selected>Second</option></select>
    <a href="/long">${longName}</a>
  `);
});

after(async () => {
  await browser?.close();
});

test('collectElements returns only visible interactive elements with semantic data', async () => {
  const elements = await collectElements(page);
  assert.equal(elements.length, 8);
  assert.ok(elements.every((element) => element.name !== 'Hidden'));
  assert.ok(elements.every((element) => element.id.length > 0));

  const saves = elements.filter((element) => element.role === 'button' && element.name === 'Save');
  assert.deepEqual(saves.map((element) => element.locator), [
    { kind: 'role', role: 'button', name: 'Save', index: 0 },
    { kind: 'role', role: 'button', name: 'Save', index: 1 },
  ]);

  const testid = elements.find((element) => element.locator.kind === 'testid');
  assert.equal(testid?.name, 'Accessible Save');
  assert.deepEqual(testid?.locator, { kind: 'testid', value: 'primary-save' });

  const input = elements.find((element) => element.name === 'Profile name');
  assert.equal(input?.role, 'textbox');
  assert.equal(input?.type, 'text');
  assert.equal(input?.value, 'Alice');
  assert.equal(input?.disabled, false);
  assert.equal(elements.find((element) => element.name === 'Blocked')?.disabled, true);
  assert.equal(elements.find((element) => element.role === 'checkbox')?.value, 'on');
  assert.equal(elements.find((element) => element.role === 'combobox')?.value, 'Second');

  const long = elements.find((element) => element.role === 'link');
  assert.equal(long?.name.length, 80);
  assert.equal(long?.name, longName.slice(0, 80));
  assert.deepEqual(long?.locator, { kind: 'role', role: 'link', name: longName });
});

test('semantic locator expressions preserve exact names and zero-based indexes', () => {
  assert.equal(
    toPlaywrightLocator({ kind: 'role', role: 'button', name: 'Say "Hello"', index: 1 }),
    'page.getByRole("button", { name: "Say \\"Hello\\"", exact: true }).nth(1)',
  );
  assert.equal(toPlaywrightLocator({ kind: 'testid', value: 'save' }), 'page.getByTestId("save")');
  assert.equal(toPlaywrightLocator({ kind: 'text', value: 'Exact text' }), 'page.getByText("Exact text", { exact: true })');
  assert.equal(toPlaywrightLocator({ kind: 'css', value: '.item', index: 0 }), 'page.locator(".item").nth(0)');
});

test('collectElements applies testid, role, text, and CSS priority to real visible elements', async () => {
  await page.setContent(`
    <div tabindex="0" data-testid="custom-action">Custom testid</div>
    <button>Role action</button>
    <div tabindex="0">Text action</div>
    <div tabindex="0" id="empty-action" style="width: 20px; height: 20px"></div>
    <div>Not interactive</div>
  `);
  const elements = await collectElements(page);
  assert.deepEqual(elements.map((element) => element.locator), [
    { kind: 'testid', value: 'custom-action' },
    { kind: 'role', role: 'button', name: 'Role action' },
    { kind: 'text', value: 'Text action' },
    { kind: 'css', value: '#empty-action' },
  ]);
  assert.deepEqual(elements.map((element) => element.role), ['generic', 'button', 'generic', 'generic']);
  assert.deepEqual(elements.map((element) => toPlaywrightLocator(element.locator)), [
    'page.getByTestId("custom-action")',
    'page.getByRole("button", { name: "Role action", exact: true })',
    'page.getByText("Text action", { exact: true })',
    'page.locator("#empty-action")',
  ]);
});

test('native inputs use their actual ARIA roles and unsupported types are excluded', async () => {
  await page.setContent(`
    <label><input type="radio" name="choice" value="a"> Radio choice</label>
    <label>Range choice<input type="range" value="4"></label>
    <label>Datalist choice<input type="text" list="choices" value="Alpha"></label>
    <label>Search datalist choice<input type="search" list="choices" value="Alpha"></label>
    <datalist id="choices"><option value="Alpha"></option></datalist>
    <label>Unsupported date<input type="date"></label>
  `);
  const elements = await collectElements(page);
  assert.deepEqual(elements.map((element) => ({ role: element.role, name: element.name })), [
    { role: 'radio', name: 'Radio choice' },
    { role: 'slider', name: 'Range choice' },
    { role: 'combobox', name: 'Datalist choice' },
    { role: 'combobox', name: 'Search datalist choice' },
  ]);
  assert.ok(elements.every((element) => element.type !== 'date'));
});

test('duplicate testid indexes include hidden matches before the visible target', async () => {
  await page.setContent(`
    <button data-testid="duplicate-action" style="display: none">Hidden duplicate</button>
    <button data-testid="duplicate-action">Visible target</button>
  `);
  const elements = await collectElements(page);
  assert.equal(elements.length, 1);
  assert.deepEqual(elements[0]?.locator, { kind: 'testid', value: 'duplicate-action', index: 1 });
  assert.equal(toPlaywrightLocator(elements[0]!.locator), 'page.getByTestId("duplicate-action").nth(1)');
  const resolved = page.getByTestId('duplicate-action').nth(1);
  assert.equal(await resolved.isVisible(), true);
  assert.equal(await resolved.textContent(), 'Visible target');
});
