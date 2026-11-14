/**
 * Settings › Models (board SettingsShell, "Models, /settings/models", "Models, provider
 * connected" and "More states"). The sample world has no provider connected, so its page is the
 * empty one: three providers with Connect, an empty catalog and the Decisions waiting on TypeSafe.
 * The main host has Anthropic connected; its page is captured with the sample world's three Anthropic
 * models (the host's own list is longer), and with the list of models failing right after a connect.
 *
 * Each captioned state is captured for the design review (`design-review-capture.ts`) at the widths
 * Settings is drawn at.
 */
import type { Page } from '@playwright/test';

import { MODELS_COPY } from '../../src/app/copy/models.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_BASE_URL, E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, loggedFailedResponse, test } from './fixtures.ts';
import { sampleCatalogModels, withSampleCatalog } from './sample-catalog.ts';

const SOURCE = 'settings-models.spec.ts';
const ROUTE = '/settings/models';

/** Captures the screen at the three widths Settings is drawn at: desktop, tablet and phone. */
async function captureAtEveryWidth(
  page: Page,
  state: string,
  ready?: (page: Page) => Promise<void>,
) {
  for (const width of [1280, 768, 375] as const) {
    await page.setViewportSize({ width, height: 900 });
    await ready?.(page);
    await captureForDesignReview(page, { route: ROUTE, state, source: SOURCE, ready });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function open(page: Page, origin: string) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${origin}${ROUTE}`);
  await expect(page.locator('[data-view="settings"]')).toHaveAttribute('data-state', 'ready');
  await expect(page.getByRole('heading', { level: 1, name: 'Models' })).toBeVisible();
}

const providerRow = (page: Page, name: string) => page.locator(`[data-provider="${name}"]`);

test.describe('Settings › Models, no provider connected', () => {
  test('is Providers, an empty Models and Decisions waiting on TypeSafe, under one heading', async ({
    page,
    checkA11y,
  }) => {
    await open(page, E2E_SHOWCASE_URL);
    await expect(page.getByText(MODELS_COPY.intro)).toBeVisible();
    await expect(page.locator('main h2')).toHaveText(['Providers', 'Models', 'Decisions']);
    await expect(page.getByRole('tab')).toHaveCount(0);

    // The shell: breadcrumb, Models active in the section navigation, a 170px column.
    const breadcrumb = page.getByRole('navigation', { name: 'Breadcrumb' });
    await expect(breadcrumb).toContainText('Settings');
    await expect(breadcrumb).toContainText('Models');
    const nav = page.getByRole('navigation', { name: 'Settings sections' });
    await expect(nav.getByRole('link', { name: 'Models', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const navigationBox = await nav.boundingBox();
    expect(Math.round(navigationBox?.width ?? 0)).toBe(170);

    // Providers: only providers with plugins, in order, each with Connect and nothing else.
    await expect(page.getByText(MODELS_COPY.providers.description)).toBeVisible();
    await expect(page.locator('[data-provider]')).toHaveCount(3);
    const names = ['Anthropic', 'OpenAI', 'Gemini'];
    const taglines = ['Claude models', 'GPT models', 'Gemini models'];
    for (const [index, key] of ['anthropic', 'openai', 'gemini'].entries()) {
      const row = providerRow(page, key);
      await expect(row).toContainText(names[index] ?? '');
      await expect(row).toContainText(taglines[index] ?? '');
      await expect(row.getByRole('button')).toHaveText('Connect');
      await expect(row).not.toContainText(/not connected|needs setup/i);
    }
    // No letter avatars, and no provider banner on the page.
    await expect(page.locator('[data-provider] .cinder-avatar')).toHaveCount(0);
    await expect(page.getByText(/no model provider connected/i)).toHaveCount(0);

    // The empty catalog, with a quiet link up to Providers.
    await expect(page.getByText(MODELS_COPY.models.emptyDescription)).toBeVisible();
    const empty = page.getByTestId('models-empty');
    await expect(empty).toContainText(MODELS_COPY.models.empty.title);
    await expect(empty).toContainText(MODELS_COPY.models.empty.description);
    await expect(empty.getByRole('button')).toHaveCount(0);
    await expect(empty.getByRole('link', { name: MODELS_COPY.models.empty.action })).toBeVisible();

    // Decisions: with no provider connected nothing can answer until TypeSafe is, yet every row stays editable.
    await expect(page.getByText(MODELS_COPY.decisions.description)).toBeVisible();
    const model = page.locator('[data-setting="decisions.model"]');
    await expect(model).toContainText('Decision model');
    await expect(model).toContainText(MODELS_COPY.decisions.model.nothingAnswers);
    await expect(model.getByRole('combobox')).toBeEnabled();
    await expect(model.getByRole('link', { name: 'Connect TypeSafe' })).toBeVisible();
    const fallback = page.locator('[data-setting="decisions.fallbackModel"]');
    await expect(fallback).toContainText('Fallback model');
    await expect(fallback.getByRole('combobox')).toBeEnabled();
    const limit = page.locator('[data-setting="decisions.maximumPerTask"]');
    await expect(limit).toContainText('Maximum per task');
    await expect(limit.getByRole('spinbutton')).toBeEnabled();
    await expect(limit.getByRole('spinbutton')).toHaveValue('10');

    await checkA11y('settings models, no provider, at 1280px');
    await captureAtEveryWidth(page, 'no-provider');
  });

  test('takes the empty catalog’s link to Providers on the same page', async ({ page }) => {
    await open(page, E2E_SHOWCASE_URL);
    await page.getByRole('link', { name: MODELS_COPY.models.empty.action }).click();
    await expect(page).toHaveURL(new RegExp(`${ROUTE}$`));
    await expect(page.locator('#ib-models-providers')).toBeFocused();
  });

  test('opens the plugin that holds TypeSafe’s key from Connect TypeSafe', async ({ page }) => {
    await open(page, E2E_SHOWCASE_URL);
    await page.getByRole('link', { name: 'Connect TypeSafe' }).click();
    await expect(page).toHaveURL(/\/settings\/plugins\?plugin=typesafe$/);
  });
});

test.describe('Settings › Models, provider connected', () => {
  test('lists the sample world’s three models with their abilities, context and what is allowed', async ({
    page,
    checkA11y,
  }) => {
    await withSampleCatalog(page);
    await withDecisionRows(page);
    await open(page, E2E_BASE_URL);
    await expect(page.getByText(MODELS_COPY.providers.connectedDescription)).toBeVisible();
    const anthropic = providerRow(page, 'anthropic');
    await expect(anthropic).toContainText('Connected');
    await expect(anthropic.getByRole('button')).toHaveText('Manage');

    await expect(page.getByText(MODELS_COPY.models.description)).toBeVisible();
    const table = page.getByRole('table', { name: MODELS_COPY.models.tableLabel });
    await expect(table.getByRole('columnheader')).toHaveText([
      'Model',
      'Abilities',
      'Context',
      'Allowed',
    ]);
    const rows = table.locator('tbody tr');
    await expect(rows).toHaveCount(3);
    const expected = [
      ['Claude Opus 5.5', 'claude-opus-5-5', 'Tools, images', '1M'],
      ['Claude Sonnet 5.5', 'claude-sonnet-5-5', 'Tools, images', '1M'],
      ['Claude Haiku 5.5', 'claude-haiku-5-5', 'Tools', '200K'],
    ] as const;
    for (const [index, [name, identifier, abilities, context]] of expected.entries()) {
      const row = rows.nth(index);
      await expect(row.locator('td').nth(0)).toContainText(name);
      await expect(row.locator('code')).toHaveText(identifier);
      await expect(row.locator('td').nth(1)).toHaveText(abilities);
      await expect(row.locator('td').nth(2)).toHaveText(context);
      await expect(row.locator('td').nth(3)).toHaveText('Allowed');
    }
    await expect(page.getByRole('switch')).toHaveCount(0);

    // Decisions: a provider is connected, so something answers while TypeSafe, which has no key on
    // this host, waits. `withSampleCatalog` stubs only the host's providers route, never the
    // Bureau's own catalog, so the Bureau's list of the rows that can answer is stubbed too
    // (`withDecisionRows`): the page names the row the Bureau marks as answering.
    const model = page.locator('[data-setting="decisions.model"]');
    await expect(model).toContainText(
      MODELS_COPY.decisions.model.fallbackAnswers('Claude Haiku 5.5'),
    );
    await expect(model).not.toContainText(MODELS_COPY.decisions.model.nothingAnswers);

    await checkA11y('settings models, provider connected, at 1280px');
    await captureAtEveryWidth(page, 'provider-connected');
  });

  test('keeps the provider Connected and puts the error in the catalog when the list of models does not come back', async ({
    page,
    pageErrors,
    checkA11y,
  }) => {
    pageErrors.expect({
      pattern: loggedFailedResponse(503, /\/host\/providers/),
      reason:
        'the test answers the read of the host’s models with a 503, to see what the page shows',
    });
    await open(page, E2E_BASE_URL);
    await expect(page.locator('table')).toBeVisible();

    // The read that follows a connect fails; a focus read stands in for it here.
    await page.route('**/host/providers', (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({ status: 503, json: { error: 'failed', message: '' } })
        : route.continue(),
    );
    await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));

    const failed = page.getByTestId('models-catalog-failed');
    await expect(failed).toContainText(MODELS_COPY.models.loadFailed.title);
    await expect(failed).toContainText(
      'Anthropic is connected, but its model list didn’t come back (503).',
    );
    await expect(failed.getByRole('button', { name: 'Try again' })).toBeVisible();
    // The error is in the catalog section, not in the provider row.
    const anthropic = providerRow(page, 'anthropic');
    await expect(anthropic).toContainText('Connected');
    await expect(anthropic.getByRole('button')).toHaveText('Manage');
    await expect(anthropic).not.toContainText('503');
    await expect(page.locator('table')).toHaveCount(0);
    await checkA11y('settings models, catalog failed, at 1280px');
    await captureAtEveryWidth(page, 'catalog-failed');

    await page.unroute('**/host/providers');
    await failed.getByRole('button', { name: 'Try again' }).click();
    await expect(page.locator('table')).toBeVisible();
    await expect(failed).toHaveCount(0);
  });

  test('Decisions, the decision model open: every row the Bureau lists by provider, a row that needs setup marked', async ({
    page,
    checkA11y,
  }) => {
    await withSampleCatalog(page);
    await withDecisionRows(page);
    await open(page, E2E_BASE_URL);
    const model = page.locator('[data-setting="decisions.model"]');
    await model.getByRole('combobox').click();
    // The listbox draws its options through `aria-owns`, so they are found from the page.
    await expect(page.getByRole('option', { name: /GPT 5/ })).toContainText(
      MODELS_COPY.decisions.needsSetup,
    );
    await expect(page.getByRole('option', { name: /Claude Haiku 5.5/ })).not.toContainText(
      MODELS_COPY.decisions.needsSetup,
    );
    await checkA11y('settings models, decision model open, at 1280px');
    // Each viewport change (and the capture at 320 by 640) leaves the open listbox somewhere in the
    // outlet: scroll it into view, opening it again if the resize closed it, before the pixels.
    const listbox = page.getByRole('listbox');
    await captureAtEveryWidth(page, 'decision-model-open', async (current) => {
      if (!(await listbox.isVisible())) await model.getByRole('combobox').click();
      await expect(listbox).toBeVisible();
      await listbox.scrollIntoViewIfNeeded();
    });
  });

  test('Decisions, the fallback model open: only the rows the fallback can use, the decision-only row left out', async ({
    page,
  }) => {
    await withSampleCatalog(page);
    await withDecisionRows(page);
    await open(page, E2E_BASE_URL);
    await page.locator('[data-setting="decisions.fallbackModel"]').getByRole('combobox').click();
    await expect(page.getByRole('option', { name: /GPT 5/ })).toContainText(
      MODELS_COPY.decisions.needsSetup,
    );
    await expect(page.getByRole('option', { name: /Jev/ })).toHaveCount(0);
  });

  test('Decisions, the rows that can answer did not load: the description says so with Try again, and both selects wait', async ({
    page,
    checkA11y,
  }) => {
    await withSampleCatalog(page);
    await withDecisionRows(page);
    let failing = true;
    await page.route('**/bureau/jsonrpc', async (route) => {
      const body = route.request().postDataJSON() as { id?: unknown; method?: string } | null;
      if (body?.method !== 'bureau.decisions.models' || !failing) return route.fallback();
      return route.fulfill({
        status: 503,
        json: { jsonrpc: '2.0', id: body.id ?? null, error: { code: -32000, message: 'Down' } },
      });
    });
    await open(page, E2E_BASE_URL);
    const model = page.locator('[data-setting="decisions.model"]');
    await expect(model).toContainText(MODELS_COPY.decisions.model.loadFailed);
    await expect(model.getByRole('combobox')).toBeDisabled();
    await expect(
      page.locator('[data-setting="decisions.fallbackModel"]').getByRole('combobox'),
    ).toBeDisabled();
    await checkA11y('settings models, decision rows failed, at 1280px');
    await captureAtEveryWidth(page, 'decision-rows-failed');

    failing = false;
    await model.getByRole('button', { name: MODELS_COPY.decisions.model.tryAgain }).click();
    await expect(model).not.toContainText(MODELS_COPY.decisions.model.loadFailed);
    await expect(model.getByRole('combobox')).toBeEnabled();
  });

  test('Decisions, a stored decision model the Bureau set aside: a warning on its row, not an error', async ({
    page,
    checkA11y,
  }) => {
    await withSampleCatalog(page);
    await withDecisionRows(page);
    await page.route('**/bureau/jsonrpc', async (route) => {
      const body = route.request().postDataJSON() as { method?: string } | null;
      if (body?.method !== 'bureau.settings.get') return route.fallback();
      const response = await route.fetch();
      const answer = (await response.json()) as {
        result: { keys: Record<string, Record<string, unknown>>; values: Record<string, unknown> };
      };
      // The Bureau set the stored value aside, so none is held and the row shows the default.
      delete answer.result.values['decisions.model'];
      answer.result.keys['decisions.model'] = {
        ...answer.result.keys['decisions.model'],
        problem: 'the stored value names the retired catalog row',
      };
      return route.fulfill({ response, json: answer });
    });
    await open(page, E2E_BASE_URL);
    const model = page.locator('[data-setting="decisions.model"]');
    // TypeSafe has no key on this host, so the warning may end with its Connect TypeSafe next step.
    await expect(model).toContainText(
      MODELS_COPY.decisions.model.dropped.replace(' Choose another.', ''),
    );
    await expect(model).not.toContainText('the stored value names the retired catalog row');
    await checkA11y('settings models, decision model dropped, at 1280px');
    await captureAtEveryWidth(page, 'decision-model-dropped');
  });

  test('Decisions, a stored decision model the Bureau does not list: a warning, with its own name still the option', async ({
    page,
    checkA11y,
  }) => {
    await withSampleCatalog(page);
    await withDecisionRows(page);
    await page.route('**/bureau/jsonrpc', async (route) => {
      const body = route.request().postDataJSON() as { method?: string } | null;
      if (body?.method !== 'bureau.settings.get') return route.fallback();
      const response = await route.fetch();
      const answer = (await response.json()) as {
        result: { values: Record<string, unknown> };
      };
      answer.result.values['decisions.model'] = 'acme/vanished';
      return route.fulfill({ response, json: answer });
    });
    await open(page, E2E_BASE_URL);
    const model = page.locator('[data-setting="decisions.model"]');
    // Another row answers while TypeSafe, which has no key on this host, waits: the warning ends
    // with both next steps, and the row has no separate Connect TypeSafe link.
    await expect(model).toContainText(MODELS_COPY.decisions.model.missingWaiting('acme/vanished'));
    await expect(model.getByRole('link', { name: 'Connect TypeSafe' })).toHaveCount(0);
    await expect(model.getByRole('combobox')).toContainText('acme/vanished');
    await checkA11y('settings models, decision model missing, at 1280px');
    await captureAtEveryWidth(page, 'decision-model-missing');

    // Opened, the stored name is still an option, unmarked, beside the rows the Bureau lists.
    await model.getByRole('combobox').click();
    await expect(page.getByRole('option', { name: 'acme/vanished' })).toBeVisible();
    await captureAtEveryWidth(page, 'decision-model-missing-open');
  });
});

/** A key shaped like Anthropic's, which only ever goes to a mocked route here. */
const PASTED_KEY = 'sk-ant-api03-0000000000000000';

/**
 * Answers the Bureau's list of the rows that can answer decisions (`bureau.decisions.models`) as
 * if Anthropic held a key: Haiku 5.5 is the row that answers, Sonnet 5.5 and Opus 5.5 are listed,
 * and OpenAI's row needs setup. Every other Bureau call goes on to the host.
 */
async function withDecisionRows(page: Page) {
  const row = (provider: string, model: string, extra: Record<string, unknown> = {}) => ({
    provider,
    model,
    availability: 'available',
    decisionOnly: false,
    answering: false,
    fallback: false,
    canBeFallback: true,
    ...extra,
  });
  await page.route('**/bureau/jsonrpc', async (route) => {
    const body = route.request().postDataJSON() as { id?: unknown; method?: string } | null;
    if (body?.method !== 'bureau.decisions.models') return route.fallback();
    return route.fulfill({
      json: {
        jsonrpc: '2.0',
        id: body.id ?? null,
        result: {
          rows: [
            row('anthropic', 'claude-opus-5-5'),
            row('anthropic', 'claude-sonnet-5-5'),
            row('anthropic', 'claude-haiku-5-5', { answering: true, fallback: true }),
            row('openai', 'gpt-5', { availability: 'needs-setup' }),
            // Decision-only: the Bureau's fallback never uses it, so it cannot be the fallback.
            row('typesafe', 'jev', {
              availability: 'needs-setup',
              decisionOnly: true,
              canBeFallback: false,
            }),
          ],
        },
      },
    });
  });
}

/** Answers every write to a provider's key and every test of one, so no capture changes the host. */
async function mockKeyRoutes(
  page: Page,
  tests: { ok: true; models: number } | { ok: false; status: number },
) {
  await page.route('**/host/providers/*/test', (route) => route.fulfill({ json: tests }));
  await page.route(/\/host\/providers\/[a-z]+$/, (route) =>
    route.request().method() === 'GET'
      ? route.fallback()
      : route.fulfill({ json: { providers: [], catalogRevision: 2 } }),
  );
}

/** Answers the host's providers as if Anthropic held a key, with the sample world's three models. */
async function withAnthropicConnected(page: Page) {
  await page.route('**/host/providers', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const body = (await response.json()) as {
      providers: { name: string; configured: boolean; hasKey: boolean }[];
    };
    return route.fulfill({
      response,
      json: {
        ...body,
        providers: body.providers.map((entry) =>
          entry.name === 'anthropic'
            ? { ...entry, configured: true, hasKey: true, connected: true }
            : entry,
        ),
        models: sampleCatalogModels(),
      },
    });
  });
}

/**
 * Answers the Bureau's list of provider contributions as if `provider`'s plugin took a `baseURL`, as
 * a plugin that fronts a gateway would, so its Connect and Manage dialogs draw a field.
 */
async function withBaseUrlSetting(page: Page, provider: string) {
  await page.route('**/bureau/jsonrpc', async (route) => {
    const body = route.request().postDataJSON() as { method?: string } | null;
    if (body?.method !== 'bureau.plugins.contributions') return route.fallback();
    const response = await route.fetch();
    const reply = (await response.json()) as {
      result: { providers: { name: string; configuration: unknown }[] };
    };
    return route.fulfill({
      response,
      json: {
        ...reply,
        result: {
          ...reply.result,
          providers: reply.result.providers.map((entry) =>
            entry.name === provider
              ? {
                  ...entry,
                  configuration: {
                    ...OLLAMA_SCHEMA,
                    properties: {
                      baseURL: { type: 'string', description: 'Where the gateway listens.' },
                    },
                  },
                }
              : entry,
          ),
        },
      },
    });
  });
}

test.describe('Settings › Models, connect dialogs', () => {
  const copy = MODELS_COPY.connectDialog;

  async function openConnect(page: Page) {
    await open(page, E2E_SHOWCASE_URL);
    await providerRow(page, 'anthropic')
      .getByRole('button', { name: /Connect/ })
      .click();
    const dialog = page.getByRole('dialog', { name: copy.title('Anthropic') });
    await expect(dialog).toBeVisible();
    return dialog;
  }

  test('Connect, empty: the key field, the help line and Cancel, Test and Connect', async ({
    page,
    checkA11y,
  }) => {
    const dialog = await openConnect(page);

    await expect(dialog).toContainText(copy.subtitle.idle);
    const field = dialog.getByLabel(copy.keyLabel);
    await expect(field).toHaveAttribute('placeholder', copy.keyPlaceholder);
    await expect(dialog).toContainText(copy.keyHelp);
    await expect(dialog.getByRole('link', { name: copy.getKey })).toHaveAttribute(
      'href',
      'https://console.anthropic.com/settings/keys',
    );
    await expect(dialog.locator('.cinder-_required-marker')).toHaveCount(1);
    await expect(dialog.getByRole('button', { name: copy.connect })).toBeEnabled();
    await checkA11y('settings models, connect empty, at 1280px');
    await captureAtEveryWidth(page, 'connect-empty');
  });

  test('Connect, with settings: the plugin’s own fields below the key field, under one heading, and no box of their own', async ({
    page,
    checkA11y,
  }) => {
    await withBaseUrlSetting(page, 'openai');
    await open(page, E2E_SHOWCASE_URL);
    await providerRow(page, 'openai')
      .getByRole('button', { name: /Connect/ })
      .click();
    const dialog = page.getByRole('dialog', { name: copy.title('OpenAI') });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel(copy.keyLabel)).toBeVisible();
    await expect(
      dialog.getByRole('heading', { name: MODELS_COPY.configuration.heading }),
    ).toBeVisible();
    await expect(dialog.getByLabel(/base ?url/i)).toBeVisible();
    await expect(dialog.getByRole('button', { name: copy.connect })).toBeEnabled();
    await checkA11y('settings models, connect with settings, at 1280px');
    await captureAtEveryWidth(page, 'connect-with-settings');
  });

  test('Connect, a refused setting: the host’s words at the field it names, and the key stays unsaved', async ({
    page,
    checkA11y,
  }) => {
    await withBaseUrlSetting(page, 'openai');
    await mockKeyRoutes(page, { ok: true, models: 1 });
    await page.route('**/host/plugins/openai', (route) =>
      route.request().method() === 'PUT'
        ? route.fulfill({
            status: 400,
            json: {
              error: 'invalid',
              field: 'configuration.baseURL',
              message: 'baseURL must be a URL.',
            },
          })
        : route.fallback(),
    );
    await open(page, E2E_SHOWCASE_URL);
    await providerRow(page, 'openai')
      .getByRole('button', { name: /Connect/ })
      .click();
    const dialog = page.getByRole('dialog', { name: copy.title('OpenAI') });
    await dialog.getByLabel(/base ?url/i).fill('not a url');
    await dialog.getByLabel(copy.keyLabel).fill(PASTED_KEY);
    await dialog.getByRole('button', { name: copy.connect }).click();

    await expect(dialog).toContainText('baseURL must be a URL.');
    await expect(dialog.getByLabel(/base ?url/i)).toHaveAttribute('aria-invalid', 'true');
    await expect(dialog.getByTestId('provider-connect-success')).toHaveCount(0);
    await checkA11y('settings models, connect with a refused setting, at 1280px');
    await captureAtEveryWidth(page, 'connect-refused-setting');
  });

  test('Connect, testing: the masked key, a status with a spinner, a disabled Testing… and an enabled Cancel', async ({
    page,
    checkA11y,
  }) => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route('**/host/providers/*/test', async (route) => {
      await held;
      // A refusal, so releasing the held test never saves the key on the showcase host.
      await route.fulfill({ json: { ok: false, status: 401 } });
    });
    const dialog = await openConnect(page);

    await dialog.getByLabel(copy.keyLabel).fill(PASTED_KEY);
    await dialog.getByRole('button', { name: copy.connect }).click();

    await expect(dialog).toContainText(copy.subtitle.testing);
    await expect(dialog).toContainText(copy.testing);
    await expect(dialog.getByRole('button', { name: copy.connecting })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: copy.cancel })).toBeEnabled();
    await checkA11y('settings models, connect testing, at 1280px');
    await captureAtEveryWidth(page, 'connect-testing');
    release();
  });

  test('Connect, invalid key: the refusal at the field with a warning glyph, and every button still enabled', async ({
    page,
    checkA11y,
  }) => {
    await mockKeyRoutes(page, { ok: false, status: 401 });
    const dialog = await openConnect(page);

    await dialog.getByLabel(copy.keyLabel).fill(PASTED_KEY);
    await dialog.getByRole('button', { name: copy.connect }).click();

    await expect(dialog).toContainText(copy.subtitle.failed);
    await expect(dialog).toContainText(MODELS_COPY.keyTest.rejected('Anthropic', 401));
    await expect(dialog.getByLabel(copy.keyLabel)).toHaveAttribute('aria-invalid', 'true');
    for (const name of [copy.cancel, copy.test, copy.connect]) {
      await expect(dialog.getByRole('button', { name })).toBeEnabled();
    }
    await checkA11y('settings models, connect invalid key, at 1280px');
    await captureAtEveryWidth(page, 'connect-invalid-key');
  });

  test('Connect, connected: a success banner with the model count and a single Done', async ({
    page,
    checkA11y,
  }) => {
    await mockKeyRoutes(page, { ok: true, models: 3 });
    const dialog = await openConnect(page);

    await dialog.getByLabel(copy.keyLabel).fill(PASTED_KEY);
    await dialog.getByRole('button', { name: copy.connect }).click();

    await expect(dialog).toContainText(copy.subtitle.connected);
    const banner = dialog.getByTestId('provider-connect-success');
    await expect(banner).toContainText(copy.connectedTitle);
    await expect(banner).toContainText(copy.models(3));
    await expect(dialog.getByRole('button', { name: copy.done })).toBeVisible();
    await expect(dialog.getByRole('button', { name: copy.connect })).toHaveCount(0);
    await checkA11y('settings models, connect connected, at 1280px');
    await captureAtEveryWidth(page, 'connect-connected');
  });
});

/**
 * The four model agents of the sample world (Tool runner, Request human input, Model switcher and
 * Workflow author) are scripted, so only Model switcher states a model of its own. The board names
 * all four in the removal's question, so the capture answers their definitions as if each stated an
 * Anthropic model, which is what makes them stop answering when the key goes.
 */
async function withModelAgents(page: Page) {
  const agents = new Set([
    'tool-runner',
    'request-human-input',
    'model-switcher',
    'workflow-author',
  ]);
  await page.route('**/bureau/jsonrpc', async (route) => {
    const body = route.request().postDataJSON() as {
      method?: string;
      params?: { id?: string };
    };
    if (body.method !== 'bureau.agents.definitions.get' || !agents.has(body.params?.id ?? '')) {
      return route.fallback();
    }
    const response = await route.fetch();
    const payload = (await response.json()) as {
      result?: { codeDefinition?: { model: string | null } | null };
    };
    if (payload.result?.codeDefinition) {
      payload.result.codeDefinition.model = 'anthropic/claude-sonnet-5-5';
    }
    return route.fulfill({ response, json: payload });
  });
}

test.describe('Settings › Models, manage, replace and remove', () => {
  async function openManage(page: Page) {
    await withAnthropicConnected(page);
    await open(page, E2E_SHOWCASE_URL);
    await providerRow(page, 'anthropic')
      .getByRole('button', { name: /Manage/ })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Anthropic' });
    await expect(dialog).toBeVisible();
    return dialog;
  }

  test('Manage, a connected provider: connected, the model count, Remove key, Replace key and Done', async ({
    page,
    checkA11y,
  }) => {
    const dialog = await openManage(page);

    // Said once, by the status beside the model count: the dialog has no description to say it again.
    await expect(dialog.getByText(MODELS_COPY.manageDialog.connected, { exact: true })).toHaveCount(
      1,
    );
    await expect(dialog).toContainText(MODELS_COPY.manageDialog.models(3));
    // The saved key is never shown again: no key field. The plugin's own settings are fields here.
    await expect(dialog.getByLabel(MODELS_COPY.connectDialog.keyLabel)).toHaveCount(0);
    await expect(dialog.locator('input[type="password"]')).toHaveCount(0);
    await checkA11y('settings models, manage, at 1280px');
    await captureAtEveryWidth(page, 'manage');
  });

  test('Manage, with a setting changed: Remove key, Replace key and Save stay inside the dialog at 320', async ({
    page,
  }) => {
    // The plugin takes a `baseURL` here, so changing it turns Done into Save beside both key buttons.
    await withBaseUrlSetting(page, 'anthropic');
    const dialog = await openManage(page);
    await dialog.getByLabel(/base ?url/i).fill('https://proxy.example/v1');
    const buttons = [
      MODELS_COPY.manageDialog.removeKey,
      MODELS_COPY.manageDialog.replaceKey,
      MODELS_COPY.manageDialog.save,
    ].map((name) => dialog.getByRole('button', { name, exact: true }));
    await page.setViewportSize({ width: 320, height: 640 });
    const footer = dialog.locator('.cinder-modal__footer');
    await expect(footer).toBeVisible();
    const footerBox = await footer.boundingBox();
    for (const button of buttons) {
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      // Whole inside the footer's inline edges, so the buttons wrapped to another line instead of
      // one overflowing and being clipped by the panel.
      expect(box!.x).toBeGreaterThanOrEqual(footerBox!.x);
      expect(box!.x + box!.width).toBeLessThanOrEqual(footerBox!.x + footerBox!.width + 1);
    }
    // Wrapped: they do not share one row.
    const rows = new Set(
      await Promise.all(buttons.map(async (button) => Math.round((await button.boundingBox())!.y))),
    );
    expect(rows.size).toBeGreaterThan(1);
    await captureAtEveryWidth(page, 'manage-save-and-key-buttons');
  });

  test('Replace key, in progress: the new key tests while the old one stays in use', async ({
    page,
    checkA11y,
  }) => {
    const copy = MODELS_COPY.replaceDialog;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route('**/host/providers/*/test', async (route) => {
      await held;
      await route.fulfill({ json: { ok: false, status: 401 } });
    });
    const manage = await openManage(page);
    await manage.getByRole('button', { name: MODELS_COPY.manageDialog.replaceKey }).click();
    const dialog = page.getByRole('dialog', { name: copy.title('Anthropic') });
    await expect(dialog).toContainText(copy.subtitle);

    await dialog.getByLabel(copy.keyLabel).fill(PASTED_KEY);
    await dialog.getByRole('button', { name: copy.replace }).click();

    await expect(dialog).toContainText(copy.testing);
    await expect(dialog.getByRole('button', { name: copy.replace })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: copy.cancel })).toBeEnabled();
    await checkA11y('settings models, replace key testing, at 1280px');
    await captureAtEveryWidth(page, 'replace-key-testing');
    release();
  });

  test('Remove key, confirm: a confirmation that names the model agents and a solid danger button', async ({
    page,
    checkA11y,
  }) => {
    const copy = MODELS_COPY.removeDialog;
    await withModelAgents(page);
    const manage = await openManage(page);
    await manage.getByRole('button', { name: MODELS_COPY.manageDialog.removeKey }).click();
    const dialog = page.getByRole('dialog', { name: copy.title('Anthropic') });
    await expect(dialog).toBeVisible();

    await expect(dialog.getByRole('button', { name: copy.confirm })).toHaveAttribute(
      'data-cinder-variant',
      'danger',
    );
    // The agents are named in the order the sample world lists them (SHOWCASE_AGENT_IDENTIFIERS).
    await expect(dialog).toContainText(
      'Tool runner, Request human input, Workflow author and Model switcher stop answering until you add a key. Run now on their schedules is disabled too. Chats and runs stay.',
    );
    await expect(dialog).not.toContainText('Assistant');
    await expect(dialog).not.toContainText('Echo');
    await checkA11y('settings models, remove key confirm, at 1280px');
    await captureAtEveryWidth(page, 'remove-key-confirm');
  });
});

const OLLAMA_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    baseURL: { type: 'string', description: 'Where the Ollama server listens.' },
  },
  additionalProperties: false,
};

/**
 * Answers the host as if a local Ollama, which declares no secret, were loaded beside Anthropic: its
 * provider is connected with no key saved, its plugin holds a `baseURL`, and the Bureau reports the
 * provider with that schema. No bundled plugin is keyless, so the showcase host has none of its own.
 */
async function withKeylessOllama(page: Page, schema: Record<string, unknown> = OLLAMA_SCHEMA) {
  await page.route('**/host/providers', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const body = (await response.json()) as {
      providers: { name: string }[];
    };
    return route.fulfill({
      response,
      json: {
        ...body,
        providers: [
          ...body.providers.map((entry) =>
            entry.name === 'anthropic'
              ? { ...entry, configured: true, hasKey: true, connected: true }
              : entry,
          ),
          { name: 'ollama', configured: false, hasKey: false, connected: true },
        ],
        models: [
          ...sampleCatalogModels(),
          {
            provider: 'ollama',
            model: 'llama-3-2',
            aliases: [],
            contextWindowTokens: 128_000,
            maxOutputTokens: 8_000,
            streaming: true,
            tools: true,
            structuredOutput: false,
            images: false,
            off: false,
          },
        ],
      },
    });
  });
  await page.route('**/host/plugins', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const response = await route.fetch();
    const body = (await response.json()) as { plugins: { descriptor: { name: string } }[] };
    const configuration = { baseURL: 'http://localhost:11434' };
    return route.fulfill({
      response,
      json: {
        ...body,
        plugins: [
          // The host lists its own Ollama plugin, switched off: this one stands in for it, running.
          ...body.plugins.filter((plugin) => plugin.descriptor.name !== 'ollama'),
          {
            descriptor: {
              name: 'ollama',
              title: 'Ollama',
              version: '0.1.0',
              description: 'Models served by a local Ollama.',
              required: false,
              enabledByDefault: true,
            },
            source: 'package',
            location: '@lostgradient/plugin-ollama',
            status: 'running',
            problems: [],
            contributions: [],
            enabled: true,
            configuration,
            configurationSchema: schema,
            running: { enabled: true, configuration },
            secrets: [],
            restartRequired: false,
          },
        ],
      },
    });
  });
  await page.route('**/bureau/jsonrpc', async (route) => {
    const body = route.request().postDataJSON() as { method?: string } | null;
    if (body?.method !== 'bureau.plugins.contributions') return route.fallback();
    const response = await route.fetch();
    const reply = (await response.json()) as {
      result: { providers: { plugin: string }[] };
    };
    return route.fulfill({
      response,
      json: {
        ...reply,
        result: {
          ...reply.result,
          providers: [
            ...reply.result.providers.filter((provider) => provider.plugin !== 'ollama'),
            { plugin: 'ollama', name: 'ollama', configuration: schema },
          ],
        },
      },
    });
  });
}

test.describe('Settings › Models, a keyless provider', () => {
  test('is Connected with Manage and no Connect, and its Manage holds its settings and no key action', async ({
    page,
    checkA11y,
  }) => {
    await withKeylessOllama(page);
    await open(page, E2E_SHOWCASE_URL);
    const ollama = providerRow(page, 'ollama');
    await expect(ollama).toContainText('Ollama');
    await expect(ollama).toContainText(MODELS_COPY.providers.connected);
    await expect(ollama.getByRole('button', { name: /^Connect/ })).toHaveCount(0);
    await expect(ollama.getByRole('button')).toHaveText(MODELS_COPY.providers.manage);
    await expect(page.getByRole('table', { name: MODELS_COPY.models.tableLabel })).toContainText(
      'llama-3-2',
    );
    await checkA11y('settings models, keyless provider, at 1280px');
    await captureAtEveryWidth(page, 'keyless-provider');

    await ollama.getByRole('button', { name: /Manage/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Ollama' });
    await expect(dialog).toContainText(MODELS_COPY.manageDialog.connected);
    await expect(dialog.getByLabel(/base ?url/i)).toHaveValue('http://localhost:11434');
    await expect(
      dialog.getByRole('button', { name: MODELS_COPY.manageDialog.removeKey }),
    ).toHaveCount(0);
    await expect(
      dialog.getByRole('button', { name: MODELS_COPY.manageDialog.replaceKey }),
    ).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: MODELS_COPY.manageDialog.done })).toBeVisible();
    await checkA11y('settings models, keyless manage, at 1280px');
    await captureAtEveryWidth(page, 'keyless-manage');
  });

  test('with no settings and no key, its row is only Connected: no button and no dialog to open', async ({
    page,
    checkA11y,
  }) => {
    // The same schema the page's own test reads as "no settings": an object with no properties.
    await withKeylessOllama(page, { type: 'object', properties: {} });
    await open(page, E2E_SHOWCASE_URL);
    const ollama = providerRow(page, 'ollama');
    await expect(ollama).toContainText(MODELS_COPY.providers.connected);
    await expect(ollama.getByRole('button')).toHaveCount(0);
    await expect(page.getByRole('table', { name: MODELS_COPY.models.tableLabel })).toContainText(
      'llama-3-2',
    );
    await checkA11y('settings models, keyless provider with no settings, at 1280px');
    await captureAtEveryWidth(page, 'keyless-no-fields');
  });
});
