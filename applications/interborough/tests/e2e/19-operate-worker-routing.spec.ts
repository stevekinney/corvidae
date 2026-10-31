/**
 * COR-277: an operator previews and applies routing changes to a deployment,
 * moves traffic between builds, and drains and resumes one build. The
 * deployment is `ledger-evidence-fleet`, seeded by `ledger-evidence-seed.ts`
 * with two real builds (the previous build `e2e-ledger-build-0` and the current
 * `e2e-ledger-build-1`), so every figure is what the server reports.
 *
 * The flow is one test because each step builds on the routing pointer the last
 * one left. A server that is reused across runs keeps that pointer, so the
 * first step expects a deployment with no routing change yet, which a fresh
 * `e2e-server.ts` always provides.
 */
import type { Page } from '@playwright/test';

import {
  E2E_CURRENT_BUILD_ID,
  E2E_LEDGER_DEPLOYMENT_NAME,
  E2E_PREVIOUS_BUILD_ID,
} from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
] as const;

function deployment(page: Page) {
  return page.getByRole('region', { name: E2E_LEDGER_DEPLOYMENT_NAME, exact: true });
}

function buildRow(page: Page, buildId: string) {
  return deployment(page).getByRole('row').filter({ hasText: buildId });
}

async function value(page: Page, term: string) {
  return deployment(page)
    .getByText(term, { exact: true })
    .locator('xpath=following-sibling::dd[1]');
}

async function openDeployments(page: Page): Promise<void> {
  await page.goto('/health/workers?tab=deployments');
  await expect(deployment(page)).toBeVisible();
}

