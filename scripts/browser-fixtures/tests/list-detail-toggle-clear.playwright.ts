/// <reference lib="dom" />
/**
 * ListDetail's list toggle stands in the start corner of the list header, and the header's first
 * row begins after it whatever that row holds. On the `list-collapsible` fixture the first row is a
 * plain `<h2>`, not a SectionHeading, so the toggle's box and the title's text box must not meet.
 * Read in a browser; the spec takes no screenshots.
 */

import { expect, test } from '@playwright/test';
import { fixtureRoute } from './overlay-fixture.ts';

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
        const heading = root.querySelector('.cinder-list-detail__header h2');
        if (toggle === null || heading === null) throw new Error('Missing toggle or heading');
        const range = document.createRange();
        range.selectNodeContents(heading);
        const text = range.getBoundingClientRect();
        const box = toggle.getBoundingClientRect();
        return {
          toggleEnd: box.right,
          textStart: text.left,
          overlapsAcross: box.left < text.right && text.left < box.right,
          overlapsDown: box.top < text.bottom && text.top < box.bottom,
        };
      });
      expect(read.overlapsAcross && read.overlapsDown).toBe(false);
      expect(read.textStart).toBeGreaterThanOrEqual(read.toggleEnd);
    });
  });
}
