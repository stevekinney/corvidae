/// <reference lib="dom" />
/**
 * COR-2445: on the 76px labelled rail no label is cut. Before, the items were the width of a padded
 * list (about 60px) and "Capabilities" read "Capabiliti...". A label never ends in an ellipsis, and a
 * name that cannot fit wraps instead, so each label's `scrollWidth` fits its `clientWidth` and none
 * computes `text-overflow: ellipsis`. Read in one pass.
 */

import { fixtureRoute } from '@lostgradient/testing/playwright/overlay-fixture';
import { expect, test } from '@playwright/test';

test('no label on the labelled rail is cut, and the items span the rail less one step each side', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.goto(fixtureRoute('sidebar'), { waitUntil: 'load' });
  await page.locator('[data-testid="sidebar-rail-labels"] .cinder-sidebar').waitFor();

  const read = await page.evaluate(() => {
    const host = document.querySelector('[data-testid="sidebar-rail-labels"]');
    const rail = host?.querySelector('.cinder-sidebar')?.getBoundingClientRect();
    const labels = [...(host?.querySelectorAll('.cinder-side-navigation-item__label') ?? [])];
    const items = [...(host?.querySelectorAll('a.cinder-side-navigation-item') ?? [])];
    return {
      railWidth: rail?.width ?? 0,
      items: items.map((item) => ({
        left: item.getBoundingClientRect().left - (rail?.left ?? 0),
        width: item.getBoundingClientRect().width,
      })),
      labels: labels.map((label) => ({
        text: label.textContent,
        scrollWidth: label.scrollWidth,
        clientWidth: label.clientWidth,
        textOverflow: getComputedStyle(label).textOverflow,
      })),
    };
  });

  expect(read.railWidth).toBe(76);
  expect(read.labels.length).toBeGreaterThanOrEqual(5);
  for (const label of read.labels) {
    expect(label.scrollWidth, `${label.text} is cut`).toBeLessThanOrEqual(label.clientWidth);
    expect(label.textOverflow, `${label.text} ends in an ellipsis`).not.toBe('ellipsis');
  }
  for (const item of read.items) {
    expect(item.width).toBe(68);
    expect(item.left).toBe(4);
  }
});
