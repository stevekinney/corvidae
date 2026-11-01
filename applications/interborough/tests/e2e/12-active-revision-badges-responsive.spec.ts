/**
 * COR-15 active-revision badges on the list-row surfaces, at 375/768/1280 in
 * both themes: the workflows list Revision column and the run page's Related
 * runs (the runs it started and the runs started alongside it). Read-only
 * against the seeded server.
 */
import { expect, test } from './fixtures.ts';

const BADGE = /Active|Differs from active/;

const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
];

test('list-row active-revision badges fit across widths and themes', async ({ page }) => {
  for (const theme of ['light', 'dark'] as const) {
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport);
      await page.addInitScript((selectedTheme) => {
        localStorage.setItem('weft-ui-theme', selectedTheme);
      }, theme);
      const noOverflow = () =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

      await page.goto('/workflows/order-processing/runs');
      const row = page.getByRole('row', { name: /order-processing/ }).first();
      await expect(row).toBeVisible();
      await expect(row.getByText(BADGE).first()).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      expect(await noOverflow()).toBe(true);

      await page.goto('/workflows/fulfillment-parent/runs');
      const parentLink = page.getByRole('table', { name: 'Workflows' }).getByRole('link').first();
      await expect(parentLink).toBeVisible();
      await parentLink.click();
      await expect(
        page.getByRole('heading', { level: 1, name: 'fulfillment-parent' }),
      ).toBeVisible();

      // Related runs, in the Details rail: the runs this one started, each with its badge.
      const related = page.locator('[data-related-run]').filter({ hasText: BADGE });
      await expect(related.first()).toBeVisible();
      expect(await noOverflow()).toBe(true);
    }
  }
});
