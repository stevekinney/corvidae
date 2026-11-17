/// <reference lib="dom" />
/**
 * CopyableValue's address breaks where its place is narrow, and its copy control stays on the
 * address's last line instead of landing alone on a row below it (COR-2171).
 */

import { expect, test } from '@playwright/test';
import { fixtureRoute } from './layout-fixture.ts';

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
      const head = root.firstChild;
      const last = root.querySelector('.cinder-copyable-value__end')?.firstChild;
      if (head === null || head === undefined || last === null || last === undefined) {
        throw new Error('the address text is missing');
      }
      range.setStart(head, 0);
      range.setEnd(last, last.textContent?.length ?? 0);
      const lines = [...range.getClientRects()].filter((rect) => rect.width > 0);
      const lastLine = lines.reduce((lowest, rect) => (rect.bottom > lowest.bottom ? rect : lowest));
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
