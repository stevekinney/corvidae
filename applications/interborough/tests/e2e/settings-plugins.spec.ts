/**
 * Settings › Plugins (board PageSettingsSections, "Plugins · /settings/plugins", "Plugin · Save
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

import { PLUGINS_COPY } from '../../src/app/copy.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, loggedFailedResponse, test } from './fixtures.ts';

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

async function open(page: Page, plugin: string, width = 1280) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${E2E_SHOWCASE_URL}${ROUTE}?plugin=${plugin}`);
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
    await expect(
      configuration.locator('[data-configuration-field="blockedPatterns"]'),
    ).toBeVisible();
    await expect(
      configuration.locator('[data-configuration-field="groundingThreshold"]'),
    ).toContainText('groundingThreshold');
    await expect(configuration.getByRole('button', { name: 'Save configuration' })).toBeVisible();
    await expect(configuration).toContainText(PLUGINS_COPY.configuration.note);
    await expect(opened.getByTestId('plugin-in-use')).toContainText('In use.');

    await checkA11y('settings plugins at 1280px');
    await captureAtEveryWidth(page, 'list-and-detail');
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
      '[data-configuration-field="groundingThreshold"] input',
    );
    await field.fill('0.5');
    await page.route('**/host/plugins/guardrails', (route) => route.abort('failed'));

    const save = detail(page, 'guardrails').getByRole('button', { name: 'Save configuration' });
    await save.click();

    const failure = page.getByTestId('plugin-configuration-failed');
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

  test('a disabled plugin: the switch reads Disabled, what it holds back is named, and enabling it is explained next to the switch', async ({
    page,
  }) => {
    await open(page, 'demo');

    const demo = detail(page, 'demo');
    await expect(demo.getByRole('switch', { name: 'Disabled' })).not.toBeChecked();
    await expect(demo.getByTestId('plugin-holding-back')).toContainText('Holding back.');
    await expect(demo.getByTestId('plugin-holding-back')).toContainText(
      'Internal, Release helper and Changelog writer are unavailable until Demo is enabled.',
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
    await expect(secret.getByRole('button', { name: /Add the key/ })).toBeVisible();
    await expect(anthropic.getByTestId('plugin-secret-note')).toContainText(
      'readable only by you. The models appear as soon as the key passes a test.',
    );
    await captureAtEveryWidth(page, 'needs-setup');
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
});
