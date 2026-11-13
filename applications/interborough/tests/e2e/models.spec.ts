/**
 * Settings › Models (COR-1960) against the real host: the providers it can call, the catalog of the
 * models they offer, and the decisions. The host starts with `anthropic` connected and restricted
 * to two models (`e2e-server.ts`), so `openai` and `gemini` are there to connect. The designed
 * states, and the captures of them for the design review, are in `settings-models.spec.ts`.
 *
 * The case that connects a provider starts by disconnecting it through the host, so it passes
 * whether or not an earlier run on a reused server left it connected. The last case changes the
 * decision model, which has no way back to unset, and puts back the default, `typesafe/jev`. A restart is
 * not something this suite does; that a catalog edit and a connected provider survive one is
 * `src/host/host-provider-changes.test.ts`.
 */
import type { APIRequestContext, Page } from '@playwright/test';

import { MODELS_COPY } from '../../src/app/copy/models.ts';
import { SETTINGS_COPY } from '../../src/app/copy/settings.ts';
import { E2E_BASE_URL } from './e2e-constants.ts';
import { expect, loggedFailedResponse, test } from './fixtures.ts';
import { bureauCall } from './task-support.ts';

const WIDTHS = [375, 1280] as const;
/** A key the stub provider refuses carries `rejected-key` (`STUB_PROVIDER_REJECTED_KEY_MARKER`). */
const KEY = 'e2e-gemini-key-that-must-never-be-printed';

