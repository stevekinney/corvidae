/**
 * Settings › General (board SettingsShell, "General · /settings") on the sample world: the page at
 * 1280 and 375 pixels, a setting saved as its field is left, a value that is refused at its field,
 * a save that does not go through, the banner's Revert with its Undo toast, a remote deployment's
 * locked settings, and the placeholders while the settings load. The restart that follows a saved change is `restart.spec.ts`.
 *
 * Each captioned state is captured for the design review (`design-review-capture.ts`), at the two
 * widths the design draws it at.
 */
import type { Page } from '@playwright/test';

import { SETTINGS_COPY, VIEW_COPY } from '../../src/app/copy.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, loggedFailedResponse, test } from './fixtures.ts';

const SOURCE = 'settings-general.spec.ts';
const ROUTE = '/settings';

const settingRow = (page: Page, key: string) => page.locator(`[data-setting="${key}"]`);

/** Captures the screen at the two widths the design draws it at. */
async function captureAtBothWidths(page: Page, state: string) {
  for (const width of [1280, 375] as const) {
    await page.setViewportSize({ width, height: 900 });
    await captureForDesignReview(page, { route: ROUTE, state, source: SOURCE });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

async function openGeneral(page: Page) {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${E2E_SHOWCASE_URL}${ROUTE}`);
  await expect(page.locator('[data-view="settings"]')).toHaveAttribute('data-state', 'ready');
  await expect(settingRow(page, 'tools.wakeup')).toBeVisible();
}

test.describe('Settings › General', () => {
  test('ready: four sections of rows under a General heading, with the section navigation beside them', async ({
    page,
    checkA11y,
  }) => {
    await openGeneral(page);
    await expect(page.getByRole('heading', { level: 1, name: 'General' })).toBeVisible();
    await expect(page.getByText(SETTINGS_COPY.general.intro)).toBeVisible();
    for (const heading of ['Tools', 'Runs', 'Storage', 'Your preferences']) {
      await expect(page.getByRole('heading', { level: 2, name: heading })).toBeVisible();
    }
    await expect(page.getByRole('heading', { name: /engine/i })).toHaveCount(0);
    await expect(settingRow(page, 'storage.backend')).toContainText('SQLite · on this machine');
    await expect(
      page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link'),
    ).toHaveText([
      'General',
      'Models',
      'Allowed models',
      'A2A',
      'Plugins',
      'Data and retention',
      'API reference',
    ]);
    // At 640px and wider the navigation is a 170px column.
    const column = await page.getByRole('navigation', { name: 'Settings sections' }).boundingBox();
    expect(Math.round(column?.width ?? 0)).toBe(170);
    // The sample world holds one saved change that waits for a restart.
    const banner = page.getByTestId('settings-restart-summary');
    await expect(banner).toContainText('1 change waits for a restart');
    await expect(settingRow(page, 'engine.workflowClaimRenewInterval')).toContainText(
      'Saved, waiting for a restart',
    );
    await expect(
      settingRow(page, 'engine.workflowClaimRenewInterval').getByRole('spinbutton'),
    ).toHaveValue('15');
    await expect(banner.getByRole('button', { name: 'Revert 1 change' })).toBeVisible();
    await expect(banner.getByRole('button', { name: 'Restart now' })).toBeVisible();
    const cap = settingRow(page, 'engine.maxConcurrentRuns');
    await expect(cap).toContainText('Max concurrent runs');
    await expect(cap).toContainText(
      'The most workflow runs that execute at the same time on this machine.',
    );
    await expect(cap.getByRole('spinbutton')).toHaveValue('4');
    await expect(cap).toContainText('runs');
    await checkA11y('settings general at 1280px');
    await captureAtBothWidths(page, 'ready');

    // Below 640px the navigation is a select under the heading Settings.
    await page.setViewportSize({ width: 375, height: 900 });
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Section' })).toHaveValue('/settings');
    // The banner stacks: its Revert and Restart now sit below its words.
    const words = await banner.getByText('Running work picks up where it stopped').boundingBox();
    const revert = await banner.getByRole('button', { name: 'Revert 1 change' }).boundingBox();
    expect(revert?.y ?? 0).toBeGreaterThan((words?.y ?? 0) + (words?.height ?? 0) - 1);
    await checkA11y('settings general at 375px');
  });

  test('reverted: Revert puts the waiting change back to the running value, with an Undo toast', async ({
    page,
  }) => {
    await openGeneral(page);
    const banner = page.getByTestId('settings-restart-summary');
    const row = settingRow(page, 'engine.workflowClaimRenewInterval');
    const saved = await row.getByRole('spinbutton').inputValue();
    await banner.getByRole('button', { name: 'Revert 1 change' }).click();
    await expect(row.getByRole('status')).toContainText('Reverted · in effect now');
    // The host runs the 30 seconds it started with; the 15 it saved waited for a restart.
    await expect(row.getByRole('spinbutton')).toHaveValue('30');
    await expect(banner).toHaveCount(0);
    const toast = page.locator('.cinder-toast', {
      hasText: 'Reverted 1 change. Nothing needs a restart.',
    });
    await expect(toast.getByRole('button', { name: 'Undo' })).toBeVisible();
    await captureAtBothWidths(page, 'reverted');

    // Undo puts the sample world's saved change back for the specs that follow.
    await toast.getByRole('button', { name: 'Undo' }).click();
    await expect(row.getByRole('status')).toContainText('Saved, waiting for a restart');
    await expect(row.getByRole('spinbutton')).toHaveValue(saved);
  });

  test('saved: a switch saves as it changes, and its row says Saved just now', async ({ page }) => {
    await openGeneral(page);
    const row = settingRow(page, 'tools.wakeup');
    const toggle = row.getByRole('switch', { name: 'Wakeup' });
    const before = await toggle.getAttribute('aria-checked');
    try {
      await toggle.click();
      await expect(row.getByRole('status')).toContainText('Saved just now');
      await captureAtBothWidths(page, 'saved');
    } finally {
      if ((await toggle.getAttribute('aria-checked')) !== before) await toggle.click();
      await expect(row).toHaveAttribute('data-dirty', 'false');
    }
  });

  test('invalid value: a number past its limit fails at its field, with Nothing was saved', async ({
    page,
  }) => {
    await openGeneral(page);
    const row = settingRow(page, 'logs.maximumLinesPerRun');
    await row.getByRole('spinbutton').fill('9999');
    await settingRow(page, 'tools.wakeup').getByRole('switch').focus();
    await expect(row).toContainText(SETTINGS_COPY.nothingSaved);
    await expect(row.locator('[aria-invalid="true"]')).toHaveCount(1);
    await captureAtBothWidths(page, 'invalid-value');
  });

  test('save failed: the typed value stays in the field, with Retry', async ({
    page,
    pageErrors,
  }) => {
    pageErrors.expectEvery({
      pattern: /Failed to load resource|ERR_CONNECTION_FAILED|status of 5\d\d/,
      reason: 'the test refuses the save, so the request fails',
    });
    await openGeneral(page);
    await page.route('**/bureau/jsonrpc', async (route) => {
      const body = route.request().postDataJSON() as { method?: string } | null;
      if (body?.method === 'bureau.settings.update') {
        await route.abort('connectionfailed');
        return;
      }
      await route.continue();
    });
    const row = settingRow(page, 'logs.maximumLinesPerRun');
    await row.getByRole('spinbutton').fill('321');
    await settingRow(page, 'tools.wakeup').getByRole('switch').focus();
    await expect(row).toContainText(SETTINGS_COPY.couldNotSave);
    await expect(row.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(row.getByRole('spinbutton')).toHaveValue('321');
    await captureAtBothWidths(page, 'save-failed');
  });

  test('locked · remote mode: the backend and what the deployment owns sit in a Remote deployment card', async ({
    page,
  }) => {
    await page.route('**/host/paths', async (route) => {
      const response = await route.fetch();
      const paths = (await response.json()) as Record<string, unknown>;
      await route.fulfill({
        response,
        json: {
          ...paths,
          mode: 'remote',
          database: { kind: 'postgres', location: 'db.internal:5432/interborough' },
          locked: { configuration: 'deployment', providerKeys: 'deployment' },
        },
      });
    });
    await page.route('**/bureau/jsonrpc', async (route) => {
      const body = route.request().postDataJSON() as { method?: string } | null;
      if (body?.method !== 'bureau.settings.get') {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const answer = (await response.json()) as {
        result: { keys: Record<string, { locked: boolean; lockReason?: string }> };
      };
      for (const key of [
        'durable',
        'engine.workflowClaimTtl',
        'engine.workflowClaimRenewInterval',
      ]) {
        const state = answer.result.keys[key];
        if (state !== undefined) {
          state.locked = true;
          state.lockReason = 'shared-storage';
        }
      }
      // The host locks the run cap for the deployment in remote mode (`host.ts`).
      const cap = answer.result.keys['engine.maxConcurrentRuns'];
      if (cap !== undefined) {
        cap.locked = true;
        cap.lockReason = 'deployment';
      }
      await route.fulfill({ response, json: answer });
    });
    await openGeneral(page);
    await expect(page.getByRole('heading', { level: 2, name: 'Remote deployment' })).toBeVisible();
    await expect(settingRow(page, 'storage.backend')).toContainText('Postgres and S3');
    await expect(settingRow(page, 'storage.backend')).toContainText('Set by the deployment');
    const locked = settingRow(page, 'engine.workflowClaimRenewInterval');
    await expect(locked).toContainText(SETTINGS_COPY.lockedMessage);
    await expect(locked.getByRole('spinbutton')).toBeDisabled();
    const cap = settingRow(page, 'engine.maxConcurrentRuns');
    await expect(cap).toContainText('The most workflow runs that execute at the same time.');
    await expect(cap).not.toContainText('on this machine');
    await expect(cap).toContainText(SETTINGS_COPY.lockedMessage);
    await expect(cap.getByRole('spinbutton')).toBeDisabled();
    await expect(cap.getByRole('spinbutton')).toHaveValue('4');
    await captureAtBothWidths(page, 'locked-remote');
  });

  test('load failed: with nothing to show, the full error state replaces the section, with Try again and no banner', async ({
    page,
    pageErrors,
  }) => {
    // The test answers every read of the settings with an error, and Chromium logs each one. How
    // many there are is not the test's to say: the view's probe and the page's own reads both ask.
    pageErrors.expectEvery({
      pattern: loggedFailedResponse(500, /\/bureau\/jsonrpc/),
      reason: 'the test answers the reads of the settings with a 500',
    });
    await page.route('**/bureau/jsonrpc', async (route) => {
      const body = route.request().postDataJSON() as { method?: string } | null;
      if (body?.method === 'bureau.settings.get' || body?.method === 'bureau.settings.schema') {
        await route.fulfill({ status: 500, json: { error: 'The server broke.' } });
        return;
      }
      await route.fallback();
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${E2E_SHOWCASE_URL}${ROUTE}`);

    const frame = page.locator('[data-view="settings"]');
    await expect(frame).toHaveAttribute('data-state', 'error');
    // The section's content is the error state; the navigation and the heading stay, as on Plugins.
    await expect(frame.getByRole('heading', { level: 1 })).toHaveText('General');
    await expect(
      frame.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', {
        name: 'General',
        exact: true,
      }),
    ).toHaveAttribute('aria-current', 'page');
    await expect(frame.getByRole('heading', { level: 2 })).toHaveText(
      VIEW_COPY.settings.error.title,
    );
    await expect(frame.getByRole('button', { name: 'Try again' })).toBeVisible();
    // No rows, and no refresh banner beside it.
    await expect(settingRow(page, 'tools.wakeup')).toHaveCount(0);
    await expect(frame.getByRole('alert')).toHaveCount(1);
    await expect(page.getByTestId('settings-refresh-failed')).toHaveCount(0);
    await captureAtBothWidths(page, 'load-failed');
  });

  test('loading: the navigation and heading are real, the rows are placeholders after 300 ms, and Still loading follows at 10 s', async ({
    page,
  }) => {
    await page.clock.install();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/bureau/jsonrpc', async (route) => {
      const body = route.request().postDataJSON() as { method?: string } | null;
      if (body?.method === 'bureau.settings.get' || body?.method === 'bureau.settings.schema') {
        await held;
      }
      await route.continue();
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${E2E_SHOWCASE_URL}${ROUTE}`);
    await expect(page.getByRole('heading', { level: 1, name: 'General' })).toBeVisible();
    await expect(
      page
        .getByRole('navigation', { name: 'Settings sections' })
        .getByRole('link', { name: 'General' }),
    ).toBeVisible();
    await page.clock.runFor(400);
    await expect(page.locator('.cinder-skeleton-group')).toBeVisible();
    await captureAtBothWidths(page, 'loading');
    await page.clock.runFor(10_000);
    await expect(page.getByText(SETTINGS_COPY.general.loading.stillLoading)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await captureAtBothWidths(page, 'still-loading');
    release();
  });
});
