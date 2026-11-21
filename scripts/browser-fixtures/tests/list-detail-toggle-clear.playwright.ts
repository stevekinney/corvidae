/// <reference lib="dom" />
/**
 * ListDetail's list toggle is a handle on the divider, inside the list pane, never in the list
 * header beside its title (COR-2438, criterion 20): the header's first row starts on the header's
 * own edge whatever that row holds. On the `list-collapsible` fixture the first row is a plain
 * `<h2>`, not a SectionHeading, so the toggle's box and the title's text box must not meet, the
 * title's words start on the header's content edge, and the toggle sits inside the list pane at its
 * divider. Read in a browser; the spec takes no screenshots.
 */

import { fixtureRoute } from '@lostgradient/testing/playwright/overlay-fixture';
import { expect, test } from '@playwright/test';

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'tablet', width: 768, height: 900 },
] as const) {
  test.describe(`ListDetail toggle against the header title, ${viewport.name}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(fixtureRoute('list-detail', { fixtureName: 'list-collapsible' }), {
        waitUntil: 'load',
      });
      await page.locator('.cinder-list-detail__toggle button').waitFor();
    });

    test('the toggle does not meet the first text of a plain heading', async ({ page }) => {
      const read = await page.locator('.cinder-list-detail').evaluate((root) => {
        const toggle = root.querySelector('.cinder-list-detail__toggle button');
        const header = root.querySelector('.cinder-list-detail__header');
        const heading = header?.querySelector('h2') ?? null;
        const list = root.querySelector('.cinder-list-detail__list');
        if (toggle === null || header === null || heading === null || list === null) {
          throw new Error('Missing toggle, header, heading or list');
        }
        const range = document.createRange();
        range.selectNodeContents(heading);
        const text = range.getBoundingClientRect();
        const box = toggle.getBoundingClientRect();
        const headerBox = header.getBoundingClientRect();
        const listBox = list.getBoundingClientRect();
        const headerStart =
          headerBox.left + Number.parseFloat(getComputedStyle(header).paddingLeft);
        return {
          textStart: text.left,
          headerStart,
          toggle: { left: box.left, right: box.right },
          list: { left: listBox.left, right: listBox.right },
          overlapsAcross: box.left < text.right && text.left < box.right,
          overlapsDown: box.top < text.bottom && text.top < box.bottom,
        };
      });
      expect(read.overlapsAcross && read.overlapsDown).toBe(false);
      // Nothing stands before the title: its words start on the header's own content edge.
      expect(Math.abs(read.textStart - read.headerStart)).toBeLessThanOrEqual(1);
      // The handle is inside the list pane, past the title's start, at the divider's side.
      expect(read.toggle.left).toBeGreaterThanOrEqual(read.list.left - 0.5);
      expect(read.toggle.right).toBeLessThanOrEqual(read.list.right + 0.5);
      expect(read.toggle.left).toBeGreaterThan(read.textStart);
    });
  });
}
