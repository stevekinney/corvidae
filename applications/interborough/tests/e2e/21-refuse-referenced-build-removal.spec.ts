/**
 * COR-1582: a deployment build that durable work is bound to cannot be removed, and the console
 * says so with a true count. `e2e-versioned-build-1` carries one held run (see
 * `versioned-run-seed.ts`), started through the engine and bound to it by the server, so the
 * count and the refusal are what Weft computes from that run, not a stand-in.
 *
 * The build is drained to reach the reference rule, then resumed, so the specs that run after this
 * one find it ready as they always have.
 */
import type { Page } from '@playwright/test';

import { E2E_VERSIONED_DEPLOYMENT_NAME, E2E_VERSIONED_FIRST_BUILD_ID } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

function buildRow(page: Page) {
  return page
    .getByRole('region', { name: E2E_VERSIONED_DEPLOYMENT_NAME, exact: true })
    .getByRole('row')
    .filter({ hasText: E2E_VERSIONED_FIRST_BUILD_ID });
}

test('a build with a run bound to it shows the count, and removal is refused first as not draining, then as referenced', async ({
  page,
  checkA11y,
}) => {
  await page.goto('/health/workers?tab=deployments');
  await expect(buildRow(page)).toBeVisible();

  // The count is the held run, and a build that is not draining is first told to drain.
  await expect(buildRow(page).getByText('1 referenced · reachable')).toBeVisible();
  await expect(buildRow(page).getByRole('button', { name: 'Remove' })).toBeDisabled();
  await expect(
    buildRow(page).getByText(
      /Cannot remove: Build .* is ready, so it is not draining. Drain it first/,
    ),
  ).toBeVisible();

  // The server refuses the removal of a build that is not draining, with a reason a client can branch on.
  const notDraining = await page.request.post('/v1/worker-deployments/remove', {
    data: {
      deploymentName: E2E_VERSIONED_DEPLOYMENT_NAME,
      buildId: E2E_VERSIONED_FIRST_BUILD_ID,
    },
  });
  expect(notDraining.status()).toBe(409);
  expect(await notDraining.text()).toContain('not draining');

  // Drained, the build is refused for the run still bound to it.
  await buildRow(page).getByRole('button', { name: 'Drain' }).click();
  await page.getByRole('dialog').getByLabel('Reason').fill('e2e reference check');
  await page.getByRole('dialog').getByRole('button', { name: 'Drain build' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(buildRow(page).getByText('Draining', { exact: true })).toBeVisible();
  await expect(buildRow(page).getByRole('button', { name: 'Remove' })).toBeDisabled();
  await expect(
    buildRow(page).getByText(/Cannot remove: Build .* is still referenced by 1 piece of work/),
  ).toBeVisible();
  await checkA11y('workers—deployments, a draining build with a run bound to it');

  const referenced = await page.request.post('/v1/worker-deployments/remove', {
    data: {
      deploymentName: E2E_VERSIONED_DEPLOYMENT_NAME,
      buildId: E2E_VERSIONED_FIRST_BUILD_ID,
    },
  });
  expect(referenced.status()).toBe(409);
  expect(await referenced.text()).toContain('still referenced');

  // Resume the build so the specs after this one see it as they always have.
  await buildRow(page).getByRole('button', { name: 'Resume' }).click();
  await expect(buildRow(page).getByText('Ready', { exact: true })).toBeVisible();
  await expect(buildRow(page).getByText('1 referenced · reachable')).toBeVisible();
});
