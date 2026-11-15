/// <reference lib="dom" />
/**
 * COR-2327 B2: in a narrow PageHeader (20rem, under the 32rem container query), the default puts
 * the actions on a row of their own under the title and the status; `narrowActions="beside-status"`
 * puts them at the inline end of the status's row, so the header is that row's height shorter.
 * Measured on the `page-header` assertion fixture with `?narrow-actions=1`, which adds the two
 * headers without touching the default fixture's baselines. Every box is read in one pass.
 */

import { expect, test } from '@playwright/test';
import { fixtureRoute } from './overlay-fixture.ts';

test('a narrow header puts its actions beside the status only when asked, and is shorter for it', async ({
  page,
}) => {
  await page.goto(`${fixtureRoute('page-header')}&narrow-actions=1`, { waitUntil: 'load' });
  await page.locator('[data-testid="narrow-beside-status"]').waitFor({ state: 'visible' });
  const read = await page.evaluate(() => {
    const measure = (placement: string) => {
      const root = document.querySelector(`[data-testid="narrow-${placement}"]`);
      const box = (selector: string) => {
        const element = root?.querySelector(selector);
        if (!element) return null;
        const { top, bottom, left, right } = element.getBoundingClientRect();
        return { top, bottom, left, right };
      };
      return {
        header: box('.cinder-page-header'),
        title: box('.cinder-page-header__title'),
        status: box('.cinder-page-header__status'),
        actions: box('.cinder-page-header__actions'),
      };
    };
    return { ownRow: measure('own-row'), besideStatus: measure('beside-status') };
  });
  const { ownRow, besideStatus } = read;
  // The default: the actions start under the status, at the header's start edge.
  expect(ownRow.actions!.top).toBeGreaterThanOrEqual(ownRow.status!.bottom - 1);
  expect(Math.abs(ownRow.actions!.left - ownRow.header!.left)).toBeLessThanOrEqual(1);
  // Beside the status: under the title, on the status's row, at the inline end.
  expect(besideStatus.actions!.top).toBeGreaterThanOrEqual(besideStatus.title!.bottom - 1);
  expect(besideStatus.actions!.top).toBeLessThan(besideStatus.status!.bottom);
  expect(besideStatus.actions!.bottom).toBeGreaterThan(besideStatus.status!.top);
  expect(besideStatus.actions!.left).toBeGreaterThanOrEqual(besideStatus.status!.right - 1);
  expect(Math.abs(besideStatus.actions!.right - besideStatus.header!.right)).toBeLessThanOrEqual(1);
  // And the header is shorter by about the row the actions no longer take.
  const ownHeight = ownRow.header!.bottom - ownRow.header!.top;
  const besideHeight = besideStatus.header!.bottom - besideStatus.header!.top;
  expect(ownHeight - besideHeight).toBeGreaterThan(20);
});
