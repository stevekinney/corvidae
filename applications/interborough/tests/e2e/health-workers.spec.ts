/**
 * COR-1971: Workers as a list with the open worker beside it (design rows 20c and 19a). The page is
 * `/health/workers`, reached from Health or with `g` then `o`; its counts are one line under the
 * title; a worker opens beside the list and is the `worker` parameter of the address; and the
 * worker's detail drains and resumes it, shows the deployment it belongs to, and promotes or rolls
 * back that deployment's builds with the routing generation checked.
 *
 * The seeded fleet is `e2e-fleet-worker-1` (a WebSocket worker, `e2e-server.ts`) and the ledger
 * deployment's workers (`ledger-evidence-seed.ts`), which have two real builds.
 */
import type { Page } from '@playwright/test';

import {
  E2E_CURRENT_BUILD_ID,
  E2E_FLEET_WORKER_ID,
  E2E_LEDGER_DEPLOYMENT_NAME,
  E2E_LEDGER_WORKER_ID,
  E2E_PREVIOUS_BUILD_ID,
} from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

function row(page: Page, workerId: string) {
  return page.locator(`[data-worker-row="${workerId}"]`);
}

function detail(page: Page) {
  return page.getByTestId('worker-detail');
}

test('g then o opens Workers from anywhere, though the sidebar does not list it', async ({
  page,
}) => {
  await page.goto('/agents');
  await expect(page.getByRole('navigation', { name: 'Views' })).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Views' }).getByRole('link', { name: /^Workers/ }),
  ).toHaveCount(0);
  await page.keyboard.press('g');
  await page.keyboard.press('o');
  await expect(page).toHaveURL(/\/health\/workers$/);
  await expect(page.locator('[data-view="workers"]')).toHaveAttribute('data-state', 'ready');

  await page.keyboard.press('?');
  await expect(
    page.getByRole('dialog', { name: 'Keyboard shortcuts' }).getByText('Go to Workers'),
  ).toBeVisible();
});

test('the counts are one line under the list, and a worker opens beside it', async ({
  page,
  checkA11y,
}) => {
  await page.goto('/health/workers');
  const summary = page.getByTestId('workers-summary');
  await expect(summary).toHaveText(
    /^\d+ of \d+ connected · \d+ running · \d+ waiting · \d+ failed for good$/,
  );
  // The old stat cards are gone.
  await expect(page.getByText('Total workers')).toHaveCount(0);
  await expect(page.getByText('Utilization')).toHaveCount(0);
  await checkA11y('workers—list with its summary line');

  await row(page, E2E_FLEET_WORKER_ID).click();
  await expect(page).toHaveURL(new RegExp(`worker=${E2E_FLEET_WORKER_ID}`));
  await expect(detail(page)).toBeVisible();
  await expect(detail(page).getByText('Last heard from')).toBeVisible();
  await expect(detail(page).getByText('Running tasks')).toBeVisible();
  await expect(detail(page).getByText('Version', { exact: true })).toBeVisible();
  // The list stays beside the detail at a desktop width.
  await expect(row(page, E2E_FLEET_WORKER_ID)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Worker diagnostics' })).toBeVisible();
  await checkA11y('workers—a worker open beside the list');
});

test('a worker drains with a reason and resumes from its detail', async ({ page, checkA11y }) => {
  await page.goto(`/health/workers?worker=${E2E_FLEET_WORKER_ID}`);
  await expect(detail(page)).toBeVisible();
  await expect(detail(page).getByTestId('worker-health')).toHaveText('Healthy');

  await detail(page)
    .locator('.cinder-page-header')
    .getByRole('button', { name: 'Drain', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Drain worker' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Reason' }).fill('e2e worker drain');
  await checkA11y('workers—drain worker dialog');
  await dialog.getByRole('button', { name: 'Drain worker' }).click();
  await expect(dialog).toBeHidden();
  // The worker holds no task, so there is nothing to wait out.
  await expect(detail(page).getByTestId('worker-health')).toHaveText('Drained');

  // The builds table below has a Resume of its own; this one is the worker's, in its header.
  await detail(page)
    .locator('.cinder-page-header')
    .getByRole('button', { name: 'Resume', exact: true })
    .click();
  await expect(detail(page).getByTestId('worker-health')).toHaveText('Healthy');
});

test('a worker the server does not list reads as closed, with the way back', async ({ page }) => {
  await page.goto('/health/workers?worker=no-such-worker');
  await expect(page.getByRole('heading', { name: 'Worker closed' })).toBeVisible();
  await page.getByRole('button', { name: 'Back to all workers' }).click();
  await expect(page.getByRole('heading', { name: 'Choose a worker' })).toBeVisible();
  await expect(page).not.toHaveURL(/worker=/);
});

test('a worker’s detail promotes and rolls back its deployment’s builds', async ({
  page,
  checkA11y,
}) => {
  await page.goto(`/health/workers?worker=${E2E_LEDGER_WORKER_ID}`);
  const deployment = page.getByRole('region', { name: E2E_LEDGER_DEPLOYMENT_NAME, exact: true });
  await expect(deployment).toBeVisible();

  // A fresh server has no routing pointer yet; give it one so the builds can move.
  if (await deployment.getByText('No routing pointer yet').isVisible()) {
    const seeded = await page.request.post('/v1/worker-deployments/routing', {
      data: {
        deploymentName: E2E_LEDGER_DEPLOYMENT_NAME,
        currentBuildId: E2E_CURRENT_BUILD_ID,
        rampBasisPoints: 0,
        expectedGeneration: 0,
      },
    });
    expect(seeded.ok()).toBe(true);
    await page.reload();
  }

  const currentBuild = deployment
    .getByText('Current build', { exact: true })
    .locator('xpath=following-sibling::dd[1]');
  const generation = deployment
    .getByText('Rollout generation', { exact: true })
    .locator('xpath=following-sibling::dd[1]');
  await expect(currentBuild).toBeVisible();
  const before = (await currentBuild.textContent()) ?? '';
  const generationBefore = Number((await generation.textContent()) ?? '0');
  const target = before === E2E_PREVIOUS_BUILD_ID ? E2E_CURRENT_BUILD_ID : E2E_PREVIOUS_BUILD_ID;
  const targetRow = deployment.getByRole('row').filter({ hasText: target });
  await checkA11y('workers—a worker’s deployment before a routing change');

  // Whether moving to the other build is a promotion or a rollback is the server's reading of which
  // build is newer, so the button is named for the move it is.
  await targetRow.getByRole('button', { name: /^(Promote|Roll back to)$/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByText(new RegExp(`applies against routing generation ${generationBefore}`)),
  ).toBeVisible();
  // Nothing is applied until it is confirmed.
  await expect(currentBuild).toHaveText(before);
  await dialog
    .getByRole('button', { name: /^Confirm (promote build|roll back to build)$/ })
    .click();
  await expect(dialog).toBeHidden();
  await expect(currentBuild).toHaveText(target);
  await expect(generation).toHaveText(String(generationBefore + 1));

  // And back: the other move.
  await deployment
    .getByRole('row')
    .filter({ hasText: before })
    .getByRole('button', { name: /^(Promote|Roll back to)$/ })
    .click();
  await dialog
    .getByRole('button', { name: /^Confirm (promote build|roll back to build)$/ })
    .click();
  await expect(dialog).toBeHidden();
  await expect(currentBuild).toHaveText(before);
  await expect(generation).toHaveText(String(generationBefore + 2));
  await checkA11y('workers—a worker’s deployment after promote and roll back');
});
