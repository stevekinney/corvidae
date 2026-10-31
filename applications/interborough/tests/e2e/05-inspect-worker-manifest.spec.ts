/** Primary WFC-17 operator flow against the seeded real Weft server. */
import { expect, test } from './fixtures.ts';

test('operator inspects a server-accepted canonical worker manifest', async ({
  page,
  checkA11y,
}) => {
  await page.goto('/health/workers');

  // A worker is connected, so the page is the full fleet view and not the in-process sentence.
  await expect(page.getByRole('tablist', { name: 'Workers views' })).toBeVisible();
  await expect(page.getByText('This server runs its work in-process')).toHaveCount(0);

  const workerRow = page.locator('[data-worker-row="e2e-fleet-worker-1"]');
  await expect(workerRow).toBeVisible();
  await workerRow.click();

  const manifest = page.getByRole('region', { name: 'Canonical manifest' });
  await expect(manifest).toBeVisible();
  await expect(manifest.getByText('Ready · server accepted')).toBeVisible();
  await expect(manifest.getByText('e2e-build-1')).toBeVisible();
  await expect(manifest.getByText('checkout-worker-fleet')).toBeVisible();
  await expect(manifest.getByText('order-processing')).toBeVisible();
  await expect(manifest.getByText('Wire protocol')).toBeVisible();
  await expect(manifest.getByText('Accepted manifest')).toBeVisible();

  // COR-124: the server-reported session for this worker id.
  const session = page.getByRole('region', { name: 'Session' });
  await expect(session.getByText('Session generation')).toBeVisible();
  await expect(session.getByText('Connected at')).toBeVisible();
  await expect(session.getByText('Heartbeat age')).toBeVisible();

  await checkA11y('workers — canonical worker manifest detail');
});

test('canonical manifest remains usable across supported widths and themes', async ({
  page,
  checkA11y,
}) => {
  for (const theme of ['light', 'dark'] as const) {
    for (const viewport of [
      { width: 375, height: 812 },
      { width: 768, height: 1024 },
      { width: 1280, height: 800 },
    ]) {
      await page.setViewportSize(viewport);
      await page.addInitScript((selectedTheme) => {
        localStorage.setItem('weft-ui-theme', selectedTheme);
      }, theme);
      await page.goto('/health/workers?worker=e2e-fleet-worker-1');

      const manifest = page.getByRole('region', { name: 'Canonical manifest' });
      await expect(manifest).toBeVisible();
      await expect(manifest.getByText('Ready · server accepted')).toBeVisible();
      await expect(page.getByRole('region', { name: 'Session' })).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await checkA11y(`workers — canonical worker manifest (${theme}, ${viewport.width}px)`);
    }
  }
});
