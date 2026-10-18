/**
 * COR-15 active-revision badges on the list-row surfaces, at 375/768/1280 in
 * both themes: the workflows list Revision column, the detail Children tab
 * (its grid column widened to fit the badge), and the Overview lineage
 * panel's children preview. Read-only against the seeded server.
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

      await page.goto('/runs?type=order-processing');
      const row = page.getByRole('row', { name: /order-processing/ }).first();
      await expect(row).toBeVisible();
      await expect(row.getByText(BADGE).first()).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      expect(await noOverflow()).toBe(true);

      await page.goto('/runs?type=fulfillment-parent');
      const parentLink = page.getByRole('table', { name: 'Workflows' }).getByRole('link').first();
      await expect(parentLink).toBeVisible();
      await parentLink.click();
      await expect(
        page.getByRole('heading', { level: 1, name: 'fulfillment-parent' }),
      ).toBeVisible();

      // Overview lineage panel's children preview.
      const preview = page.locator('a[href*="/runs/"]').filter({ hasText: BADGE });
      await expect(preview.first()).toBeVisible();
      expect(await noOverflow()).toBe(true);

      await page.getByRole('tab', { name: 'Children' }).click();
      await expect(page.getByText(BADGE).first()).toBeVisible();
      expect(await noOverflow()).toBe(true);
    }
  }
});
