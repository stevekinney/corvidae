/// <reference lib="dom" />
/**
 * CopyableValue's address breaks where its place is narrow, and its copy control stays on the
 * address's last line instead of landing alone on a row below it (COR-2171).
 */

import { expect, test } from '@playwright/test';
import { fixtureRoute, setFixtureWidth } from './layout-fixture.ts';

test('the address breaks across lines and the control sits on the last of them', async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { width: 375, height: 700 } });
  try {
    const page = await context.newPage();
    await page.goto(fixtureRoute('copyable-value'), { waitUntil: 'load' });
    const address = page.getByTestId('address');
    await expect(address.getByRole('button', { name: 'Copy the address' })).toBeVisible();

    const geometry = await address.evaluate((root) => {
      const control = root.querySelector('button');
      if (control === null) throw new Error('the copy control is missing');
      // The address as drawn: the text before the last character, and the last character.
      const range = document.createRange();
      const head = root.querySelector('.cinder-copyable-value__part');
      const last = root.querySelector('.cinder-copyable-value__end')?.firstChild;
      if (head === null || last === null || last === undefined) {
        throw new Error('the address text is missing');
      }
      range.setStartBefore(head);
      range.setEnd(last, last.textContent?.length ?? 0);
      const lines = [...range.getClientRects()].filter((rect) => rect.width > 0);
      const lastLine = lines.reduce((lowest, rect) =>
        rect.bottom > lowest.bottom ? rect : lowest,
      );
      const box = control.getBoundingClientRect();
      return {
        lineCount: new Set(lines.map((rect) => Math.round(rect.top))).size,
        lastLineTop: lastLine.top,
        lastLineBottom: lastLine.bottom,
        controlTop: box.top,
        controlBottom: box.bottom,
      };
    });

    // The place is narrow enough that the address breaks.
    expect(geometry.lineCount).toBeGreaterThan(1);
    // The control overlaps the last line of the address, so it is not alone on a row below it.
    expect(geometry.controlTop).toBeLessThan(geometry.lastLineBottom);
    expect(geometry.controlBottom).toBeGreaterThan(geometry.lastLineTop);
  } finally {
    await context.close();
  }
});

test('separator hints wrap an address as a unit and keep the button on its last line', async ({
  page,
}) => {
  await page.goto(`${fixtureRoute('copyable-value')}&hints=1`, { waitUntil: 'load' });
  await setFixtureWidth(page.getByTestId('hinted-address-wrapper'), '200px');
  const value = page.getByTestId('hinted-address');
  const control = value.locator('.cinder-copyable-value__control');
  await expect(value).toHaveCSS('user-select', 'all');
  await expect(control).toHaveCSS('user-select', 'none');
  await expect(page.getByTestId('address')).toHaveCSS('user-select', 'auto');

  const { lines, buttonTop, lineHeight } = await value.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.parentElement?.closest('.cinder-copyable-value__control')
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    });
    const range = document.createRange();
    const lines: Array<{ text: string; top: number; bottom: number }> = [];
    let previous: DOMRect | undefined;
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = node.textContent ?? '';
      for (let index = 0; index < text.length; index++) {
        range.setStart(node, index);
        range.setEnd(node, index + 1);
        const rect = range.getBoundingClientRect();
        if (previous === undefined || rect.top - previous.top > previous.height / 2) {
          lines.push({ text: '', top: rect.top, bottom: rect.bottom });
        }
        const line = lines.at(-1)!;
        line.text += text[index];
        line.bottom = Math.max(line.bottom, rect.bottom);
        previous = rect;
      }
    }
    return {
      lines,
      buttonTop: element.querySelector('button')!.getBoundingClientRect().top,
      lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
    };
  });
  expect(lines.length).toBeGreaterThanOrEqual(2);
  for (const line of lines.slice(0, -1)) expect(line.text).toMatch(/[.\-@:/]$/);
  const last = lines.at(-1)!;
  // Range bounds describe the text; the line also includes the CSS leading around it.
  const halfLeading = Math.max(0, lineHeight - (last.bottom - last.top)) / 2;
  expect(buttonTop).toBeGreaterThanOrEqual(last.top - halfLeading);
  expect(buttonTop).toBeLessThan(last.bottom + halfLeading);
});
