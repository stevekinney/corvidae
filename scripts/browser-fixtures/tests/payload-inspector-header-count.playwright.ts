/// <reference lib="dom" />
/**
 * A labelled PayloadInspector sets its count as a muted line under its label, start-aligned, and
 * keeps the copy button on the label's row at the inline end, at a phone's card width too. Measured
 * on the `payload-inspector` assertion fixture with `?envelope=1`, which adds a run's input card
 * without touching the default fixture's baselines. Every box is read in one pass.
 */

import { expect, test } from '@playwright/test';
import { fixtureRoute } from './overlay-fixture.ts';

test('the count sits under the label at the start, and the copy button stays on the label’s row', async ({
  page,
}) => {
  await page.goto(`${fixtureRoute('payload-inspector')}&envelope=1`, { waitUntil: 'load' });
  const card = page.locator('[data-testid="payload-envelope"]');
  await card.waitFor({ state: 'visible' });
  const read = await card.evaluate((element) => {
    const box = (selector: string) => {
      const found = element.querySelector(selector);
      if (!found) return null;
      const { top, bottom, left, right } = found.getBoundingClientRect();
      return { top, bottom, left, right };
    };
    return {
      label: box('.cinder-payload-inspector__label'),
      count: box('.cinder-payload-inspector__size'),
      copy: box('.cinder-copy-button'),
      header: box('.cinder-payload-inspector__header'),
      countText: element.querySelector('.cinder-payload-inspector__size')?.textContent ?? '',
    };
  });
  expect(read.countText).toContain('4 fields, 3 in JSON only');
  // Under the label, at its start.
  expect(read.count!.top).toBeGreaterThanOrEqual(read.label!.bottom - 1);
  expect(Math.abs(read.count!.left - read.label!.left)).toBeLessThanOrEqual(1);
  // The copy button on the label's row, at the header's inline end.
  expect(read.copy!.top).toBeLessThan(read.label!.bottom);
  expect(read.copy!.right).toBeGreaterThan(read.count!.right);
});

test('in a 320px viewport the switch and Copy stay on the title’s row, Copy never alone on a line', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto(`${fixtureRoute('payload-inspector')}&envelope=1`, { waitUntil: 'load' });
  const card = page.locator('[data-testid="payload-envelope"]');
  await card.waitFor({ state: 'visible' });
  const read = await card.evaluate((element) => {
    const box = (selector: string) => {
      const found = element.querySelector(selector);
      if (!found) return null;
      const { top, bottom, left, right } = found.getBoundingClientRect();
      return { top, bottom, left, right };
    };
    return {
      title: box('.cinder-payload-inspector__title'),
      label: box('.cinder-payload-inspector__label'),
      actions: box('.cinder-payload-inspector__header-actions'),
      copy: box('.cinder-copy-button'),
      switchInActions:
        element.querySelector('.cinder-payload-inspector__header-actions [role="radiogroup"]') !==
        null,
    };
  });
  expect(read.switchInActions).toBe(true);
  // Copy shares the title's row: it starts above the label's bottom and sits beside the title.
  expect(read.copy!.top).toBeLessThan(read.label!.bottom);
  expect(read.actions!.top).toBeLessThan(read.title!.bottom);
  expect(read.copy!.left).toBeGreaterThanOrEqual(read.title!.right - 1);
});
