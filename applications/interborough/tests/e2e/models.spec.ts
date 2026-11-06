/**
 * Settings › Models (COR-1960) against the real host: the providers it can call, the catalog of the
 * models they offer, and the decisions. The host starts with `anthropic` connected and restricted
 * to two models (`e2e-server.ts`), so `openai` and `gemini` are there to connect. The designed
 * states, and the captures of them for the design review, are in `settings-models.spec.ts`.
 *
 * The case that connects a provider starts by disconnecting it through the host, so it passes
 * whether or not an earlier run on a reused server left it connected. The last case changes the
 * decision model, which has no way back to unset, and `catalog` is what unset means. A restart is
 * not something this suite does; that a catalog edit and a connected provider survive one is
 * `src/host/host-provider-changes.test.ts`.
 */
import type { APIRequestContext, Page } from '@playwright/test';

import { MODELS_COPY, SETTINGS_COPY } from '../../src/app/copy.ts';
import { E2E_BASE_URL } from './e2e-constants.ts';
import { expect, loggedFailedResponse, test } from './fixtures.ts';
import { bureauCall } from './task-support.ts';

const WIDTHS = [375, 1280] as const;
const KEY = 'e2e-gemini-key-that-must-never-be-printed';

type Snapshot = {
  providers: { name: string; hasKey: boolean }[];
  models: { provider: string; model: string; off: boolean; contextWindowTokens: number }[];
};

async function snapshotOf(request: APIRequestContext): Promise<Snapshot> {
  const response = await request.get(`${E2E_BASE_URL}/host/providers`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as Snapshot;
}

/** Removes a provider's key through the host, which is a no-op for one that has none. */
async function disconnectThroughHost(request: APIRequestContext, name: string): Promise<void> {
  const response = await request.delete(`${E2E_BASE_URL}/host/providers/${name}`);
  expect(response.status()).toBe(200);
  const snapshot = await snapshotOf(request);
  expect(snapshot.providers.find((entry) => entry.name === name)?.hasKey).toBe(false);
}

const provider = (page: Page, name: string) => page.locator(`[data-provider="${name}"]`);
const modelRow = (page: Page, name: string) => page.locator(`[data-model="${name}"]`);

async function openModels(page: Page, width = 1280): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/settings/models');
  await expect(page.locator('[data-view="settings"]')).toHaveAttribute('data-state', 'ready');
  await expect(modelRow(page, 'anthropic/claude-sonnet-5')).toBeVisible();
}

for (const width of WIDTHS) {
  test(`shows Providers, Models and Decisions as one page with no tabs, at ${width} pixels`, async ({
    page,
    checkA11y,
  }) => {
    await openModels(page, width);
    await expect(page.locator('main h2')).toHaveText([
      MODELS_COPY.providers.heading,
      MODELS_COPY.models.heading,
      'Decisions',
    ]);
    await expect(page.getByRole('tab')).toHaveCount(0);
    // The section navigation is a column from 640px up and a Section select below it.
    if (width >= 640) {
      await expect(
        page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', {
          name: 'Models',
          exact: true,
        }),
      ).toHaveAttribute('aria-current', 'page');
    } else {
      await expect(page.getByRole('combobox', { name: 'Section' })).toHaveValue('/settings/models');
    }
    // A connected provider has a green Connected dot and Manage; one that is not has only Connect.
    await expect(provider(page, 'anthropic')).toContainText(MODELS_COPY.providers.connected);
    await expect(provider(page, 'anthropic').getByRole('button', { name: /Manage/ })).toBeVisible();
    await expect(provider(page, 'anthropic').getByRole('button', { name: /Connect/ })).toHaveCount(
      0,
    );
    await expect(provider(page, 'openai')).not.toContainText(MODELS_COPY.providers.connected);
    await expect(page.locator('main')).not.toContainText(/not connected/i);
    await checkA11y(`Settings › Models at ${width}px`);
  });
}

test('lists the models of the connected providers as a read-only table with what Allowed models permits', async ({
  page,
}) => {
  await openModels(page);
  const table = page.getByRole('table', { name: MODELS_COPY.models.tableLabel });
  await expect(table.getByRole('columnheader')).toHaveText([
    'Model',
    'Abilities',
    'Context',
    'Allowed',
  ]);
  const sonnet = modelRow(page, 'anthropic/claude-sonnet-5');
  await expect(sonnet).toContainText(/\d+K|\d+(\.\d)?M/);
  await expect(sonnet).toContainText('Tools');
  await expect(sonnet).toContainText(MODELS_COPY.models.allowed);
  await expect(sonnet.locator('code')).toHaveText('claude-sonnet-5');
  // It only reads: models are allowed under Allowed models, not here.
  await expect(page.getByRole('switch')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Add a model|Save models|Edit/ })).toHaveCount(0);
});

