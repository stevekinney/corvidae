/**
 * Settings › Models (COR-1960) against the real host: the providers it can call, the catalog of the
 * models they offer, and the decisions. The host starts with `anthropic` connected and restricted
 * to two models (`e2e-server.ts`), so `openai` and `gemini` are there to connect.
 *
 * The host has no way to disconnect a provider, so the case that connects one is written to pass
 * whether or not an earlier run on this server already did: it uses Manage when it finds one.
 * Every case but the last puts back what it changed; the decision model has no way back to unset,
 * and `catalog` is what unset means. A restart is not something this suite does; that a catalog
 * edit and a connected provider survive one is `src/host/host-provider-changes.test.ts`.
 */
import type { APIRequestContext, Locator, Page } from '@playwright/test';

import { MODELS_COPY, SETTINGS_COPY } from '../../src/app/copy.ts';
import { E2E_BASE_URL } from './e2e-constants.ts';
import { expect, loggedFailedResponse, test } from './fixtures.ts';
import { bureauCall } from './task-support.ts';

const WIDTHS = [375, 1280] as const;
const KEY = 'e2e-gemini-key-that-must-never-be-printed';

type Edit = { provider: string; model: string; off?: boolean; contextWindowTokens?: number };
type Snapshot = {
  providers: { name: string; hasKey: boolean }[];
  catalog: Edit[];
  models: { provider: string; model: string; off: boolean; contextWindowTokens: number }[];
};

async function snapshotOf(request: APIRequestContext): Promise<Snapshot> {
  const response = await request.get(`${E2E_BASE_URL}/host/providers`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as Snapshot;
}

/** The catalog edits the host holds now. */
async function editsOf(request: APIRequestContext): Promise<Edit[]> {
  const snapshot = await snapshotOf(request);
  return snapshot.catalog;
}

async function putEdits(request: APIRequestContext, edits: readonly Edit[]): Promise<void> {
  const response = await request.put(`${E2E_BASE_URL}/host/catalog`, { data: { edits } });
  expect(response.status()).toBe(200);
}

/** Replaces a number field's value the way a person does: select it, type, and leave the field. */
async function typeNumber(field: Locator, value: string): Promise<void> {
  await field.click();
  await field.press('ControlOrMeta+a');
  await field.pressSequentially(value);
  await field.press('Tab');
}

const provider = (page: Page, name: string) => page.locator(`[data-provider="${name}"]`);
const modelRow = (page: Page, name: string) => page.locator(`[data-model="${name}"]`);
const saveModels = (page: Page) => page.getByRole('button', { name: MODELS_COPY.models.save });

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
    await expect(
      page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', {
        name: 'Models',
      }),
    ).toHaveAttribute('aria-current', 'page');
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

test('lists the models of the connected providers with their context, abilities and price', async ({
  page,
}) => {
  await openModels(page);
  const sonnet = modelRow(page, 'anthropic/claude-sonnet-5');
  await expect(sonnet).toContainText(/\d+K|\d+(\.\d)?M/);
  await expect(sonnet).toContainText(MODELS_COPY.models.abilities.tools);
  await expect(sonnet).toContainText(/\$[\d.]+ in, \$[\d.]+ out/);
  await expect(sonnet.getByRole('switch')).toBeChecked();
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
  await openModels(page);
  const row = provider(page, 'gemini');
  await row.getByRole('button', { name: /Connect|Manage/ }).click();
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
});

