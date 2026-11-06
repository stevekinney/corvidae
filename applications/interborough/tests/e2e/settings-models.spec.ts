/**
 * Settings › Models (board SettingsShell, "Models · /settings/models", "Models · provider
 * connected" and "More states"). The sample world has no provider connected, so its page is the
 * empty one: three providers with Connect, an empty catalog and the Decisions waiting on TypeSafe.
 * The main host has Anthropic connected; its page is captured with the sample world's three Anthropic
 * models (the host's own list is longer), and with the list of models failing right after a connect.
 *
 * Each captioned state is captured for the design review (`design-review-capture.ts`) at the widths
 * Settings is drawn at.
 */
import type { Page } from '@playwright/test';

import { MODELS_COPY } from '../../src/app/copy.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_BASE_URL, E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, loggedFailedResponse, test } from './fixtures.ts';

const SOURCE = 'settings-models.spec.ts';
const ROUTE = '/settings/models';

/** Captures the screen at the three widths Settings is drawn at: desktop, tablet and phone. */
async function captureAtEveryWidth(page: Page, state: string) {
  for (const width of [1280, 768, 375] as const) {
    await page.setViewportSize({ width, height: 900 });
    await captureForDesignReview(page, { route: ROUTE, state, source: SOURCE });
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

/** The sample world's Anthropic catalog, as the board draws it (Opus 5.5, Sonnet 5.5 and Haiku 5.5). */
function sampleModel(model: string, extra: Record<string, unknown>) {
  return {
    provider: 'anthropic',
    model,
    aliases: [],
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    streaming: true,
    tools: true,
    structuredOutput: true,
    images: true,
    off: false,
    ...extra,
  };
}

/** Answers the host's providers with Anthropic connected and the sample world's three models. */
async function withSampleCatalog(page: Page) {
  await page.route('**/host/providers', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    return route.fulfill({
      response,
      json: {
        ...body,
        models: [
          sampleModel('claude-opus-5-5', {}),
          sampleModel('claude-sonnet-5-5', {}),
          sampleModel('claude-haiku-5-5', { images: false, contextWindowTokens: 200_000 }),
        ],
      },
    });
  });
}

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

    // Decisions: TypeSafe lives here, and the rows that depend on it wait for it.
    await expect(page.getByText(MODELS_COPY.decisions.description)).toBeVisible();
    const model = page.locator('[data-setting="decisions.model"]');
    await expect(model).toContainText('Decision model');
    await expect(model).toContainText(MODELS_COPY.decisions.model.description);
    await expect(model.getByRole('link', { name: 'Connect TypeSafe' })).toBeVisible();
    const fallback = page.locator('[data-setting="decisions.fallbackModel"]');
    await expect(fallback).toContainText('Fallback model');
    await expect(fallback.getByRole('combobox')).toBeDisabled();
    await expect(fallback.getByRole('combobox')).toContainText(
      MODELS_COPY.decisions.fallbackModel.connectFirst,
    );
    const limit = page.locator('[data-setting="decisions.maximumPerTask"]');
    await expect(limit).toContainText('Maximum per task');
    await expect(limit).toContainText(MODELS_COPY.decisions.maximumPerTask.connectFirst);
    await expect(limit.getByRole('spinbutton')).toBeDisabled();
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
      ['Claude Opus 5.5', 'claude-opus-5-5', 'Tools · images', '1M'],
      ['Claude Sonnet 5.5', 'claude-sonnet-5-5', 'Tools · images', '1M'],
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
});