type Snapshot = {
  configurationRevision: string | null;
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
  const snapshot = await snapshotOf(request);
  const response = await request.delete(`${E2E_BASE_URL}/host/providers/${name}`, {
    data: {
      operationId: crypto.randomUUID(),
      expectedRevision: snapshot.configurationRevision,
    },
  });
  expect(response.status()).toBe(200);
  const after = await snapshotOf(request);
  expect(after.providers.find((entry) => entry.name === name)?.hasKey).toBe(false);
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

test('connects a provider after testing its key, adds its models with no restart, and never prints the key', async ({
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
  const dialog = page.getByRole('dialog', { name: MODELS_COPY.connectDialog.title('Gemini') });
  // A refused key shows in its masked form as text until the field is focused again, so the field is
  // found by its label, not by being a password input.
  const field = dialog.getByLabel(MODELS_COPY.connectDialog.keyLabel);
  await expect(field).toBeVisible();
  await expect(dialog).toContainText(MODELS_COPY.connectDialog.subtitle.idle);

  // The key is asked for before anything is sent, at the field.
  await dialog.getByRole('button', { name: MODELS_COPY.connectDialog.connect }).click();
  await expect(dialog).toContainText(MODELS_COPY.connectDialog.keyRequired);

  // A key the provider refuses is worded at the field, and nothing is saved.
  await field.fill(`${KEY}-rejected-key`);
  await dialog.getByRole('button', { name: MODELS_COPY.connectDialog.connect }).click();
  await expect(dialog).toContainText(MODELS_COPY.keyTest.rejected('Gemini', 401));
  await expect(dialog).toContainText(MODELS_COPY.connectDialog.subtitle.failed);
  const refused = await snapshotOf(request);
  expect(refused.providers.find((entry) => entry.name === 'gemini')?.hasKey).toBe(false);

  // A key the provider accepts but the host cannot save says the key could not be saved, and
  // leaves no echo of it.
  await page.route('**/host/providers/gemini', (route) =>
    route.fulfill({
      status: 400,
      json: { error: 'invalid', field: 'apiKey', message: `Invalid apiKey ${KEY}.` },
    }),
  );
  // Going back into the field shows the refused key instead of its mask, so the field is entered
  // first and then replaced whole.
  await field.focus();
  await field.fill(KEY);
  await dialog.getByRole('button', { name: MODELS_COPY.connectDialog.connect }).click();
  await expect(page.getByTestId('provider-connect-failure')).toBeVisible();
  expect(await dialog.innerText()).not.toContain(KEY);
  await page.unroute('**/host/providers/gemini');

  // Saved for real, the dialog says Connected with a single Done, and the provider is Connected
  // with its models in the catalog.
  await field.fill(KEY);
  await dialog.getByRole('button', { name: MODELS_COPY.connectDialog.connect }).click();
  await expect(page.getByTestId('provider-connect-success')).toContainText(
    MODELS_COPY.connectDialog.connectedTitle,
  );
  await expect(dialog).toContainText(MODELS_COPY.connectDialog.subtitle.connected);
  await dialog.getByRole('button', { name: MODELS_COPY.connectDialog.done }).click();
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

  // Manage names the provider, never shows the key, and offers Remove key, Replace key and Done.
  await row.getByRole('button', { name: /Manage/ }).click();
  const manage = page.getByRole('dialog', { name: 'Gemini' });
  await expect(manage).toContainText(MODELS_COPY.manageDialog.connected);
  await expect(manage.locator('input')).toHaveCount(0);
  await manage.getByRole('button', { name: MODELS_COPY.manageDialog.done }).click();
  await expect(manage).toBeHidden();

  // Replace key tests the new key first: a refused one leaves the old key in use.
  await row.getByRole('button', { name: /Manage/ }).click();
  await manage.getByRole('button', { name: MODELS_COPY.manageDialog.replaceKey }).click();
  const replace = page.getByRole('dialog', { name: MODELS_COPY.replaceDialog.title('Gemini') });
  await expect(replace).toContainText(MODELS_COPY.replaceDialog.subtitle);
  await replace.getByLabel(MODELS_COPY.replaceDialog.keyLabel).fill(`${KEY}-rejected-key`);
  await replace.getByRole('button', { name: MODELS_COPY.replaceDialog.replace }).click();
  await expect(replace).toContainText(MODELS_COPY.keyTest.rejected('Gemini', 401));
  const old = await snapshotOf(request);
  expect(old.providers.find((entry) => entry.name === 'gemini')?.hasKey).toBe(true);
  await replace.getByLabel(MODELS_COPY.replaceDialog.keyLabel).fill(`${KEY}-second`);
  await replace.getByRole('button', { name: MODELS_COPY.replaceDialog.replace }).click();
  await expect(replace).toBeHidden();
  expect(await page.content()).not.toContain(`${KEY}-second`);

  // Remove key asks first, and Cancel leaves the key alone.
  await row.getByRole('button', { name: /Manage/ }).click();
  await manage.getByRole('button', { name: MODELS_COPY.manageDialog.removeKey }).click();
  const remove = page.getByRole('dialog', { name: MODELS_COPY.removeDialog.title('Gemini') });
  await expect(
    remove.getByRole('button', { name: MODELS_COPY.removeDialog.confirm }),
  ).toBeEnabled();
  await remove.getByRole('button', { name: MODELS_COPY.removeDialog.cancel }).click();
  await expect(remove).toBeHidden();
  const kept = await snapshotOf(request);
  expect(kept.providers.find((entry) => entry.name === 'gemini')?.hasKey).toBe(true);

  // Confirmed, the key is gone: the provider offers Connect again and its models leave the catalog.
  await row.getByRole('button', { name: /Manage/ }).click();
  await manage.getByRole('button', { name: MODELS_COPY.manageDialog.removeKey }).click();
  await remove.getByRole('button', { name: MODELS_COPY.removeDialog.confirm }).click();
  await expect(remove).toBeHidden();
  await expect(row.getByRole('button', { name: /Connect/ })).toBeVisible();
  await expect(row).not.toContainText(MODELS_COPY.providers.connected);
  await expect(page.locator('[data-model^="gemini/"]')).toHaveCount(0);
  const after = await snapshotOf(request);
  expect(after.providers.find((entry) => entry.name === 'gemini')?.hasKey).toBe(false);
  expect(after.models.some((entry) => entry.provider === 'gemini')).toBe(false);
  expect(JSON.stringify(after)).not.toContain(KEY);
  expect(await page.content()).not.toContain(KEY);
});

type Settings = { values: Record<string, unknown>; revision: number };

/** Sets the decision model through the Bureau, as a person's own save would. */
async function setDecisionModel(request: APIRequestContext, model: string): Promise<void> {
  const current = (await bureauCall(request, 'bureau.settings.get', {})) as Settings;
  await bureauCall(request, 'bureau.settings.update', {
    patch: { 'decisions.model': model },
    expectedRevision: current.revision,
  });
}

test('switches the decision model, and the Bureau holds the choice', async ({ page, request }) => {
  // The host's TypeSafe plugin has no key, so the fallback model answers: the row says so and
  // offers Connect TypeSafe beside its select, and the two settings after it stay editable.
  await openModels(page);
  const row = page.locator('[data-setting="decisions.model"]');
  await expect(row.getByRole('link', { name: MODELS_COPY.decisions.model.connect })).toBeVisible();
  await expect(row.getByRole('combobox')).toBeEnabled();
  await expect(page.locator('[data-setting="decisions.fallbackModel"] select')).toBeEnabled();
  // The three decision settings are here, and are not on General.
  await expect(page.locator('[data-setting^="decisions."]')).toHaveCount(3);
  await page.goto('/settings');
  await expect(page.locator('[data-setting="tools.wakeup"]')).toBeVisible();
  await expect(page.locator('[data-setting^="decisions."]')).toHaveCount(0);

  // A person who chose a catalog row of their own keeps their select, whatever TypeSafe's plugin
  // says. `catalog` is no longer a choice (COR-2154), and the default the host starts with is
  // `typesafe/jev`, which is what the last step puts back.
  await setDecisionModel(request, 'anthropic/claude-haiku-4-5');
  try {
    await openModels(page);
    await expect(row.getByRole('combobox')).toHaveValue('anthropic/claude-haiku-4-5');
    await row.getByRole('combobox').selectOption('typesafe/jev');
    // It saves as the field is left, with no page-level Save; the row then says the fallback model
    // answers until TypeSafe's key is saved.
    await expect(page.getByRole('button', { name: SETTINGS_COPY.saveAction })).toHaveCount(0);
    await expect
      .poll(async () => {
        const settings = (await bureauCall(request, 'bureau.settings.get', {})) as Settings;
        return settings.values['decisions.model'];
      })
      .toBe('typesafe/jev');
    await expect(
      row.getByRole('link', { name: MODELS_COPY.decisions.model.connect }),
    ).toBeVisible();
  } finally {
    await setDecisionModel(request, 'typesafe/jev');
  }
});