test('turns a model off and edits a row, and both are still there after a reload', async ({
  page,
  request,
}) => {
  const before = await editsOf(request);
  try {
    await openModels(page);
    await modelRow(page, 'anthropic/claude-haiku-4-5').getByRole('switch').click();
    await modelRow(page, 'anthropic/claude-sonnet-5').getByRole('button', { name: /Edit/ }).click();
    const dialog = page.getByRole('dialog');
    await typeNumber(
      dialog.getByRole('spinbutton', { name: MODELS_COPY.rowDialog.contextWindow }),
      '100000',
    );
    await typeNumber(
      dialog.getByRole('spinbutton', { name: MODELS_COPY.rowDialog.maxOutput }),
      '8000',
    );
    await dialog.getByRole('button', { name: MODELS_COPY.rowDialog.apply }).click();
    await expect(dialog).toBeHidden();
    await expect(modelRow(page, 'anthropic/claude-sonnet-5')).toContainText('100K');
    // Nothing is stored until Save.
    expect(await editsOf(request)).toEqual(before);

    await saveModels(page).click();
    await expect(page.getByText(MODELS_COPY.models.saved)).toBeVisible();
    await expect(saveModels(page)).toBeDisabled();

    await page.reload();
    await expect(modelRow(page, 'anthropic/claude-haiku-4-5')).toHaveAttribute('data-off', 'true');
    await expect(
      modelRow(page, 'anthropic/claude-haiku-4-5').getByRole('switch'),
    ).not.toBeChecked();
    await expect(modelRow(page, 'anthropic/claude-sonnet-5')).toContainText('100K');

    // The host holds it: it is in the configuration, and the catalog it serves.
    const after = await snapshotOf(request);
    expect(after.models.find((entry) => entry.model === 'claude-haiku-4-5')?.off).toBe(true);
    expect(
      after.models.find((entry) => entry.model === 'claude-sonnet-5')?.contextWindowTokens,
    ).toBe(100_000);
  } finally {
    await putEdits(request, before);
  }
  const restored = await snapshotOf(request);
  expect(restored.models.find((entry) => entry.model === 'claude-haiku-4-5')?.off).toBe(false);
});

test('refuses a model the provider’s allowlist leaves out', async ({ page, request }) => {
  const before = await editsOf(request);
  try {
    await openModels(page);
    await page.getByRole('button', { name: MODELS_COPY.models.add }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(MODELS_COPY.rowDialog.model).fill('claude-e2e-next');
    await dialog.getByRole('button', { name: MODELS_COPY.rowDialog.add }).click();
    await expect(dialog.getByText(MODELS_COPY.rowDialog.modelNotAllowed)).toBeVisible();
    await expect(modelRow(page, 'anthropic/claude-e2e-next')).toHaveCount(0);
  } finally {
    await putEdits(request, before);
  }
});

test('adds a model the built-in list lacks, then takes it out', async ({ page, request }) => {
  const before = await editsOf(request);
  // Gemini has no allowlist, so the host serves what is added; connecting is safe to repeat.
  const connected = await request.put(`${E2E_BASE_URL}/host/providers/gemini`, {
    data: { apiKey: KEY },
  });
  expect(connected.ok()).toBe(true);
  try {
    await openModels(page);
    await page.getByRole('button', { name: MODELS_COPY.models.add }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(MODELS_COPY.rowDialog.provider).selectOption('gemini');
    await dialog.getByLabel(MODELS_COPY.rowDialog.model).fill('gemini-e2e-next');
    await dialog.getByRole('button', { name: MODELS_COPY.rowDialog.add }).click();
    await expect(dialog).toBeHidden();
    await expect(modelRow(page, 'gemini/gemini-e2e-next')).toContainText(MODELS_COPY.models.added);
    await saveModels(page).click();
    await expect(page.getByText(MODELS_COPY.models.saved)).toBeVisible();
    await page.reload();
    await expect(modelRow(page, 'gemini/gemini-e2e-next')).toBeVisible();
    const snapshot = await snapshotOf(request);
    expect(
      snapshot.models.some(
        (entry) => entry.provider === 'gemini' && entry.model === 'gemini-e2e-next',
      ),
    ).toBe(true);
  } finally {
    await putEdits(request, before);
  }
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
  await page.getByRole('button', { name: SETTINGS_COPY.saveAction }).click();
  await expect(page.getByText(SETTINGS_COPY.saved.title)).toBeVisible();
  const settings = (await bureauCall(request, 'bureau.settings.get', {})) as {
    values: Record<string, unknown>;
  };
  expect(settings.values['decisions.model']).toBe('catalog');
});
