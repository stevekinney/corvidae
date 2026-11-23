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
import { SETTINGS_COPY } from '../../src/app/copy/settings.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_BASE_URL, E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, loggedFailedResponse, test } from './fixtures.ts';
import { readBoxes } from './read-boxes.ts';
import { withSampleCatalog } from './sample-catalog.ts';

const SOURCE = 'settings-plugins.spec.ts';
const ROUTE = '/settings/plugins';

/** The wide desktops Settings › Plugins is also judged at, where its column stops growing (COR-2509). */
const WIDE_DESKTOP_WIDTHS = [1440, 1920] as const;

/**
 * Captures the screen at the three widths Settings is drawn at: desktop, tablet and phone, and at
 * `widths` when a scene is also judged at others. A scene whose state a resize rebuilds passes
 * `ready`, which brings the state back before each screenshot.
 */
async function captureAtEveryWidth(
  page: Page,
  state: string,
  route = ROUTE,
  widths: readonly number[] = [1280, 768, 375],
  ready?: (page: Page) => Promise<void>,
) {
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await captureForDesignReview(page, { route, state, source: SOURCE, ready });
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
    // A plugin that needs a key has a neutral Needs setup badge.
    await expect(row(page, 'anthropic')).toContainText('Needs setup');
    await expect(row(page, 'anthropic').locator('.cinder-badge')).toHaveAttribute(
      'data-cinder-variant',
      'neutral',
    );
    await expect(row(page, 'guardrails')).toContainText('Running');
    await expect(row(page, 'guardrails')).toContainText('Package');
    await expect(row(page, 'demo')).toContainText('Disabled');

    const opened = detail(page, 'guardrails');
    await expect(opened.getByRole('heading', { level: 3, name: 'Guardrails' })).toBeVisible();
    await expect(opened.getByRole('switch', { name: 'Enabled' })).toBeChecked();
    await expect(opened).not.toContainText('@lostgradient/plugin-guardrails');
    await expect(opened.getByRole('button', { name: PLUGINS_COPY.copyLocation })).toBeVisible();
    await expect(opened).toContainText('Package plugin, loaded at startup');
    const adds = opened.getByTestId('plugin-adds');
    await expect(adds.locator('[data-contribution="guardrails:code-safety"]')).toBeVisible();
    await expect(adds).not.toContainText('guardrails:code-safety');

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
    await expect(opened.getByTestId('plugin-in-use')).toHaveText(
      PLUGINS_COPY.inUse.nothing('Guardrails'),
    );

    await checkA11y('settings plugins at 1280px');

    // On a phone the restart banner's two buttons are compact and side by side, not bars across
    // the banner (COR-2511). The sample world holds one change that waits for a restart.
    const summary = page.getByTestId('settings-restart-summary');
    for (const width of [375, 320] as const) {
      await page.setViewportSize({ width, height: 900 });
      await expect(summary).toBeVisible();
      await expect(page.getByTestId('settings-revert')).toBeVisible();
      await expect(summary.getByRole('button', { name: 'Restart now' })).toBeVisible();
      // One evaluation reads every box, so they all come from one layout.
      const boxes = await readBoxes(page, {
        banner: summary,
        revert: page.getByTestId('settings-revert'),
        restartNow: summary.getByRole('button', { name: 'Restart now' }),
      });
      for (const key of ['revert', 'restartNow'] as const) {
        expect(
          boxes[key].width,
          `${key} is narrower than half the banner at ${width}px`,
        ).toBeLessThan(boxes.banner.width / 2);
      }
      if (width === 375) {
        const { revert, restartNow } = boxes;
        expect(
          revert.y < restartNow.y + restartNow.height && restartNow.y < revert.y + revert.height,
          'the two buttons share a line at 375px',
        ).toBe(true);
      }
    }

    // On a phone the plugin is flat on the page: no border, radius or background of its own, and
    // its text starts where the page's heading does, with nothing overflowing (COR-2512).
    const frame = page.locator('.ib-plugins__frame');
    for (const width of [375, 320] as const) {
      await page.setViewportSize({ width, height: 900 });
      await expect(opened.getByRole('heading', { level: 3, name: 'Guardrails' })).toBeVisible();
      const flat = await frame.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          border: style.borderTopWidth,
          radius: style.borderTopLeftRadius,
          background: style.backgroundColor,
        };
      });
      expect(flat, `the frame is a plain wrapper at ${width}px`).toEqual({
        border: '0px',
        radius: '0px',
        background: 'rgba(0, 0, 0, 0)',
      });
      const overflow = await page.evaluate(() => {
        const scroller = document.scrollingElement;
        return scroller === null ? 0 : scroller.scrollWidth - scroller.clientWidth;
      });
      expect(overflow, `nothing overflows horizontally at ${width}px`).toBe(0);
      if (width === 320) {
        const boxes = await readBoxes(page, {
          pageHeading: page.getByRole('heading', {
            level: 1,
            name: SETTINGS_COPY.general.narrowTitle,
          }),
          pluginName: opened.getByRole('heading', { level: 3, name: 'Guardrails' }),
        });
        expect(
          Math.abs(boxes.pluginName.x - boxes.pageHeading.x),
          'the plugin text starts at the page heading’s edge at 320px',
        ).toBeLessThanOrEqual(2);
      }
    }

    // On a wide desktop the restart notice, the heading area and the frame share one inline start
    // and one inline end (COR-2509), with the restart still pending.
    for (const width of WIDE_DESKTOP_WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await expect(summary).toBeVisible();
      await expect(opened.getByRole('heading', { level: 3, name: 'Guardrails' })).toBeVisible();
      const edges = await readBoxes(page, {
        banner: summary,
        heading: page.locator('.weft-settings__title-area'),
        frame,
      });
      for (const key of ['heading', 'frame'] as const) {
        expect(
          Math.abs(edges[key].x - edges.banner.x),
          `${key} starts where the banner does at ${width}px`,
        ).toBeLessThanOrEqual(2);
        expect(
          Math.abs(edges[key].x + edges[key].width - (edges.banner.x + edges.banner.width)),
          `${key} ends where the banner does at ${width}px`,
        ).toBeLessThanOrEqual(2);
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await captureAtEveryWidth(page, 'list-and-detail', ROUTE, [
      1280,
      768,
      375,
      ...WIDE_DESKTOP_WIDTHS,
    ]);
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
    await expect(opened).not.toContainText('@lostgradient/plugin-inspectors');
    await expect(opened.getByRole('button', { name: PLUGINS_COPY.copyLocation })).toBeVisible();
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
    for (const wideWidth of [1264, 1280, ...WIDE_DESKTOP_WIDTHS] as const) {
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
        owner: controlOf('account', 'input'),
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
      // A group of one short field draws it in the same column: the Owner control starts where the
      // text control does, not at the row's start (COR-2510).
      expect(Math.abs(boxes.owner.x - boxes.searchAddress.x)).toBeLessThanOrEqual(2);
      // The tag list sits under its row at the row's width, not squeezed into the control column.
      expect(boxes.tags.width).toBeGreaterThan(boxes.tagsRow.width * 0.6);
      expect(
        Math.abs(boxes.form.x + boxes.form.width - (boxes.save.x + boxes.save.width)),
      ).toBeLessThanOrEqual(2);
      if (wideWidth === 1920) {
        // No paragraph of the detail pane is wider than about 90 characters of its own type (the
        // widest a line can be); the rows above stayed side by side at this width.
        const widest = await detail(page, 'guardrails').evaluate((pane) => {
          let most = 0;
          for (const paragraph of pane.querySelectorAll('p')) {
            const probe = document.createElement('span');
            probe.style.cssText = 'position: absolute; visibility: hidden; inline-size: 1ch';
            paragraph.append(probe);
            const characterWidth = probe.getBoundingClientRect().width;
            probe.remove();
            most = Math.max(most, paragraph.getBoundingClientRect().width / characterWidth);
          }
          return most;
        });
        expect(widest, 'the longest line of text at 1920px, in characters').toBeLessThanOrEqual(90);
      }
    }

    const layout = page.locator('.ib-plugins__frame > .cinder-list-detail');
    for (const width of [1280, 375, 320, ...WIDE_DESKTOP_WIDTHS] as const) {
      await page.setViewportSize({ width, height: 900 });
      // ListDetail measures its root and renders `stacked` below 600px, replacing the detail pane
      // when that breakpoint flips. Wait for the new layout before scrolling the form.
      await expect(layout).toHaveAttribute(
        'data-cinder-layout',
        width <= 375 ? 'stacked' : 'split',
      );
      if (width <= 375) {
        const boxes = await readBoxes(page, {
          searchAddressLabel: labelOf('searchAddress'),
          searchAddress: controlOf('searchAddress', 'input'),
          regionLabel: labelOf('region'),
          region: controlOf('region', 'select'),
          includeSnippetsLabel: labelOf('includeSnippets'),
          includeSnippets: controlOf('includeSnippets', '[role="switch"]'),
        });
        for (const key of ['searchAddress', 'region', 'includeSnippets'] as const) {
          const label = boxes[`${key}Label`];
          const control = boxes[key];
          expect(
            control.y,
            `${key} control stacks below its label at ${width}px`,
          ).toBeGreaterThanOrEqual(label.y + label.height);
        }
        const overflow = await page.evaluate(() => {
          const scroller = document.scrollingElement;
          return scroller === null ? 0 : scroller.scrollWidth - scroller.clientWidth;
        });
        expect(overflow, `nothing overflows horizontally at ${width}px`).toBe(0);
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
    await expect(secret).toContainText('Anthropic API key');
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
    // Where or how the key is stored never renders (owner, 2026-11-19).
    await expect(anthropic.getByTestId('plugin-secret-note')).toHaveText(
      'The models appear as soon as the key passes a test.',
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
    await expect(secret).toContainText('Anthropic API key');
    await expect(secret).toContainText('Set');
    await expect(secret).not.toContainText('Missing');
    await expect(secret.getByRole('button', { name: 'Replace Anthropic API key' })).toHaveText(
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
    // The placeholder is the page's own list and detail panes, announced once as loading (COR-2513).
    const loading = page.getByTestId('plugins-loading');
    await expect(loading.locator('.cinder-skeleton-row').first()).toBeVisible();
    // One live region says it, however many rows are drawn; the still-loading line is empty so far.
    await expect(loading.getByText(PLUGINS_COPY.loading.label, { exact: true })).toHaveCount(1);
    await expect(loading.getByText(PLUGINS_COPY.loading.stillLoading)).toHaveCount(0);
    // A resize across the list-and-detail layouts builds the placeholder again, so each capture
    // brings the state back first: the rows after their delay, then the still-loading line.
    await captureAtEveryWidth(page, 'loading', ROUTE, [1280, 768, 375], async (capturePage) => {
      await capturePage.clock.runFor(400);
      await expect(
        capturePage.getByTestId('plugins-loading').locator('.cinder-skeleton-row').first(),
      ).toBeVisible();
    });
    const stillLoading = async (capturePage: Page) => {
      await capturePage.clock.runFor(10_400);
      await expect(capturePage.getByText(PLUGINS_COPY.loading.stillLoading)).toBeVisible();
      await expect(
        capturePage.getByRole('button', { name: PLUGINS_COPY.loading.cancel }),
      ).toBeVisible();
    };
    await stillLoading(page);
    await captureAtEveryWidth(page, 'still-loading', ROUTE, [1280, 768, 375], stillLoading);

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

  test('the loading placeholder has the loaded page’s shape: its frame, list column and detail pane sit where the loaded ones do, and the heading does not move', async ({
    page,
  }) => {
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route('**/host/plugins', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      await held;
      return route.fallback();
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${E2E_SHOWCASE_URL}${ROUTE}`);

    const frame = page.locator('.ib-plugins__frame');
    const placeholder = page.getByTestId('plugins-loading');
    const regions = {
      heading: page.getByRole('heading', { level: 1, name: 'Plugins' }),
      frame,
      list: frame.locator('.cinder-list-detail__list'),
      detail: frame.locator('.cinder-list-detail__detail'),
    };
    // Settled: the placeholder rows are drawn (they wait 300 ms) before any box is read.
    await expect(placeholder.locator('.cinder-skeleton-row').first()).toBeVisible();
    await expect(regions.detail).toBeVisible();
    const waiting = await readBoxes(page, regions);

    release?.();
    await expect(row(page, 'inspectors')).toBeVisible();
    await expect(detail(page, 'inspectors')).toBeVisible();
    await expect(placeholder).toHaveCount(0);
    const loaded = await readBoxes(page, regions);

    expect(Math.abs(waiting.frame.x - loaded.frame.x), 'frame left edge').toBeLessThanOrEqual(2);
    expect(
      Math.abs(waiting.frame.x + waiting.frame.width - (loaded.frame.x + loaded.frame.width)),
      'frame right edge',
    ).toBeLessThanOrEqual(2);
    expect(Math.abs(waiting.frame.y - loaded.frame.y), 'frame top edge').toBeLessThanOrEqual(2);
    // The list column keeps its width and sits beside the detail pane.
    expect(
      Math.abs(waiting.list.width - loaded.list.width),
      'list column width',
    ).toBeLessThanOrEqual(2);
    expect(waiting.detail.x, 'the detail pane is beside the list').toBeGreaterThan(
      waiting.list.x + waiting.list.width - 2,
    );
    expect(
      Math.abs(waiting.heading.y - loaded.heading.y),
      'heading does not move',
    ).toBeLessThanOrEqual(1);
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
    await page.route('**/jsonrpc', async (route) => {
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
      pattern: loggedFailedResponse(500, /\/jsonrpc/),
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
    ).toContainClass('button-variant-danger');
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
