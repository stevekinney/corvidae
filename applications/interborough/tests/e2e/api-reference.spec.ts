/**
 * Settings › API reference as a person meets it: one page with a side list of four groups, not a
 * tab strip, and each group filled from what the running server answers. The seeded server has
 * registered `order-processing`, serves its OpenAPI, OpenRPC and AsyncAPI documents, and treats the
 * one local caller as holding every scope. A failed read must be an error in its group, never an
 * empty one, so the last test fails a discovery document and reads the group's alert.
 */
import { expect, loggedFailedResponse, test } from './fixtures.ts';

const GROUPS = ['Operations', 'Discovery documents', 'Your scopes', 'Workflow sources'] as const;

test('lists the four groups in a side list and has no tab strip', async ({ page }) => {
  await page.goto('/settings/api-reference');

  const list = page.getByRole('navigation', { name: 'API reference groups' });
  await expect(list.getByRole('link')).toHaveText([...GROUPS]);
  await expect(list.getByRole('link', { name: 'Operations' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByRole('tablist')).toHaveCount(0);
  await expect(page.getByRole('tab')).toHaveCount(0);
});

test('Operations lists the server’s operations from its discovery documents', async ({ page }) => {
  await page.goto('/settings/api-reference?group=operations');
  const panel = page.locator('[data-group-panel="operations"]');
  await expect(panel.getByRole('table', { name: 'Operation catalog' })).toBeVisible();
  await expect(panel.getByRole('rowheader', { name: 'weft.alerts.list' })).toBeVisible();
  await expect(panel.getByRole('alert')).toHaveCount(0);

  // A search that matches nothing is a filtered empty state with a way back, not a sentence.
  await panel.getByRole('searchbox', { name: 'Search operations' }).fill('no-such-operation-name');
  const empty = panel.getByRole('group', { name: 'No operations match' });
  await expect(empty).toBeVisible();
  await empty.getByRole('button', { name: 'Show all operations' }).click();
  await expect(panel.getByRole('rowheader', { name: 'weft.alerts.list' })).toBeVisible();
});

test('Discovery documents shows each document the server serves', async ({ page }) => {
  await page.goto('/settings/api-reference');
  await page
    .getByRole('navigation', { name: 'API reference groups' })
    .getByRole('link', { name: 'Discovery documents' })
    .click();
  await expect(page).toHaveURL(/group=discovery/);

  const panel = page.locator('[data-group-panel="discovery"]');
  await expect(panel.getByRole('table', { name: 'OpenAPI operations' })).toBeVisible();

  await panel.getByRole('radio', { name: 'OpenRPC' }).click();
  await expect(page).toHaveURL(/document=openrpc/);
  await expect(panel.getByRole('table', { name: 'OpenRPC methods' })).toBeVisible();

  await panel.getByRole('radio', { name: 'AsyncAPI' }).click();
  await expect(page).toHaveURL(/document=asyncapi/);
  await expect(panel.getByRole('table', { name: 'AsyncAPI channels' })).toBeVisible();
  await expect(panel.getByRole('alert')).toHaveCount(0);
});

test('Your scopes names the caller and the scopes it holds', async ({ page }) => {
  await page.goto('/settings/api-reference?group=scopes');
  const panel = page.locator('[data-group-panel="scopes"]');
  await expect(panel.getByTestId('principal-subject')).toHaveText('anonymous:local');
  await expect(panel.getByText('Granted scopes')).toBeVisible();
  await expect(panel.getByText('system:read', { exact: true })).toBeVisible();
});

test('Workflow sources lists the registered workflow types and the dynamic sources', async ({
  page,
}) => {
  await page.goto('/settings/api-reference?group=sources');
  const panel = page.locator('[data-group-panel="sources"]');
  await expect(panel.getByRole('button', { name: /order-processing/ })).toBeVisible();
  await expect(panel.getByRole('region', { name: 'Workflow sources', exact: true })).toBeVisible();
  await expect(panel.getByRole('region', { name: 'Registered source list' })).toBeVisible();
});

test('a discovery document that fails is an error in its group, and the side list stays', async ({
  page,
  pageErrors,
}) => {
  pageErrors.expect({
    pattern: loggedFailedResponse(500, /openapi\.json/),
    reason: 'The test answers the OpenAPI document with a 500 to read the error the group shows.',
  });
  await page.route('**/openapi.json', (route) => route.fulfill({ status: 500, body: 'nope' }));
  await page.goto('/settings/api-reference?group=operations');
  const panel = page.locator('[data-group-panel="operations"]');
  await expect(panel.getByRole('alert')).toBeVisible();
  await expect(panel.getByRole('table')).toHaveCount(0);
  await expect(
    page
      .getByRole('navigation', { name: 'API reference groups' })
      .getByRole('link', { name: 'Workflow sources' }),
  ).toBeVisible();
});
