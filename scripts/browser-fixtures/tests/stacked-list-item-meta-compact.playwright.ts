/// <reference lib="dom" />
/**
 * `metaCompact` and `phoneWidth="viewport"`, measured in a browser on the `meta-compact` fixture
 * (rows 05w and 05x): on a phone the missed runs' line two is the compact text, led once by the
 * status, with the time and the disclosure on line one; wider, the status leads in its column and
 * line two is the whole sentence; and a row that follows the window keeps its status column while
 * its own width is below 640px. Every box is read in one pass.
 */

import { fixtureRoute } from '@lostgradient/testing/playwright/overlay-fixture';
import { expect, test } from '@playwright/test';

/** What one row of the fixture shows, read in one pass. */
async function readRow(page: import('@playwright/test').Page, testId: string) {
  const row = page.locator(`[data-testid="${testId}"] .cinder-stacked-list-item`);
  await row.waitFor({ state: 'visible' });
  return row.evaluate((element) => {
    const box = (selector: string) => {
      const found = element.querySelector(selector);
      if (!found) return null;
      const { top, bottom, left, right } = found.getBoundingClientRect();
      return { top, bottom, left, right };
    };
    const lineTwo = element.querySelector('.cinder-stacked-list-item__line-two');
    return {
      width: element.getBoundingClientRect().width,
      lineTwoText: (lineTwo?.textContent ?? '').replaceAll(/\s+/g, ' ').trim(),
      statusImages: element.querySelectorAll('[role="img"][aria-label^="Missed runs"]').length,
      column: box('.cinder-stacked-list-item__layout > .cinder-stacked-list-item__status'),
      inline: box('.cinder-stacked-list-item__status-inline'),
      title: box('.cinder-stacked-list-item__title'),
      time: box('.cinder-stacked-list-item__time'),
      disclosure: box('.cinder-stacked-list-item__disclosure'),
      lineTwo: box('.cinder-stacked-list-item__line-two'),
    };
  });
}

test('on a phone the missed runs read "Schedule since Oct 30", led by the status, with the time and Show on line one', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(fixtureRoute('stacked-list-item', { fixtureName: 'meta-compact' }), {
    waitUntil: 'load',
  });
  const read = await readRow(page, 'meta-compact');

  expect(read.lineTwoText).toMatch(/^Missed runs,? 4 Schedule since Oct 30$/);
  expect(read.statusImages).toBe(1);
  expect(read.column).toBeNull();
  expect(read.inline).not.toBeNull();
  // The time and the disclosure share line one with the title, above line two.
  expect(read.time).not.toBeNull();
  expect(read.disclosure).not.toBeNull();
  expect(read.time!.top).toBeLessThan(read.lineTwo!.top);
  expect(read.disclosure!.bottom).toBeLessThanOrEqual(read.lineTwo!.top + 1);
  expect(Math.abs(read.time!.top - read.title!.top)).toBeLessThanOrEqual(4);
});

test('wider, the status leads in its column and line two is the whole sentence', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(fixtureRoute('stacked-list-item', { fixtureName: 'meta-compact' }), {
    waitUntil: 'load',
  });
  const read = await readRow(page, 'meta-compact');

  expect(read.lineTwoText).toContain('missed 4 times since Oct 30');
  expect(read.statusImages).toBe(1);
  expect(read.inline).toBeNull();
  expect(read.column).not.toBeNull();
  expect(read.column!.right).toBeLessThanOrEqual(read.title!.left + 1);
});

test('a row that follows the window keeps its status column on a tablet, below 640px of its own width', async ({
  page,
}) => {
  await page.setViewportSize({ width: 768, height: 800 });
  await page.goto(fixtureRoute('stacked-list-item', { fixtureName: 'meta-compact' }), {
    waitUntil: 'load',
  });
  const read = await readRow(page, 'meta-compact-viewport');

  expect(read.width).toBeLessThan(640);
  expect(read.column).not.toBeNull();
  expect(read.inline).toBeNull();
  expect(read.column!.right).toBeLessThanOrEqual(read.title!.left + 1);
  expect(read.lineTwoText).toBe('Schedule, Assistant, missed 4 times since Oct 30');
});
