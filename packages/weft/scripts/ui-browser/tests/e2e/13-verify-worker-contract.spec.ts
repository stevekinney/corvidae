/**
 * Primary COR-162 operator flow against the seeded real Weft server: open a worker, then a
 * registry definition, and read each one's contract verification against the active registry.
 *
 * The seeded fleet worker (`e2e-server.ts`) serves `order-processing` with two activities as bare
 * functions, while the registry's active `order-processing` revision declares three activities
 * with schemas. Its manifest therefore drifts from the registry in ways this spec reads as text.
 */
import { expect, test } from './auth-fixtures.ts';

test('operator reads a worker manifest verification status on Worker detail', async ({
  page,
  checkA11y,
}) => {
  await page.goto('/workers?tab=list&worker=e2e-fleet-worker-1');

  const verification = page.getByRole('region', { name: 'Contract verification' });
  await expect(verification).toBeVisible();
  await expect(verification.getByText(/^Drift · \d+ findings?$/)).toBeVisible();
  await expect(
    verification.getByRole('table', { name: 'Contract drift for worker e2e-fleet-worker-1' }),
  ).toBeVisible();
  await expect(
    verification.getByRole('rowheader', { name: 'order-processing.sendConfirmationEmail' }),
  ).toBeVisible();
  await expect(verification.getByText('Missing activity').first()).toBeVisible();
  await expect(
    verification.getByText(
      'weft worker verify --manifest checkout-worker-fleet-e2e-build-1.manifest.json --from weft-registry.json',
    ),
  ).toBeVisible();
  await expect(
    verification.getByText('weft codegen --from weft-registry.json --out weft-registry.d.ts'),
  ).toBeVisible();

  await checkA11y('workers — contract verification');
});

test('operator reads which workers serve a registry definition and how they drift', async ({
  page,
  checkA11y,
}) => {
  await page.goto('/system?tab=registry');
  await page.getByRole('button', { name: /order-processing/ }).click();

  const verification = page.getByRole('region', { name: 'Contract verification' });
  await expect(verification).toBeVisible();
  await expect(verification.getByText('e2e-flee…er-1')).toBeVisible();
  await expect(
    verification.getByRole('rowheader', { name: 'order-processing.sendConfirmationEmail' }),
  ).toBeVisible();

  await checkA11y('system — registry definition contract verification');
});

test('contract verification remains usable across supported widths and themes', async ({
  page,
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
      await page.goto('/workers?tab=list&worker=e2e-fleet-worker-1');

      const verification = page.getByRole('region', { name: 'Contract verification' });
      await expect(verification).toBeVisible();
      await expect(verification.getByText(/^Drift · \d+ findings?$/)).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
  }
});
