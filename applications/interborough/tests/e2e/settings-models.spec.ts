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
            row('anthropic', 'claude-haiku-5-5', { answering: true }),
            row('openai', 'gpt-5', { availability: 'needs-setup' }),
            row('typesafe', 'jev', { availability: 'needs-setup', decisionOnly: true }),
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

    await expect(dialog).toContainText(MODELS_COPY.manageDialog.subtitle);
    await expect(dialog).toContainText(MODELS_COPY.manageDialog.connected);
    await expect(dialog).toContainText(MODELS_COPY.manageDialog.models(3));
    // The saved key is never shown again: no key field. The plugin's own settings are fields here.
    await expect(dialog.getByLabel(MODELS_COPY.connectDialog.keyLabel)).toHaveCount(0);
    await expect(dialog.locator('input[type="password"]')).toHaveCount(0);
    await checkA11y('settings models, manage, at 1280px');
    await captureAtEveryWidth(page, 'manage');
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
async function withKeylessOllama(page: Page) {
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
    const body = (await response.json()) as { plugins: unknown[] };
    const configuration = { baseURL: 'http://localhost:11434' };
    return route.fulfill({
      response,
      json: {
        ...body,
        plugins: [
          ...body.plugins,
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
            configurationSchema: OLLAMA_SCHEMA,
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
    const reply = (await response.json()) as { result: { providers: unknown[] } };
    return route.fulfill({
      response,
      json: {
        ...reply,
        result: {
          ...reply.result,
          providers: [
            ...reply.result.providers,
            { plugin: 'ollama', name: 'ollama', configuration: OLLAMA_SCHEMA },
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
});
