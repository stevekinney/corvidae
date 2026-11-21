/// <reference lib="dom" />
/**
 * COR-2539 (design correction round 3): a closed Tooltip panel takes no part in layout. Inside a
 * box with a transform the panel (`position: fixed`, `max-content`) is laid out against that box,
 * so a panel hidden by `visibility` alone widened the box's scrollable area. It still opens on
 * hover, closes when the pointer leaves, and is a valid `aria-describedby` target while closed.
 */

import { loadManifest } from '@lostgradient/testing';
import { test } from '@lostgradient/testing/playwright/component-page-fixture';
import { expect } from '@playwright/test';

const entry = loadManifest().find((candidate) => candidate.slug === 'tooltip');
const fixture = entry?.fixtures?.find((candidate) => candidate.name === 'closed-panel');

test('a closed tooltip panel inside a transformed box does not widen it, and still opens', async ({
  componentPage,
}) => {
  if (entry === undefined || fixture === undefined) throw new Error('No closed-panel fixture.');
  const page = await componentPage.open({
    entry,
    theme: 'light',
    viewport: { name: 'mobile', width: 375, height: 700 },
    fixtureName: 'closed-panel',
    fixtureContentHash: fixture.fixtureContentHash,
  });
  const box = page.getByTestId('transformed');
  const button = box.getByRole('button', { name: 'Copy' });
  await button.waitFor();
  // A box narrower than the panel's own width, so a panel that took part in layout would scroll it.
  await box.evaluate((element) => {
    element.style.inlineSize = '8rem';
  });

  const closed = await box.evaluate((element) => ({
    scroll: element.scrollWidth,
    client: element.clientWidth,
    panelDisplay: getComputedStyle(element.querySelector('[role="tooltip"]')!).display,
  }));
  expect(closed.scroll).toBe(closed.client);
  expect(closed.panelDisplay).toBe('none');

  // Closed, the panel is still the button's description.
  const describedBy = await button.getAttribute('aria-describedby');
  expect(describedBy).not.toBeNull();
  await expect(page.locator(`[id="${describedBy}"]`)).toHaveText(
    'Copy the Claude Code command for Cursor.',
  );

  await button.hover();
  await expect(page.getByRole('tooltip')).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(page.getByRole('tooltip')).toBeHidden();
});
