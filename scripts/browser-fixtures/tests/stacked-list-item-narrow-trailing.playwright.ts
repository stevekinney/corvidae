/// <reference lib="dom" />
/**
 * COR-2327: under a 448px row width a StackedListItem drops its trailing region under the body only
 * when that region holds a control. A decorative chevron (the chat list's Archived chats row) stays
 * in the trailing column, beside the title. Measured on the `narrow-trailing` fixture, whose two
 * rows are 20rem wide; every box is read in one pass.
 */

import { fixtureRoute } from '@lostgradient/testing/playwright/overlay-fixture';
import { expect, test } from '@playwright/test';

test('a narrow row keeps a trailing glyph beside the body and drops a trailing control under it', async ({
  page,
}) => {
  await page.goto(fixtureRoute('stacked-list-item', { fixtureName: 'narrow-trailing' }), {
    waitUntil: 'load',
  });
  await page.locator('[data-testid="control"] .cinder-button').waitFor({ state: 'visible' });
  const read = await page.evaluate(() => {
    const measure = (testId: string) => {
      const root = document.querySelector(`[data-testid="${testId}"]`);
      const box = (selector: string) => {
        const element = root?.querySelector(selector);
        if (!element) return null;
        const { top, bottom, left, right } = element.getBoundingClientRect();
        return { top, bottom, left, right };
      };
      return {
        row: box('.cinder-stacked-list-item'),
        body: box('.cinder-stacked-list-item__body'),
        trailing: box('.cinder-stacked-list-item__trailing'),
      };
    };
    return { glyph: measure('glyph'), control: measure('control') };
  });
  const { glyph, control } = read;
  // The chevron: on the body's line, after it, at the row's inline end.
  expect(glyph.trailing!.top).toBeLessThan(glyph.body!.bottom);
  expect(glyph.trailing!.bottom).toBeGreaterThan(glyph.body!.top);
  expect(glyph.trailing!.left).toBeGreaterThanOrEqual(glyph.body!.right - 1);
  // The button: on a line of its own under the body.
  expect(control.trailing!.top).toBeGreaterThanOrEqual(control.body!.bottom - 1);
});
