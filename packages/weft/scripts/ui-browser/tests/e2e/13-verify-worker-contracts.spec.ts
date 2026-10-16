/**
 * Primary COR-162 operator flow against the seeded real Weft server: open a
 * worker, then a registry entry, and read the contract verification status
 * the dashboard computes from the worker's accepted manifest and the active
 * registry snapshot.
 *
 * The seeded `e2e-fleet-worker-1` (`e2e-server.ts`) advertises
 * `order-processing` with `chargeCard` and `reserveInventory` and no
 * generated contract, so its revision and contract hash differ from the
 * registry's active revision, which also declares `sendConfirmationEmail`.
 * That drift is the real state of the fixture, and the spec asserts it.
 */
import { expect, test } from './auth-fixtures.ts';

test('operator reads a worker’s contract verification status', async ({ page, checkA11y }) => {
  await page.goto('/workers?tab=list&worker=e2e-fleet-worker-1');

  const verification = page.getByRole('region', { name: 'Contract verification' });
  await expect(verification).toBeVisible();
  await expect(verification.getByText('Drift · manifest differs from registry')).toBeVisible();
  await expect(
    verification.getByText('Revision differs from the active registry revision'),
  ).toBeVisible();
  await expect(
    verification.getByText('Contract hash differs from the active registry revision'),
  ).toBeVisible();

  const activities = verification.getByRole('table', {
    name: 'order-processing activity verification',
  });
  await expect(
    activities.getByRole('row', { name: /sendConfirmationEmail Missing from worker/ }),
  ).toBeVisible();
  await expect(
    activities.getByRole('row', { name: /chargeCard Hash not checked here/ }),
  ).toBeVisible();

  await expect(
    verification.getByText(
      /^weft worker verify --manifest checkout-worker-fleet-e2e-build-1\.manifest\.json --from registry-v\d+\.json$/,
    ),
  ).toBeVisible();
  await expect(
    verification.getByRole('button', { name: 'Copy weft worker verify command' }),
  ).toBeVisible();
  await expect(
    verification.getByRole('button', { name: 'Copy weft codegen command' }),
  ).toBeVisible();

  await checkA11y('workers — contract verification');
});

test('operator reads every serving worker’s verification from a registry entry', async ({
  page,
  checkA11y,
}) => {
  await page.goto('/system?tab=registry');

  await page.getByRole('button', { name: /order-processing/ }).click();

  const verification = page.getByRole('region', { name: 'Worker contract verification' });
  await expect(verification).toBeVisible();
  await expect(verification.getByText('Drift · 1 of 1 worker')).toBeVisible();
  await expect(verification.getByText('checkout-worker-fleet · e2e-build-1')).toBeVisible();
  await expect(verification.getByText('Missing from worker')).toBeVisible();

  await checkA11y('system — registry contract verification');
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
      await expect(verification.getByText('Drift · manifest differs from registry')).toBeVisible();
      await verification.getByRole('button', { name: 'Copy weft worker verify command' }).focus();
      await expect(
        verification.getByRole('button', { name: 'Copy weft worker verify command' }),
      ).toBeFocused();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
  }
});
