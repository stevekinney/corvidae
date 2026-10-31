/**
 * COR-281: an operator traces a task that retried across a build boundary to the
 * worker that holds it now. The task is produced by `e2e-server.ts` through real
 * remote workers (see `ledger-evidence-seed.ts`): three attempts ran on the
 * previous build, and a worker on the current build holds the fourth.
 */
import type { Page } from '@playwright/test';

import {
  E2E_CROSS_BUILD_TASK_OPERATION_ID,
  E2E_CROSS_BUILD_WORKER_ID,
  E2E_CURRENT_BUILD_ID,
  E2E_PREVIOUS_BUILD_ID,
} from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
] as const;

async function openCrossBuildTask(page: Page): Promise<void> {
  await page.goto(`/health/workers?tab=diagnostics&task=${E2E_CROSS_BUILD_TASK_OPERATION_ID}`);
  await expect(page.getByRole('heading', { name: 'Authoritative task ledger' })).toBeVisible();
}

test('a cross-build retry shows its requirement, both worker identities, and the crossing', async ({
  page,
  checkA11y,
}) => {
  await openCrossBuildTask(page);

  const history = page.getByRole('list', { name: 'Attempt history' });
  await expect(history.getByRole('listitem')).toHaveCount(4);

  // Attempts 1 to 3 ran on the previous build; none of them crossed from an earlier one.
  const first = history.locator('[data-attempt="1"]');
  await expect(first.getByText(E2E_PREVIOUS_BUILD_ID, { exact: true })).toBeVisible();
  await expect(first.getByText('Crossed build')).toHaveCount(0);
  await expect(history.locator('[data-attempt="3"]').getByText('Crossed build')).toHaveCount(0);

  // Attempt 4 runs on the current build and says exactly what changed, in text.
  const fourth = history.locator('[data-attempt="4"]');
  await expect(fourth.getByText('Crossed build')).toBeVisible();
  await expect(
    fourth.getByText(`build ${E2E_PREVIOUS_BUILD_ID} → ${E2E_CURRENT_BUILD_ID}`, { exact: false }),
  ).toBeVisible();
  await expect(fourth.getByText(E2E_CURRENT_BUILD_ID, { exact: true })).toBeVisible();
  await expect(fourth.getByText('Routing requirement')).toBeVisible();
  await expect(fourth.getByText(E2E_CROSS_BUILD_WORKER_ID, { exact: false })).toBeVisible();

  await checkA11y('workers—cross-build retry attempt history');
});

test('filtering Diagnostics by build ID finds the task and deep-links to its worker', async ({
  page,
  checkA11y,
}) => {
  await page.goto('/health/workers?tab=diagnostics');
  await page.getByLabel('Build ID').fill(E2E_CURRENT_BUILD_ID);
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page).toHaveURL(new RegExp(`buildId=${E2E_CURRENT_BUILD_ID}`));

  // The retry storm names the worker holding the current attempt.
  await expect(page.getByText('Retry storm', { exact: false }).first()).toBeVisible();
  // Other seeded tasks can also be on this build, and one task can be reported under more than
  // one diagnostic kind; every link to the storm's current worker goes to the same place.
  const workerLink = page.locator(`a[href*="worker=${E2E_CROSS_BUILD_WORKER_ID}"]`).first();
  await expect(workerLink).toBeVisible();
  await checkA11y('workers—diagnostics filtered by build');

  await workerLink.click();
  await expect(page).toHaveURL(/tab=list/);
  await expect(page).toHaveURL(new RegExp(`worker=${E2E_CROSS_BUILD_WORKER_ID}`));
  // The detail view shows a truncated id and keeps the full one as its title.
  await expect(page.getByTitle(E2E_CROSS_BUILD_WORKER_ID).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Session' })).toBeVisible();
});

test('a build that ran nothing says no task matches instead of reporting a healthy fleet', async ({
  page,
}) => {
  await page.goto('/health/workers?tab=diagnostics&buildId=no-such-build');
  await expect(page.getByText(/No task matches these provenance filters/)).toBeVisible();
  await expect(page.getByLabel('Build ID')).toHaveValue('no-such-build');
});

for (const theme of ['light', 'dark'] as const) {
  test(`provenance fits every supported width in the ${theme} theme`, async ({
    page,
    checkA11y,
  }) => {
    await page.addInitScript((selectedTheme) => {
      localStorage.setItem('weft-ui-theme', selectedTheme);
    }, theme);
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport);
      await openCrossBuildTask(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const fourth = page
        .getByRole('list', { name: 'Attempt history' })
        .locator('[data-attempt="4"]');
      await expect(fourth.getByText('Crossed build')).toBeVisible();
      const label = `cross-build task (${theme}, ${viewport.width}px)`;
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `${label} page width`,
      ).toBe(true);
      await checkA11y(label);

      await page.goto(`/health/workers?tab=diagnostics&buildId=${E2E_CURRENT_BUILD_ID}`);
      await expect(page.getByLabel('Build ID')).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `${label} filter page width`,
      ).toBe(true);
      await checkA11y(`${label} filters`);
    }
  });
}
