/**
 * Settings › Plugins (board PageSettingsSections, "Plugins, /settings/plugins", "Plugin, Save
 * configuration failed", "Demo detail", "Anthropic detail" and "Plugins loading and failing to
 * load") on the sample world, whose plugins are real: Guardrails and Inspectors run, Anthropic,
 * OpenAI, Gemini and TypeSafe need a key, and Demo, Ollama and Voyage are off. Where a board names
 * Web search, this reads Guardrails (decisions: "Plugins: the sample world uses real plugins"),
 * which has a text-list field and a number to draw the configuration form with.
 *
 * Each captioned state is captured for the design review (`design-review-capture.ts`) at the
 * widths Settings is drawn at.
 */
import type { Page } from '@playwright/test';

import { PLUGINS_COPY } from '../../src/app/copy/plugins.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_BASE_URL, E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, loggedFailedResponse, test } from './fixtures.ts';
import { readBoxes } from './read-boxes.ts';
import { withSampleCatalog } from './sample-catalog.ts';

const SOURCE = 'settings-plugins.spec.ts';
const ROUTE = '/settings/plugins';

/** Captures the screen at the three widths Settings is drawn at: desktop, tablet and phone. */
async function captureAtEveryWidth(page: Page, state: string, route = ROUTE) {
  for (const width of [1280, 768, 375] as const) {
    await page.setViewportSize({ width, height: 900 });
    await captureForDesignReview(page, { route, state, source: SOURCE });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function open(page: Page, plugin: string, width = 1280, origin = E2E_SHOWCASE_URL) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${origin}${ROUTE}?plugin=${plugin}`);
  await expect(page.locator(`[data-plugin-detail="${plugin}"]`)).toBeVisible();
}

const row = (page: Page, name: string) => page.locator(`[data-plugin-row="${name}"]`);
const detail = (page: Page, name: string) => page.locator(`[data-plugin-detail="${name}"]`);

test.describe('Settings › Plugins', () => {
  test('list and detail: the plugins by name with version, status and kind, and the open one with what it adds, its configuration form, and what uses it', async ({
    page,
    checkA11y,
  }) => {
    await open(page, 'guardrails');

    // The shell: breadcrumb, Plugins active in the section navigation, the heading and subtitle.
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Plugins');
    await expect(
      page
        .getByRole('navigation', { name: 'Settings sections' })
        .getByRole('link', { name: 'Plugins', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { level: 1, name: 'Plugins' })).toBeVisible();
    await expect(page.getByText(PLUGINS_COPY.intro)).toBeVisible();

    // The list header counts the plugins beside a link to how to add one.
    const count = page.getByTestId('plugins-count');
    await expect(count).toContainText(PLUGINS_COPY.listHeader.heading);
    await expect(page.getByRole('link', { name: PLUGINS_COPY.listHeader.howToAdd })).toBeVisible();
    // The sample world's nine plugins, in the order the board lists them, each at 1.0.0, and not
    // Interborough's own built-in plugin.
    await expect(count).toContainText('9');
    await expect(page.locator('[data-plugin-row]')).toHaveCount(9);
    expect(
      await page
        .locator('[data-plugin-row]')
        .evaluateAll((rows) => rows.map((entry) => entry.getAttribute('data-plugin-row'))),
    ).toEqual([
      'inspectors',
      'anthropic',
      'openai',
      'gemini',
      'typesafe',
      'guardrails',
      'voyage',
      'demo',
      'ollama',
    ]);
    for (const entry of await page.locator('[data-plugin-row]').all()) {
      await expect(entry).toContainText('1.0.0');
      await expect(entry).not.toContainText('Built in');
    }
    // A plugin that needs a key reads Needs setup, a neutral word.
    await expect(row(page, 'anthropic')).toContainText('Needs setup');
    await expect(row(page, 'anthropic').locator('[data-cinder-status]').first()).toHaveAttribute(
      'data-cinder-status',
      'neutral',
    );
    await expect(row(page, 'guardrails')).toContainText('Running');
    await expect(row(page, 'guardrails')).toContainText('Package');
    await expect(row(page, 'demo')).toContainText('Disabled');

    const opened = detail(page, 'guardrails');
    await expect(opened.getByRole('heading', { level: 3, name: 'Guardrails' })).toBeVisible();
    await expect(opened.getByRole('switch', { name: 'Enabled' })).toBeChecked();
    await expect(opened).toContainText('@lostgradient/plugin-guardrails');
    await expect(opened).toContainText('Package plugin, loaded at startup');
    await expect(opened.getByTestId('plugin-adds')).toContainText('guardrails:code-safety');

    // The configuration is a form built from the plugin's own schema, with one explicit Save.
    const configuration = opened.getByTestId('plugin-configuration');
    await expect(configuration).toContainText(PLUGINS_COPY.configuration.description);
    await expect(configuration.locator('textarea')).toHaveCount(0);
    await expect(configuration.locator('[data-cinder-field="blockedPatterns"]')).toBeVisible();
    // The schema gives it no title, so the row is labelled in words and shows no key.
    const groundingRow = configuration.locator('[data-cinder-field="groundingThreshold"]');
    await expect(groundingRow).toContainText('Grounding threshold');
    await expect(groundingRow).not.toContainText('groundingThreshold');
    await expect(configuration.getByRole('button', { name: 'Save configuration' })).toBeVisible();
    await expect(configuration).toContainText(PLUGINS_COPY.configuration.note);
    await expect(opened.getByTestId('plugin-in-use')).toContainText('In use.');

    await checkA11y('settings plugins at 1280px');
    await captureAtEveryWidth(page, 'list-and-detail');
  });

  test('with nothing named in the address the first plugin is open beside the list, and below the push breakpoint the list comes first', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${E2E_SHOWCASE_URL}${ROUTE}`);
    // Inspectors stands in for the board's Web search, the first plugin of the list.
    const opened = detail(page, 'inspectors');
    await expect(opened.getByRole('heading', { level: 3, name: 'Inspectors' })).toBeVisible();
    await expect(opened.getByRole('switch', { name: 'Enabled' })).toBeChecked();
    await expect(opened).toContainText('@lostgradient/plugin-inspectors');
    await expect(opened).toContainText('Package plugin, loaded at startup');
    await expect(opened.getByTestId('plugin-adds')).toBeVisible();
    await expect(page.getByText(PLUGINS_COPY.emptyDetail.title)).toHaveCount(0);
    await captureAtEveryWidth(page, 'first-open');

    // Stacked, one pane shows at a time and the list is where it starts.
    await page.setViewportSize({ width: 375, height: 900 });
    await page.goto(`${E2E_SHOWCASE_URL}${ROUTE}`);
    await expect(row(page, 'inspectors')).toBeVisible();
    await expect(page.locator('[data-plugin-detail]')).toHaveCount(0);
  });

  test('Save configuration failed: the typed value stays, the error is named under the button, and Save is the retry', async ({
    page,
    pageErrors,
  }) => {
    pageErrors.expectEvery({
      pattern: /net::ERR_FAILED/,
      reason: 'the test holds the host down for the save, so the request has no answer',
    });
    await open(page, 'guardrails');
    const field = detail(page, 'guardrails').locator(
      '[data-cinder-field="groundingThreshold"] input',
    );
    await field.fill('0.5');
    await page.route('**/host/plugins/guardrails', (route) => route.abort('failed'));

    const save = detail(page, 'guardrails').getByRole('button', { name: 'Save configuration' });
    await save.click();

    const failure = detail(page, 'guardrails').locator('.cinder-form-actions__error');
    await expect(failure).toContainText('Couldn’t save the configuration.');
    await expect(failure).toContainText('Interborough didn’t answer.');
    await expect(field).toHaveValue('0.5');
    await expect(save).toBeEnabled();
    await expect(detail(page, 'guardrails')).toContainText(PLUGINS_COPY.configuration.note);
    // The restart count did not move: nothing was saved.
    await expect(page.getByTestId('settings-restart-summary')).toContainText(
      '1 change waits for a restart',
    );
    await captureAtEveryWidth(page, 'save-failed');
  });

  test('every kind of configuration field: text, select, switch, number, tags, duration, a group and a list of groups, as rows', async ({
    page,
    checkA11y,
  }) => {
    // The host's answer is changed to a fixture plugin whose schema holds one field of every kind
    // the rows draw, so the design review sees them all in one place. Guardrails' name stands in.
    await page.route('**/host/plugins', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const response = await route.fetch();
      const snapshot = await response.json();
      for (const plugin of snapshot.plugins as {
        descriptor: { name: string };
        configuration: unknown;
        configurationSchema: unknown;
      }[]) {
        if (plugin.descriptor.name !== 'guardrails') continue;
        plugin.configuration = {
          searchAddress: 'https://search.example',
          // No `region`: the optional choice has no default and nothing stored, so it reads Not set.
          includeSnippets: true,
          limit: 0.8,
          blockedSites: ['example.com', 'example.org'],
          cacheMs: 300000,
          account: { owner: 'Operations' },
          roots: [{ path: '/srv/data' }],
        };
        plugin.configurationSchema = {
          type: 'object',
          properties: {
            searchAddress: {
              type: 'string',
              title: 'Search address',
              description: 'The service the search goes to.',
            },
            region: { type: 'string', enum: ['us', 'eu'], description: 'Where the work runs.' },
            includeSnippets: { type: 'boolean', description: 'Show an excerpt with each result.' },
            limit: { type: 'number', description: 'How many results come back.' },
            blockedSites: {
              type: 'array',
              items: { type: 'string' },
              description: 'Sites that are never searched.',
            },
            cacheMs: { type: 'number', description: 'How long a result is kept.' },
            account: {
              type: 'object',
              description: 'Who the work is billed to.',
              properties: { owner: { type: 'string', title: 'Owner' } },
            },
            roots: {
              type: 'array',
              description: 'Folders the plugin may read.',
              items: { type: 'object', properties: { path: { type: 'string' } } },
            },
          },
          required: ['searchAddress'],
        };
      }
      return route.fulfill({ response, json: snapshot });
    });
    await open(page, 'guardrails');

    const configuration = detail(page, 'guardrails').getByTestId('plugin-configuration');
    for (const key of [
      'searchAddress',
      'region',
      'includeSnippets',
      'limit',
      'blockedSites',
      'cacheMs',
      'account',
      'roots',
    ]) {
      await expect(configuration.locator(`[data-cinder-field="${key}"]`)).toBeVisible();
    }
    await expect(configuration.locator('[data-cinder-field="region"] select')).toHaveValue('');
    await checkA11y('settings plugins, every kind of configuration field, at 1280px');

    // Wide: a row's label leads and its control sits to the right on the same line (a text, a select
    // and a switch), and Save sits at the inline end of the form (COR-2500).
    const controlOf = (key: string, selector: string) =>
      configuration.locator(`[data-cinder-field="${key}"]`).locator(selector).first();
    const labelOf = (key: string) =>
      configuration.locator(`[data-cinder-field="${key}"] .cinder-form-field__label`).first();
    // At 1264px a 15px scrollbar that never hides takes the room the rows need, so the rows must
    // still sit side by side there.
    for (const wideWidth of [1264, 1280] as const) {
      await page.setViewportSize({ width: wideWidth, height: 900 });
      // Settled: every control is visible at this width before any box is read.
      await expect(controlOf('includeSnippets', '[role="switch"]')).toBeVisible();
      await expect(controlOf('blockedSites', '.cinder-tag-input__control')).toBeVisible();
      const saveButton = configuration.getByRole('button', { name: 'Save configuration' });
      await expect(saveButton).toBeVisible();
      // One evaluation reads every box, so they all come from one layout.
      const boxes = await readBoxes(page, {
        searchAddressLabel: labelOf('searchAddress'),
        searchAddress: controlOf('searchAddress', 'input'),
        regionLabel: labelOf('region'),
        region: controlOf('region', 'select'),
        limitLabel: labelOf('limit'),
        limit: controlOf('limit', 'input'),
        includeSnippetsLabel: labelOf('includeSnippets'),
        includeSnippets: controlOf('includeSnippets', '[role="switch"]'),
        tagsRow: configuration.locator('[data-cinder-field="blockedSites"] .cinder-setting-row'),
        tags: controlOf('blockedSites', '.cinder-tag-input__control'),
        form: configuration.locator('form'),
        save: saveButton,
      });
      for (const key of ['searchAddress', 'region', 'limit', 'includeSnippets'] as const) {
        const label = boxes[`${key}Label`];
        const control = boxes[key];
        expect(
          control.x,
          `${key} control sits right of its label at ${wideWidth}px`,
        ).toBeGreaterThan(label.x);
        expect(control.y < label.y + label.height && label.y < control.y + control.height).toBe(
          true,
        );
      }
      // Text entry shares one leading edge down the rows.
      expect(Math.abs(boxes.region.x - boxes.searchAddress.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(boxes.limit.x - boxes.searchAddress.x)).toBeLessThanOrEqual(1);
      // The tag list sits under its row at the row's width, not squeezed into the control column.
      expect(boxes.tags.width).toBeGreaterThan(boxes.tagsRow.width * 0.6);
      expect(
        Math.abs(boxes.form.x + boxes.form.width - (boxes.save.x + boxes.save.width)),
      ).toBeLessThanOrEqual(2);
    }

    for (const width of [1280, 320] as const) {
      await page.setViewportSize({ width, height: 900 });
      if (width === 320) {
        const overflow = await page.evaluate(() => {
          const scroller = document.scrollingElement;
          return scroller === null ? 0 : scroller.scrollWidth - scroller.clientWidth;
        });
        expect(overflow, 'nothing overflows horizontally at 320px').toBe(0);
      }
      await configuration.scrollIntoViewIfNeeded();
      await captureForDesignReview(page, {
        route: ROUTE,
        state: 'configuration-every-kind',
        source: SOURCE,
      });
      // The rest of the form: the group's field, the list of groups and Save.
      await configuration.locator('[data-cinder-field="roots"]').scrollIntoViewIfNeeded();
      await configuration
        .getByRole('button', { name: 'Save configuration' })
        .scrollIntoViewIfNeeded();
      await captureForDesignReview(page, {
        route: ROUTE,
        state: 'configuration-every-kind-end',
        source: SOURCE,
      });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  test('a disabled plugin: the switch reads Disabled, what it holds back is named, and enabling it is explained next to the switch', async ({
    page,
  }) => {
    await open(page, 'demo');

    const demo = detail(page, 'demo');
    await expect(demo.getByRole('switch', { name: 'Disabled' })).not.toBeChecked();
    await expect(demo.getByTestId('plugin-holding-back')).toContainText('Holding back.');
    await expect(demo.getByTestId('plugin-holding-back')).toContainText(
      'Release helper and Changelog writer are unavailable until Demo is enabled.',
    );
    await expect(demo).toContainText(PLUGINS_COPY.enableNote);
    await captureAtEveryWidth(page, 'disabled-plugin');
  });

  test('a provider plugin that needs setup: the neutral status, its missing key with the one action, and where it is saved', async ({
    page,
  }) => {
    await open(page, 'anthropic');

    const anthropic = detail(page, 'anthropic');
    await expect(anthropic).toContainText('Needs setup');
    const secret = anthropic.locator('[data-secret="anthropic-api-key"]');
    await expect(secret).toContainText('anthropic-api-key');
    await expect(secret).toContainText('Missing');
    const addKey = secret.getByRole('button', { name: /Add the key/ });
    await expect(addKey).toBeVisible();
    // At 1280px the row's one action sits at its inline end.
    const { secretBox, addKeyBox } = await readBoxes(page, {
      secretBox: secret,
      addKeyBox: addKey,
    });
    expect(
      Math.abs(secretBox.x + secretBox.width - (addKeyBox.x + addKeyBox.width)),
    ).toBeLessThanOrEqual(2);
    await expect(anthropic.getByTestId('plugin-secret-note')).toContainText(
      'readable only by you. The models appear as soon as the key passes a test.',
    );
    await captureAtEveryWidth(page, 'needs-setup');
  });

  test('a running provider plugin with its key saved: the secret reads Set with Replace, and the note about saving a missing key is gone', async ({
    page,
  }) => {
    // The main host has Anthropic connected: its key is saved, and the sample catalog fills its models.
    await withSampleCatalog(page);
    await open(page, 'anthropic', 1280, E2E_BASE_URL);

    const anthropic = detail(page, 'anthropic');
    await expect(anthropic).not.toContainText('Needs setup');
    const secret = anthropic.locator('[data-secret="anthropic-api-key"]');
    await expect(secret).toContainText('anthropic-api-key');
    await expect(secret).toContainText('Set');
    await expect(secret).not.toContainText('Missing');
    await expect(secret.getByRole('button', { name: 'Replace anthropic-api-key' })).toHaveText(
      'Replace',
    );
    await expect(anthropic.getByTestId('plugin-secret-note')).toHaveCount(0);
    await captureAtEveryWidth(page, 'secret-set');
  });

  test('loading shows skeleton rows and then a status line with Cancel, and a failure says so with Try again and Open Health', async ({
    page,
    pageErrors,
  }) => {
    pageErrors.expect({
      pattern: loggedFailedResponse(500, /\/host\/plugins/),
      reason: 'the test answers the read of the plugins with an error to draw the failed state',
    });
    await page.clock.install();
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route('**/host/plugins', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      await held;
      return route.fulfill({ status: 500, json: { error: 'failed' } });
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${E2E_SHOWCASE_URL}${ROUTE}`);

    // The navigation and the heading are real while the rows are placeholders.
    await expect(page.getByRole('heading', { level: 1, name: 'Plugins' })).toBeVisible();
    await page.clock.runFor(400);
    await expect(page.locator('.cinder-skeleton-group')).toBeVisible();
    await captureAtEveryWidth(page, 'loading');
    await page.clock.runFor(10_000);
    await expect(page.getByText(PLUGINS_COPY.loading.stillLoading)).toBeVisible();
    await expect(page.getByRole('button', { name: PLUGINS_COPY.loading.cancel })).toBeVisible();
    await captureAtEveryWidth(page, 'still-loading');

    release?.();
    const failed = page.getByTestId('plugins-load-failed');
    await expect(failed).toContainText('Couldn’t load plugins.');
    await expect(failed).toContainText(
      'The server answered with an error (500). Nothing you did caused it.',
    );
    await expect(failed.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(failed.getByRole('link', { name: 'Open Health' })).toHaveAttribute(
      'href',
      '/health',
    );
    await captureAtEveryWidth(page, 'load-failed');
  });

  test('enabling a disabled plugin asks first, in a confirm dialog that says it restarts, and Cancel changes nothing', async ({
    page,
    checkA11y,
  }) => {
    await open(page, 'demo');
    const restarts: string[] = [];
    page.on('request', (request) => {
      // Reads of the Bureau are POSTs too; only a write or a restart of the host is a change.
      if (request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/host/')) {
        restarts.push(request.url());
      }
    });

    await detail(page, 'demo').getByRole('switch', { name: 'Disabled' }).click();

    const question = page.getByRole('dialog', { name: PLUGINS_COPY.enable.title('Demo') });
    await expect(question).toBeVisible();
    await expect(question).toContainText('Interborough restarts to load it.');
    await expect(question).toContainText(
      'Running work picks up where it stopped; reviews stay waiting.',
    );
    await expect(question.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await expect(question.getByRole('button', { name: 'Enable and restart' })).toBeVisible();
    await checkA11y('settings plugins enable question');
    await captureAtEveryWidth(page, 'enable-confirm');

    await question.getByRole('button', { name: 'Cancel' }).click();
    await expect(question).toBeHidden();
    await expect(detail(page, 'demo').getByRole('switch', { name: 'Disabled' })).not.toBeChecked();
    expect(restarts).toEqual([]);
  });

  test('disabling a plugin asks first, in a confirm dialog that lists what depends on it before restarting', async ({
    page,
    checkA11y,
  }) => {
    await open(page, 'guardrails');

    await detail(page, 'guardrails').getByRole('switch', { name: 'Enabled' }).click();

    const question = page.getByRole('dialog', { name: PLUGINS_COPY.disable.title('Guardrails') });
    await expect(question).toBeVisible();
    await expect(question).toContainText('Interborough restarts to unload it. What depends on it:');
    await expect(question).toContainText(PLUGINS_COPY.disable.reassurance);
    await expect(question.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await expect(question.getByRole('button', { name: 'Disable and restart' })).toBeVisible();
    await checkA11y('settings plugins disable question');
    await captureAtEveryWidth(page, 'disable-confirm');

    await question.getByRole('button', { name: 'Cancel' }).click();
    await expect(question).toBeHidden();
    await expect(detail(page, 'guardrails').getByRole('switch', { name: 'Enabled' })).toBeChecked();
  });

  /** A run of a Demo agent as `bureau.tasks.list` shows it. */
  const runOf = (id: string, status: string, agentName: string, openWaits: unknown[] = []) => ({
    id,
    contextId: `session-${id}`,
    agentName,
    owner: 'anonymous:local',
    actor: null,
    kind: 'chat',
    origin: { kind: 'chat' },
    status,
    finishReason: null,
    statusMessage: null,
    createdAt: '2026-11-02T09:00:00.000Z',
    updatedAt: '2026-11-02T10:00:00.000Z',
    cleanup: null,
    openWaits,
  });

  /** Answers the reads the disable question makes of the runs in flight, and sends every other call on. */
  async function answerRuns(
    page: Page,
    options: {
      failing?: boolean;
      /** How many runs are working, beyond the one that waits on a person. */
      working?: number;
      /** Holds the read of the runs until this settles, to capture the switch while it waits. */
      hold?: Promise<void>;
    } = {},
  ) {
    const { failing = false, working = 1, hold } = options;
    const titles: Record<string, string> = {
      'session-run-1': 'Weekly changelog',
      'session-run-2': 'Triage the inbox',
      'session-run-3': 'Draft the release notes',
      'session-run-4': 'Summarise the board',
      'session-run-5': 'Answer the customer',
      'session-run-6': 'Sort the receipts',
      'session-run-7': 'Plan the offsite',
    };
    await page.route('**/bureau/jsonrpc', async (route) => {
      const body = route.request().postDataJSON() as {
        id: unknown;
        method: string;
        params: { status?: string; contextId?: string };
      };
      if (body.method === 'bureau.tasks.list') {
        await hold;
        if (failing) return route.fulfill({ status: 500, json: { error: 'The server is down.' } });
        const byStatus: Record<string, unknown[]> = {
          working: [
            runOf('run-1', 'working', 'demo:echo'),
            // Runs 3 and on are working too, so a plugin can have more than the five that are named.
            ...Array.from({ length: working - 1 }, (_, index) =>
              runOf(`run-${String(index + 3)}`, 'working', 'demo:echo'),
            ),
          ],
          'input-required': [
            runOf('run-2', 'input-required', 'demo:request-human-input', [
              { kind: 'human-wait', reviewId: 'review-1', signalName: 'answer' },
            ]),
          ],
        };
        return route.fulfill({
          json: {
            jsonrpc: '2.0',
            id: body.id,
            result: { tasks: byStatus[body.params.status ?? ''] ?? [], nextPageToken: null },
          },
        });
      }
      if (body.method === 'bureau.contexts.get') {
        const contextId = body.params.contextId ?? '';
        return route.fulfill({
          json: {
            jsonrpc: '2.0',
            id: body.id,
            result: {
              id: contextId,
              owner: 'anonymous:local',
              agentName: 'demo:echo',
              title: titles[contextId] ?? null,
              lastMessagePreview: null,
              parentContextId: null,
              forkedFromMessageId: null,
              model: null,
              effort: null,
              permissionMode: 'on-changes',
              configVersion: 0,
              messageCount: 1,
              createdAt: '2026-11-02T09:00:00.000Z',
              updatedAt: '2026-11-02T10:00:00.000Z',
              activity: 'idle',
            },
          },
        });
      }
      return route.fallback();
    });
  }

  test('disabling a plugin whose agents have runs in flight names them first, and the confirmation fails them', async ({
    page,
    checkA11y,
  }) => {
    await answerRuns(page);
    await open(page, 'demo', 1280, E2E_BASE_URL);

    await detail(page, 'demo').getByRole('switch', { name: 'Enabled' }).click();

    const question = page.getByRole('dialog', { name: PLUGINS_COPY.disable.title('Demo') });
    await expect(question).toBeVisible();
    const runs = question.locator('[data-impact="inFlightRuns"]');
    await expect(runs).toContainText('2 runs');
    await expect(runs).toContainText('Weekly changelog');
    await expect(runs).toContainText('marked failed when Interborough restarts');
    await expect(question).toContainText(PLUGINS_COPY.disable.reassuranceWithRuns);
    await checkA11y('settings plugins disable question with runs in flight');
    await captureAtEveryWidth(page, 'disable-confirm-runs-in-flight');

    await question.getByRole('button', { name: 'Cancel' }).click();
    await expect(question).toBeHidden();
    await expect(detail(page, 'demo').getByRole('switch', { name: 'Enabled' })).toBeChecked();
  });

  test('disabling a plugin still asks when the runs cannot be read, and says any that is going will fail', async ({
    page,
    pageErrors,
    checkA11y,
  }) => {
    // The read is one request for each state a run in flight is in: submitted, working and waiting.
    pageErrors.expect({
      pattern: loggedFailedResponse(500, /\/bureau\/jsonrpc/),
      reason:
        'the test answers the read of the runs in flight with an error to draw the failed read',
      count: 3,
    });
    await answerRuns(page, { failing: true });
    await open(page, 'demo', 1280, E2E_BASE_URL);

    await detail(page, 'demo').getByRole('switch', { name: 'Enabled' }).click();

    const question = page.getByRole('dialog', { name: PLUGINS_COPY.disable.title('Demo') });
    await expect(question).toBeVisible();
    await expect(question.locator('[data-impact="inFlightRuns"]')).toContainText(
      'could not be checked',
    );
    await checkA11y('settings plugins disable question when the runs could not be read');
    await expect(question).toContainText(PLUGINS_COPY.disable.reassuranceRunsUnknown);
    await expect(question).not.toContainText('works as before');
    await expect(
      question.getByRole('button', { name: PLUGINS_COPY.disable.confirm }),
    ).toHaveAttribute('data-cinder-variant', 'danger');
    await captureAtEveryWidth(page, 'disable-confirm-runs-unknown');
    await question.getByRole('button', { name: 'Cancel' }).click();
  });

  test('the switch waits while the runs of a plugin’s agents are read, and the question opens once they are', async ({
    page,
    checkA11y,
  }) => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await answerRuns(page, { hold: held });
    await open(page, 'demo', 1280, E2E_BASE_URL);

    const toggle = detail(page, 'demo').getByRole('switch', { name: 'Enabled' });
    await toggle.click();

    // The read is in flight: the switch is pending (busy, a spinner in its thumb), and no question is open yet.
    await expect(toggle).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await captureAtEveryWidth(page, 'disable-switch-reading-runs');
    release();
    await expect(
      page.getByRole('dialog', { name: PLUGINS_COPY.disable.title('Demo') }),
    ).toBeVisible();
    await expect(toggle).not.toHaveAttribute('aria-busy', 'true');
    await checkA11y('settings plugins disable question after the runs were read');
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  });

  test('a plugin with more runs in flight than are named lists five and counts the rest', async ({
    page,
    checkA11y,
  }) => {
    await answerRuns(page, { working: 7 });
    await open(page, 'demo', 1280, E2E_BASE_URL);

    await detail(page, 'demo').getByRole('switch', { name: 'Enabled' }).click();

    const question = page.getByRole('dialog', { name: PLUGINS_COPY.disable.title('Demo') });
    const runs = question.locator('[data-impact="inFlightRuns"]');
    await expect(runs).toContainText('8 runs');
    await expect(runs).toContainText('3 more');
    await checkA11y('settings plugins disable question with more runs than are named');
    await captureAtEveryWidth(page, 'disable-confirm-runs-and-more');
    await question.getByRole('button', { name: 'Cancel' }).click();
  });

  test('plugin problems: after a startup with problems the page lists each plugin’s problems under its name, and the banner counts them', async ({
    page,
    checkA11y,
  }) => {
    // The sample world starts clean, so the host's answer is changed to the one the board draws, a
    // startup for which only Gemini waits for its key and one plugin is skipped for an invalid
    // setting: Guardrails stands in for Web search (decisions: "Plugins: the sample world uses real
    // plugins"), and the other plugins that wait for a key are taken as set.
    await page.route('**/host/plugins', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const response = await route.fetch();
      const snapshot = await response.json();
      for (const plugin of snapshot.plugins as {
        descriptor: { name: string };
        status: string;
        problems: unknown[];
      }[]) {
        if (['anthropic', 'openai', 'typesafe'].includes(plugin.descriptor.name)) {
          plugin.status = 'running';
          plugin.problems = [];
        }
        if (plugin.descriptor.name === 'guardrails') {
          plugin.status = 'skipped';
          plugin.problems = [
            {
              code: 'configuration-invalid',
              field: 'groundingThreshold',
              message: 'Grounding threshold must be a number from 0 to 1. You entered “high”.',
            },
          ];
        }
      }
      return route.fulfill({ response, json: snapshot });
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${E2E_SHOWCASE_URL}${ROUTE}`);

    const banner = page.getByTestId('plugins-startup-banner');
    await expect(banner).toContainText('2 plugins need attention after a startup with problems');
    await expect(banner).toContainText('Agents and workflows that use them show as unavailable.');
    await expect(banner.getByRole('link', { name: 'Open Plugins' })).toBeVisible();
    const list = page.getByTestId('plugins-attention');
    const gemini = list.locator('[data-plugin-problem="secret-missing"]');
    await expect(gemini).toHaveCount(1);
    await expect(gemini).toContainText('Gemini');
    await expect(gemini).toContainText('Needs setup');
    await expect(gemini).toContainText('A secret isn’t saved yet');
    await expect(gemini).toContainText('gemini-api-key isn’t saved, so Gemini models');
    await expect(gemini.getByRole('button', { name: 'Add the key' })).toBeVisible();
    const card = list.locator('[data-plugin-problem="configuration-invalid"]');
    await expect(card).toContainText('Guardrails');
    await expect(card).toContainText('Not loaded');
    await expect(card).toContainText('A setting is invalid');
    await expect(card).toContainText('Grounding threshold must be a number from 0 to 1.');
    await expect(card.getByRole('button', { name: 'Fix the setting' })).toBeVisible();
    await checkA11y('settings plugins problems');
    await captureAtEveryWidth(page, 'problems');
  });
});