test('connects a provider, adds its models with no restart, and never prints the key', async ({
  page,
  pageErrors,
  request,
}) => {
  pageErrors.expect({
    pattern: loggedFailedResponse(400, /\/host\/providers\/gemini/),
    reason: 'the test answers the connect request with a refusal, to see what the page shows',
  });
  // A server that was reused may already hold the key; the case starts from not connected.
  await disconnectThroughHost(request, 'gemini');
  await openModels(page);
  const row = provider(page, 'gemini');
  await expect(row.getByRole('button', { name: /Manage/ })).toHaveCount(0);
  await row.getByRole('button', { name: /Connect/ }).click();
  const dialog = page.getByRole('dialog');
  const field = dialog.locator('input[type="password"]');
  await expect(field).toBeVisible();

  // The key is asked for before anything is sent.
  await dialog.getByRole('button', { name: /^(Connect|Replace key)$/ }).click();
  await expect(dialog).toContainText(MODELS_COPY.connectDialog.keyRequired);

  // A refusal says the key could not be saved, and leaves neither the key nor an echo of it.
  await page.route('**/host/providers/gemini', (route) =>
    route.fulfill({
      status: 400,
      json: { error: 'invalid', field: 'apiKey', message: `Invalid apiKey ${KEY}.` },
    }),
  );
  await field.fill(KEY);
  await dialog.getByRole('button', { name: /^(Connect|Replace key)$/ }).click();
  await expect(page.getByTestId('provider-connect-failure')).toBeVisible();
  await expect(field).toHaveValue('');
  expect(await page.content()).not.toContain(KEY);
  await page.unroute('**/host/providers/gemini');

  // Saved for real, the provider is Connected and its models are in the catalog.
  await field.fill(KEY);
  await dialog.getByRole('button', { name: /^(Connect|Replace key)$/ }).click();
  await expect(dialog).toBeHidden();
  await expect(row).toContainText(MODELS_COPY.providers.connected);
  await expect(row.getByRole('button', { name: /Manage/ })).toBeVisible();
  await expect(page.locator('[data-model^="gemini/"]').first()).toBeVisible();
  expect(await page.content()).not.toContain(KEY);

  // Neither the page's reads of the host nor the Bureau's catalog carry it.
  const snapshot = await snapshotOf(request);
  expect(JSON.stringify(snapshot)).not.toContain(KEY);
  expect(snapshot.providers.find((entry) => entry.name === 'gemini')?.hasKey).toBe(true);
  expect(snapshot.models.some((entry) => entry.provider === 'gemini')).toBe(true);
  const agentCatalog = await bureauCall(request, 'bureau.agents.catalog', {});
  expect(JSON.stringify(agentCatalog)).not.toContain(KEY);
  expect(JSON.stringify(agentCatalog)).toContain('gemini');

  // Reopening Manage shows an empty field.
  await row.getByRole('button', { name: /Manage/ }).click();
  await expect(dialog.locator('input[type="password"]')).toHaveValue('');
  await dialog.getByRole('button', { name: MODELS_COPY.connectDialog.cancel }).click();
  await expect(dialog).toBeHidden();

  // Remove key asks first, and Cancel leaves the key alone.
  await row.getByRole('button', { name: /Manage/ }).click();
  await dialog.getByRole('button', { name: MODELS_COPY.connectDialog.removeKey }).click();
  await expect(dialog).toContainText(MODELS_COPY.disconnectDialog.title('Gemini'));
  await expect(
    dialog.getByRole('button', { name: MODELS_COPY.disconnectDialog.confirm }),
  ).toBeEnabled();
  await dialog.getByRole('button', { name: MODELS_COPY.disconnectDialog.cancel }).click();
  await expect(dialog).toBeHidden();
  const kept = await snapshotOf(request);
  expect(kept.providers.find((entry) => entry.name === 'gemini')?.hasKey).toBe(true);

  // Confirmed, the key is gone: the provider offers Connect again and its models leave the catalog.
  await row.getByRole('button', { name: /Manage/ }).click();
  await dialog.getByRole('button', { name: MODELS_COPY.connectDialog.removeKey }).click();
  await dialog.getByRole('button', { name: MODELS_COPY.disconnectDialog.confirm }).click();
  await expect(dialog).toBeHidden();
  await expect(row.getByRole('button', { name: /Connect/ })).toBeVisible();
  await expect(row).not.toContainText(MODELS_COPY.providers.connected);
  await expect(page.locator('[data-model^="gemini/"]')).toHaveCount(0);
  const after = await snapshotOf(request);
  expect(after.providers.find((entry) => entry.name === 'gemini')?.hasKey).toBe(false);
  expect(after.models.some((entry) => entry.provider === 'gemini')).toBe(false);
  expect(JSON.stringify(after)).not.toContain(KEY);
  expect(await page.content()).not.toContain(KEY);
});

test('switches the decision model, and the Bureau holds the choice', async ({ page, request }) => {
  await openModels(page);
  const row = page.locator('[data-setting="decisions.model"]');
  await expect(row).toBeVisible();
  // The three decision settings are here, and are not on General.
  await expect(page.locator('[data-setting^="decisions."]')).toHaveCount(3);
  await page.goto('/settings');
  await expect(page.locator('[data-setting="tools.wakeup"]')).toBeVisible();
  await expect(page.locator('[data-setting^="decisions."]')).toHaveCount(0);

  await openModels(page);
  await row.getByRole('combobox').selectOption('catalog');
  // It saves as the field is left: the row says so, and there is no page-level Save.
  await expect(row).toContainText('Saved');
  await expect(page.getByRole('button', { name: SETTINGS_COPY.saveAction })).toHaveCount(0);
  const settings = (await bureauCall(request, 'bureau.settings.get', {})) as {
    values: Record<string, unknown>;
  };
  expect(settings.values['decisions.model']).toBe('catalog');
});
