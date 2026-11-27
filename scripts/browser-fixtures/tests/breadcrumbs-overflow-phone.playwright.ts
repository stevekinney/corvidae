/// <reference lib="dom" />
/**
 * COR-2770: both forms of Breadcrumbs stay in the page, and the phone form hides the "…" item in
 * CSS. The menu that item opens is portaled outside the trail, so a menu open when the viewport
 * narrows past 640px must close rather than float over a trigger that is no longer drawn. Measured
 * on the `breadcrumbs` assertion fixture's `?overflow=1` trail, whose earlier ancestors fold into
 * the menu at every width (`maxVisible={1}`).
 */

import { fixtureRoute } from '@lostgradient/testing/playwright/overlay-fixture';
import { expect, test } from '@playwright/test';

test('an open "…" menu closes when the viewport narrows to the phone form', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${fixtureRoute('breadcrumbs')}&overflow=1`, { waitUntil: 'load' });
  const trigger = page.locator('[data-testid="overflow-trail"] .cinder-breadcrumbs__overflow');
  const menu = page.locator('.cinder-breadcrumbs__overflow-list');

  await trigger.click();
  await expect(menu).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');

  await page.setViewportSize({ width: 375, height: 800 });
  await expect(trigger).toBeHidden();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(menu).toBeHidden();
  // Focus was in the menu; the hidden trigger cannot take it back, so the back link does.
  const back = page.locator('[data-testid="overflow-trail"] a.cinder-breadcrumbs__back');
  await expect(back).toBeVisible();
  await expect(back).toBeFocused();
});
