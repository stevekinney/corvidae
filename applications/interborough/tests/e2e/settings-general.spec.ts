/**
 * Settings › General (board SettingsShell, "General · /settings") on the sample world: the page at
 * 1280 and 375 pixels, a setting saved as its field is left, a value that is refused at its field,
 * a save that does not go through, a remote deployment's locked settings, and the placeholders
 * while the settings load. The restart that follows a saved change is `restart.spec.ts`.
 *
 * Each captioned state is captured for the design review (`design-review-capture.ts`), at the two
 * widths the design draws it at.
 */
import type { Page } from '@playwright/test';

import { SETTINGS_COPY } from '../../src/app/copy.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

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
    await checkA11y('settings general at 1280px');
    await captureAtBothWidths(page, 'ready');

    // Below 640px the navigation is a select under the heading Settings.
    await page.setViewportSize({ width: 375, height: 900 });
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Section' })).toHaveValue('/settings');
    await checkA11y('settings general at 375px');
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
      await route.fulfill({ response, json: answer });
    });
    await openGeneral(page);
    await expect(page.getByRole('heading', { level: 2, name: 'Remote deployment' })).toBeVisible();
    await expect(settingRow(page, 'storage.backend')).toContainText('Postgres and S3');
    await expect(settingRow(page, 'storage.backend')).toContainText('Set by the deployment');
    const locked = settingRow(page, 'engine.workflowClaimRenewInterval');
    await expect(locked).toContainText(SETTINGS_COPY.lockedMessage);
    await expect(locked.getByRole('spinbutton')).toBeDisabled();
    await captureAtBothWidths(page, 'locked-remote');
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
