/// <reference lib="dom" />
/**
 * COR-2445: a bottom bar of five tabs in a 320px wrapper never cuts a label. Before, the bar padded
 * 16px each side and each tab 8px, which left about 41px for a label in a 64px slot and the third
 * tab read "Revie...". Every label's `scrollWidth` must fit its `clientWidth`, read in one pass.
 */

import { fixtureRoute } from '@lostgradient/testing/playwright/overlay-fixture';
import { expect, test } from '@playwright/test';

test('five bottom tabs in a 320px bar show every label whole', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(fixtureRoute('navigation-bar'), { waitUntil: 'load' });
  const host = page.locator('[data-testid="navigation-bar-five-tabs"]');
  await host.locator('[data-cinder-navigation-label]').first().waitFor();

  const read = await page.evaluate(() => {
    const wrapper = document.querySelector('[data-testid="navigation-bar-five-tabs"]');
    const labels = [...(wrapper?.querySelectorAll('[data-cinder-navigation-label]') ?? [])];
    return {
      width: wrapper?.getBoundingClientRect().width ?? 0,
      labels: labels.map((label) => ({
        text: label.textContent,
        scrollWidth: label.scrollWidth,
        clientWidth: label.clientWidth,
      })),
    };
  });

  expect(read.width).toBeLessThanOrEqual(322);
  expect(read.labels).toHaveLength(5);
  for (const label of read.labels) {
    expect(label.scrollWidth, `${label.text} is cut`).toBeLessThanOrEqual(label.clientWidth);
  }
});
