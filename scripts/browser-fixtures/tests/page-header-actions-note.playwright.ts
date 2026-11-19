/// <reference lib="dom" />
/**
 * A PageHeader's caption under its actions (`actionsNote`): in a wide header it sits under the
 * actions at the inline end and never narrows the title; below 640px of header width it starts the
 * line under the actions. Measured on the `page-header` assertion fixture with `?actions-note=1`,
 * which adds the two headers without touching the default fixture's baselines.
 */

import { fixtureRoute } from '@lostgradient/testing/playwright/overlay-fixture';
import { expect, test } from '@playwright/test';

test('the caption sits under the actions, at the inline end when wide and at the start when narrow', async ({
  page,
}) => {
  await page.goto(`${fixtureRoute('page-header')}&actions-note=1`, { waitUntil: 'load' });
  await page.locator('[data-testid="actions-note-narrow"]').waitFor({ state: 'visible' });
  const read = await page.evaluate(() => {
    const measure = (width: string) => {
      const root = document.querySelector(`[data-testid="actions-note-${width}"]`);
      const box = (selector: string) => {
        const element = root?.querySelector(selector);
        if (!element) return null;
        const { top, bottom, left, right } = element.getBoundingClientRect();
        return { top, bottom, left, right };
      };
      const note = root?.querySelector('.cinder-page-header__actions-note');
      return {
        header: box('.cinder-page-header'),
        title: box('.cinder-page-header__title'),
        actions: box('.cinder-page-header__actions'),
        note: box('.cinder-page-header__actions-note'),
        describedBy: root
          ?.querySelector('.cinder-page-header__actions')
          ?.getAttribute('aria-describedby'),
        noteId: note?.id,
      };
    };
    return { wide: measure('wide'), narrow: measure('narrow') };
  });
  const { wide, narrow } = read;
  for (const header of [wide, narrow]) {
    // Under the actions, and the actions' group is described by it.
    expect(header.note!.top).toBeGreaterThanOrEqual(header.actions!.bottom - 1);
    expect(header.describedBy).toBe(header.noteId);
  }
  // Wide: at the inline end, no wider than the actions, and the title keeps its line.
  expect(Math.abs(wide.note!.right - wide.header!.right)).toBeLessThanOrEqual(1);
  expect(wide.note!.left).toBeGreaterThanOrEqual(wide.actions!.left - 1);
  expect(wide.title!.right).toBeLessThanOrEqual(wide.actions!.left);
  // Narrow: the title takes the row, and the caption starts the line under the actions.
  expect(narrow.actions!.top).toBeGreaterThanOrEqual(narrow.title!.bottom - 1);
  expect(Math.abs(narrow.note!.left - narrow.header!.left)).toBeLessThanOrEqual(1);
});
