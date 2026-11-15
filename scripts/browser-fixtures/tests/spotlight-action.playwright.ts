/// <reference lib="dom" />
/**
 * COR-2329: Spotlight's `action`, the value's way out to the page that holds the rest. It sits at
 * the end of the value's first line, centred on it, as a section's action sits beside its heading,
 * and drops to the next line only when the two do not fit side by side.
 */

import { expect, test, type Locator } from '@playwright/test';
import { fixtureRoute } from './layout-fixture.ts';

async function parts(spotlight: Locator) {
  const [root, value, action] = await Promise.all([
    spotlight.locator('.cinder-spotlight').boundingBox(),
    spotlight.locator('.cinder-spotlight__value').boundingBox(),
    spotlight.getByRole('link').boundingBox(),
  ]);
  const valueLine = await spotlight
    .locator('.cinder-spotlight__value')
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).lineHeight));
  return { root: root!, value: value!, action: action!, valueLine };
}

test.describe('Spotlight action', () => {
  test('sits at the end of the value’s first line, centred on it', async ({ page }) => {
    await page.goto(fixtureRoute('spotlight'), { waitUntil: 'load' });
    const { root, value, action, valueLine } = await parts(page.getByTestId('spotlight-action'));
    const firstLine = value.y + valueLine / 2;
    expect(Math.abs(action.y + action.height / 2 - firstLine)).toBeLessThanOrEqual(1);
    expect(Math.abs(action.x + action.width - (root.x + root.width))).toBeLessThanOrEqual(1);
    // The Spotlight is no taller than its value: the action adds no line.
    expect(Math.abs(root.height - value.height)).toBeLessThanOrEqual(1);
  });

  test('stays on that line at a phone’s width where it fits, and drops under the value only where it does not', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(fixtureRoute('spotlight'), { waitUntil: 'load' });
    const short = await parts(page.getByTestId('spotlight-action'));
    expect(
      Math.abs(short.action.y + short.action.height / 2 - (short.value.y + short.valueLine / 2)),
    ).toBeLessThanOrEqual(1);
    // A pane too narrow for both: 20rem holds the value, not the value and the link.
    await page.setViewportSize({ width: 1024, height: 800 });
    const long = await parts(page.getByTestId('spotlight-action-long'));
    // "Nothing needs you" keeps its one line; the action takes the next.
    expect(Math.round(long.value.height / long.valueLine)).toBe(1);
    expect(long.action.y).toBeGreaterThanOrEqual(long.value.y + long.value.height - 1);
  });
});
