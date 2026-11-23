/// <reference lib="dom" />
/**
 * A labelled PayloadInspector sets its count beside its label when there is room and
 * keeps the copy button on the label's row at the inline end, at a phone's card width too. Measured
 * on the `payload-inspector` assertion fixture with `?envelope=1`, which adds a run's input card
 * without touching the default fixture's baselines. Every box is read in one pass.
 */

import { fixtureRoute } from '@lostgradient/testing/playwright/overlay-fixture';
import { expect, test } from '@playwright/test';

import { setFixtureWidth } from './layout-fixture.ts';

test('the count sits beside the label on one line, with Copy at the end', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${fixtureRoute('payload-inspector')}&envelope=1`, { waitUntil: 'load' });
  const card = page.locator('[data-testid="payload-envelope"]');
  await setFixtureWidth(card, '36rem');
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
      title: box('.cinder-payload-inspector__title'),
      countText: element.querySelector('.cinder-payload-inspector__size')?.textContent ?? '',
    };
  });
  expect(read.countText).toContain('4 fields, 3 in JSON only');
  expect(
    Math.abs(read.title!.bottom - read.title!.top - (read.label!.bottom - read.label!.top)),
  ).toBeLessThanOrEqual(1);
  expect(read.count!.left).toBeGreaterThan(read.label!.right);
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
  const copyButton = card.locator('.cinder-copy-button[data-cinder-icon-only]');
  const padding = await copyButton.evaluate((button) => {
    const { paddingBlockStart, paddingInlineStart, paddingInlineEnd } = getComputedStyle(button);
    return { paddingBlockStart, paddingInlineStart, paddingInlineEnd };
  });
  expect(padding.paddingInlineStart).toBe(padding.paddingBlockStart);
  expect(padding.paddingInlineEnd).toBe(padding.paddingBlockStart);
});

test('the count wraps below the label inside a 160px card', async ({ page }) => {
  await page.goto(`${fixtureRoute('payload-inspector')}&envelope=1`, {
    waitUntil: 'load',
  });
  const wrapper = page.getByTestId('payload-envelope');
  await setFixtureWidth(wrapper, '160px');
  const title = wrapper.locator('.cinder-payload-inspector__title');
  await expect(title).toBeVisible();
  const { label, count, right } = await title.evaluate((node) => ({
    label: node
      .querySelector('.cinder-payload-inspector__label')!
      .getBoundingClientRect()
      .toJSON() as DOMRect,
    count: node
      .querySelector('.cinder-payload-inspector__size')!
      .getBoundingClientRect()
      .toJSON() as DOMRect,
    right: node.getBoundingClientRect().right,
  }));
  expect(count.top).toBeGreaterThanOrEqual(label.bottom);
  expect(label.right).toBeLessThanOrEqual(right);
  expect(count.right).toBeLessThanOrEqual(right);
});
