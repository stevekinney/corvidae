/**
 * COR-166 operator flow against the seeded real Weft server: open System →
 * Registry, drill into a workflow, and operate its conditional refresh
 * source from the refresh panel. Three seeded sources
 * (`fixtures/workflow-refresh.ts`) cover a compatible candidate that checks,
 * activates, and then answers 304; an incompatible candidate that installs
 * and is refused activation with its reasons; and a corrupt artifact that is
 * refused as an integrity failure with nothing installed.
 *
 * Each source is on its own workflow, and each flow runs once per server.
 */
import type { Page } from '@playwright/test';
import {
  REFRESH_COMPATIBLE_WORKFLOW,
  REFRESH_CORRUPT_WORKFLOW,
  REFRESH_INCOMPATIBLE_REVISION,
  REFRESH_INCOMPATIBLE_WORKFLOW,
} from '../../fixtures/workflow-refresh.ts';

import { expect, test } from './fixtures.ts';

async function openRefreshPanel(page: Page, workflow: string) {
  await page.goto('/system?tab=registry');
  await page.getByRole('button', { name: new RegExp(workflow) }).click();
  const panel = page.getByRole('region', { name: 'Conditional refresh' });
  await expect(panel).toBeVisible();
  await expect(panel.getByText('Never checked')).toBeVisible();
  return panel;
}

test('operator checks, activates, and re-checks a compatible refresh candidate', async ({
  page,
  checkA11y,
}) => {
  const panel = await openRefreshPanel(page, REFRESH_COMPATIBLE_WORKFLOW);
  await expect(panel.getByText('Manual maintenance').first()).toBeVisible();

  await panel.getByRole('button', { name: 'Check and activate' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Check and activate' }).click();

  const outcome = panel.getByRole('status').filter({ hasText: 'Activated' });
  await expect(outcome).toBeVisible();
  await expect(outcome).toContainText(/Activated revision ".+" \(generation \d+\)/);
  await expect(panel.getByText('Activated', { exact: true }).first()).toBeVisible();

  // The next check carries the ETag, and the source answers 304.
  await panel.getByRole('button', { name: 'Check now' }).click();
  await expect(panel.getByText(/The source answered 304/)).toBeVisible();

  await checkA11y('system — registry refresh panel, activated and not modified');
});

test('operator sees an incompatible candidate installed and refused activation with every reason', async ({
  page,
  checkA11y,
}) => {
  const panel = await openRefreshPanel(page, REFRESH_INCOMPATIBLE_WORKFLOW);

  await panel.getByRole('button', { name: 'Check now' }).click();
  await expect(
    panel.getByText(
      new RegExp(`Candidate revision "${REFRESH_INCOMPATIBLE_REVISION}" is installed`),
    ),
  ).toBeVisible();

  await panel.getByRole('button', { name: 'Activate candidate' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Activate' }).click();

  const refusal = panel.getByRole('alert').filter({ hasText: 'Incompatible' });
  await expect(refusal).toBeVisible();
  await expect(refusal.getByText(/workflow-version-incompatible/)).toBeVisible();
  await expect(refusal.getByText(/artifact-revision-mismatch/)).toBeVisible();

  await checkA11y('system — registry refresh panel, incompatible candidate');
});

test('operator sees a corrupt artifact refused as an integrity failure, with nothing installed', async ({
  page,
  checkA11y,
}) => {
  const panel = await openRefreshPanel(page, REFRESH_CORRUPT_WORKFLOW);

  await panel.getByRole('button', { name: 'Check now' }).click();

  const refusal = panel.getByRole('alert').filter({ hasText: 'Refused' });
  await expect(refusal).toBeVisible();
  await expect(refusal.getByText(/Integrity check failed/)).toBeVisible();
  await expect(refusal.getByText(/Nothing was installed/)).toBeVisible();
  await expect(panel.getByText(/Last check failed: Integrity check failed/)).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Activate candidate' })).toHaveCount(0);

  await checkA11y('system — registry refresh panel, integrity failure');
});

test('the refresh panel is usable across supported widths and themes', async ({ page }) => {
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
      await page.goto('/system?tab=registry');
      await page.getByRole('button', { name: /payment-failing/ }).click();

      const panel = page.getByRole('region', { name: 'Conditional refresh' });
      await expect(panel).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
  }
});