test('an operator sets routing, rolls back, promotes, then drains and resumes one build', async ({
  page,
  checkA11y,
}) => {
  await openDeployments(page);
  await expect(deployment(page).getByText(/No routing pointer yet/)).toBeVisible();
  await expect(buildRow(page, E2E_PREVIOUS_BUILD_ID)).toBeVisible();
  await expect(buildRow(page, E2E_CURRENT_BUILD_ID)).toBeVisible();
  await checkA11y('workers—deployments before any routing change');

  // Set routing: current build-1, build-0 ramping at 25%. Nothing is applied until it is confirmed.
  await deployment(page).getByRole('button', { name: 'Set routing' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Current build', { exact: true }).selectOption(E2E_CURRENT_BUILD_ID);
  await dialog.getByLabel('Ramping build', { exact: true }).selectOption(E2E_PREVIOUS_BUILD_ID);
  await dialog.getByLabel('Traffic to the ramping build', { exact: true }).fill('25');
  await dialog.getByLabel('Traffic to the ramping build', { exact: true }).blur();
  await dialog.getByRole('button', { name: 'Preview change' }).click();
  await expect(dialog.getByText(/applies against routing generation 0/)).toBeVisible();
  await expect(deployment(page).getByText(/No routing pointer yet/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Confirm set routing' }).click();
  await expect(dialog).toBeHidden();
  await expect(await value(page, 'Current build')).toHaveText(E2E_CURRENT_BUILD_ID);
  await expect(await value(page, 'Ramping build')).toHaveText(E2E_PREVIOUS_BUILD_ID);
  await expect(await value(page, 'Traffic to the ramping build')).toContainText('25%');
  await expect(await value(page, 'Rollout generation')).toHaveText('1');

  // The workflow-id explainer asks Weft which build a workflow lands on.
  await deployment(page).getByLabel('Workflow ID').fill('wf-bucket-check');
  await expect(
    deployment(page).getByRole('status').filter({ hasText: 'wf-bucket-check lands on build' }),
  ).toBeVisible();

  // Build ids say nothing about age: build-0 was first seen after build-1, so moving to it is a promotion.
  await buildRow(page, E2E_PREVIOUS_BUILD_ID).getByRole('button', { name: 'Promote' }).click();
  await expect(
    page.getByRole('dialog').getByText(/applies against routing generation 1/),
  ).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm promote build' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(await value(page, 'Current build')).toHaveText(E2E_PREVIOUS_BUILD_ID);
  await expect(await value(page, 'Rollout generation')).toHaveText('2');

  // A routing change made elsewhere after the preview is refused as stale, and nothing is applied.
  await buildRow(page, E2E_CURRENT_BUILD_ID).getByRole('button', { name: 'Roll back to' }).click();
  await expect(
    page.getByRole('dialog').getByText(/applies against routing generation 2/),
  ).toBeVisible();
  const rival = await page.request.post('/v1/worker-deployments/routing', {
    data: {
      deploymentName: E2E_LEDGER_DEPLOYMENT_NAME,
      currentBuildId: E2E_PREVIOUS_BUILD_ID,
      rampBasisPoints: 0,
      expectedGeneration: 2,
    },
  });
  expect(rival.ok()).toBe(true);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Confirm roll back to build' })
    .click();
  await expect(
    page
      .getByRole('dialog')
      .getByText(/Routing changed since you previewed it: the pointer is now at generation 3/),
  ).toBeVisible();
  await checkA11y('workers—stale routing change');

  // Preview again, and the rollback goes through against generation 3.
  await page.getByRole('dialog').getByRole('button', { name: 'Preview again' }).click();
  await expect(
    page.getByRole('dialog').getByText(/applies against routing generation 3/),
  ).toBeVisible();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Confirm roll back to build' })
    .click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(await value(page, 'Current build')).toHaveText(E2E_CURRENT_BUILD_ID);
  await expect(await value(page, 'Rollout generation')).toHaveText('4');

  // Only a draining build can be removed, so a ready build is told to drain first.
  await expect(
    buildRow(page, E2E_CURRENT_BUILD_ID).getByRole('button', { name: 'Remove' }),
  ).toBeDisabled();
  await expect(
    buildRow(page, E2E_CURRENT_BUILD_ID).getByText(
      new RegExp(
        `Cannot remove: Build ${E2E_LEDGER_DEPLOYMENT_NAME}/${E2E_CURRENT_BUILD_ID} is ready, so it is not draining. Drain it first`,
      ),
    ),
  ).toBeVisible();

  // Drain one build: its two workers still hold tasks, so they read as draining, then resume it.
  await buildRow(page, E2E_CURRENT_BUILD_ID).getByRole('button', { name: 'Drain' }).click();
  await page.getByRole('dialog').getByLabel('Reason').fill('e2e build drain');
  await page.getByRole('dialog').getByRole('button', { name: 'Drain build' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(
    buildRow(page, E2E_CURRENT_BUILD_ID).getByText(/2 draining, 0 drained/),
  ).toBeVisible();
  await expect(buildRow(page, E2E_PREVIOUS_BUILD_ID).getByText(/drained/)).toHaveCount(0);
  // The drain is the catalog's state for the build, so the version itself reads Draining.
  await expect(
    buildRow(page, E2E_CURRENT_BUILD_ID).getByText('Draining', { exact: true }),
  ).toBeVisible();
  // Drained, the current build is still not removable: it is the routing pointer's current build.
  await expect(
    buildRow(page, E2E_CURRENT_BUILD_ID).getByRole('button', { name: 'Remove' }),
  ).toBeDisabled();
  await expect(
    buildRow(page, E2E_CURRENT_BUILD_ID).getByText(
      new RegExp(
        `Cannot remove: Build ${E2E_LEDGER_DEPLOYMENT_NAME}/${E2E_CURRENT_BUILD_ID} is the current build`,
      ),
    ),
  ).toBeVisible();

  await buildRow(page, E2E_CURRENT_BUILD_ID).getByRole('button', { name: 'Resume' }).click();
  await expect(
    buildRow(page, E2E_CURRENT_BUILD_ID).getByText('Ready', { exact: true }),
  ).toBeVisible();
  await expect(buildRow(page, E2E_CURRENT_BUILD_ID).getByText(/drained/)).toHaveCount(0);
  await checkA11y('workers—deployments after routing, drain, and resume');
});

for (const theme of ['light', 'dark'] as const) {
  test(`deployments fit every supported width in the ${theme} theme`, async ({
    page,
    checkA11y,
  }) => {
    await page.addInitScript((selectedTheme) => {
      localStorage.setItem('weft-ui-theme', selectedTheme);
    }, theme);
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport);
      await openDeployments(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const label = `deployments (${theme}, ${viewport.width}px)`;
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `${label} page width`,
      ).toBe(true);
      await checkA11y(label);
    }
  });
}
