/**
 * COR-166 operator flow against the seeded real Weft server: open System →
 * Registry, drill into a workflow, and operate its conditional refresh
 * source from the refresh panel. Three seeded sources
 * (`fixtures/workflow-refresh.ts`) cover a compatible candidate that checks,
 * activates, and then answers 304; an incompatible candidate that installs
 * and is refused activation with its reasons; and a corrupt artifact that is
 * refused as an integrity failure with nothing installed.
 *
 * Each source is on its own workflow. The spec follows spec 09's convention: it asserts what
 * holds whether or not an earlier run already checked a source, so it passes when run twice
 * against one server (the first run installs and activates; the second sees 304).
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
  await page.goto('/settings/api-reference?group=sources');
  await page.getByRole('button', { name: new RegExp(workflow) }).click();
  const panel = page.getByRole('region', { name: 'Conditional refresh' });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('article', { name: `Refresh source ${workflow}` })).toBeVisible();
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

  // The first run activates the candidate; a later run finds the source unchanged and gets a 304.
  const outcome = panel
    .getByRole('status')
    .filter({ hasText: /Activated revision ".+" \(generation \d+\)|The source answered 304/ });
  await expect(outcome).toBeVisible();

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

  // The first run installs the candidate; a later run finds it unchanged.
  await panel.getByRole('button', { name: 'Check now' }).click();
  await expect(
    panel.getByRole('status').filter({
      hasText: new RegExp(
        `Candidate revision "${REFRESH_INCOMPATIBLE_REVISION}" is installed|The source answered 304`,
      ),
    }),
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

test('the populated refresh panel keeps every value inside its card at supported widths and themes', async ({
  page,
}, testInfo) => {
  // Populate the source once, at the default width: the panel then shows the current revision,
  // the candidate, and the ETag, the longest values it renders.
  const first = await openRefreshPanel(page, REFRESH_INCOMPATIBLE_WORKFLOW);
  await first.getByRole('button', { name: 'Check now' }).click();
  await expect(first.getByText(REFRESH_INCOMPATIBLE_REVISION).first()).toBeVisible();

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
      const panel = await openRefreshPanel(page, REFRESH_INCOMPATIBLE_WORKFLOW);
      await expect(panel.getByText('Current revision')).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

      const card = panel.getByRole('article', {
        name: `Refresh source ${REFRESH_INCOMPATIBLE_WORKFLOW}`,
      });
      const cardBox = await card.boundingBox();
      if (cardBox === null) throw new Error('The source card has no box.');
      // Every term and value sits inside the card, so none is clipped by an ancestor.
      const overflowing = await card.locator('dt, dd').evaluateAll(
        (elements, bounds) =>
          elements
            .filter((element) => {
              const box = element.getBoundingClientRect();
              return (
                box.right > bounds.right + 0.5 ||
                box.left < bounds.left - 0.5 ||
                element.scrollWidth > element.clientWidth + 1
              );
            })
            .map((element) => element.textContent),
        { left: cardBox.x, right: cardBox.x + cardBox.width },
      );
      expect(overflowing).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      // Kept under the run's output directory, so a reviewer can look at the populated panel.
      await panel.screenshot({
        path: testInfo.outputPath(`refresh-panel-${theme}-${viewport.width}.png`),
      });
    }
  }
});
