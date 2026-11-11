/**
 * Settings › Data and retention (board PageSettingsSections, "Data and retention, /settings/data-
 * and-retention" and "Field error") on the sample world, whose storage alert is firing, and on the
 * seeded host, which has no storage rule. Every change a case makes is one nothing deletes by: the
 * audit window is lengthened and put back, and the field error is never saved.
 *
 * Clean-up (rows 50h and 50j) is drawn from the host's own standing; the result of Clean up now is
 * answered by the page's route for the capture, because the number of records a real clean-up
 * removes depends on what the host holds, and a case here must not delete any.
 *
 * Each captioned state is captured for the design review (`design-review-capture.ts`) at the three
 * widths Settings is drawn at.
 */
import type { Page } from '@playwright/test';

import { DATA_RETENTION_COPY } from '../../src/app/copy.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, loggedFailedResponse, test } from './fixtures.ts';

const SOURCE = 'settings-data-and-retention.spec.ts';
const ROUTE = '/settings/data-and-retention';

async function captureAtEveryWidth(page: Page, state: string) {
  for (const width of [1280, 768, 375] as const) {
    await page.setViewportSize({ width, height: 900 });
    await captureForDesignReview(page, { route: ROUTE, state, source: SOURCE });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

const row = (page: Page, key: string) => page.locator(`[data-setting="${key}"]`);

test.describe('Settings › Data and retention', () => {
  test('the four retention rows and the storage row, with a storage alert firing', async ({
    page,
    checkA11y,
  }) => {
    await page.goto(`${E2E_SHOWCASE_URL}${ROUTE}`);

    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(
      'Data and retention',
    );
    await expect(
      page
        .getByRole('navigation', { name: 'Settings sections' })
        .getByRole('link', { name: 'Data and retention', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { level: 1, name: 'Data and retention' })).toBeVisible();
    await expect(page.getByText(DATA_RETENTION_COPY.intro)).toBeVisible();

    // Audit records are deleted after 90 days; the other three are kept for ever.
    const audit = row(page, 'retention.audit');
    await expect(audit).toContainText('Audit records');
    await expect(audit).toContainText('retention.audit');
    await expect(audit.getByRole('radio', { name: 'Delete after' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(audit.getByRole('spinbutton')).toHaveValue('90');
    // The days are readable: the field is wide enough to show them beside their unit and stepper.
    const daysBox = await audit.getByRole('spinbutton').boundingBox();
    expect(daysBox?.width ?? 0).toBeGreaterThan(40);
    // Memory deletes while unset (the memory policy's 90 days), so it offers Delete after alone and
    // shows the window in force (decisions, B11 after round 3).
    const memory = row(page, 'retention.memory');
    await expect(memory).toContainText('Memory');
    await expect(memory.getByRole('radio', { name: 'Keep forever' })).toHaveCount(0);
    await expect(memory.getByRole('radio', { name: 'Delete after' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(memory.getByRole('spinbutton')).toHaveValue('90');
    for (const [key, name] of [
      ['retention.runs', 'Run history'],
      ['retention.chats', 'Chats'],
    ] as const) {
      await expect(row(page, key)).toContainText(name);
      await expect(row(page, key).getByRole('radio', { name: 'Keep forever' })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      await expect(row(page, key).getByRole('spinbutton')).toHaveCount(0);
    }

    // Retention holds its four rows. The windows the board draws no row for follow in a section of
    // their own, read the same way: one label style, a name with the raw key beside it.
    await expect(page.locator('main h2')).toHaveText([
      'Retention',
      'Other retention',
      'Storage',
      'Clean-up',
    ]);
    await expect(page.locator('[data-setting^="retention."]')).toHaveCount(11);
    for (const key of [
      'retention.events',
      'retention.tasks',
      'retention.receipts',
      'retention.logs',
      'retention.notifications',
      'retention.hookDeliveries',
    ]) {
      await expect(row(page, key).locator('.cinder-setting-row__identifier')).toHaveText(key);
      await expect(row(page, key).getByRole('radio', { name: 'Delete after' })).toBeVisible();
    }
    await expect(page.getByText(/older than/i)).toHaveCount(0);
    // Receipts falls back to a finite window when cleared, so it cannot offer Keep forever.
    await expect(
      row(page, 'retention.receipts').getByRole('radio', { name: 'Keep forever' }),
    ).toHaveCount(0);

    // Storage is one read-only row, with the alert firing and a link to Health, and no meter.
    const storage = row(page, 'storage-usage');
    await expect(storage).toContainText('Space used');
    await expect(storage).toContainText('Storage is over its warning level, 1.6 GB');
    await expect(storage).toContainText('Health lists this under Needs attention.');
    await expect(storage.getByRole('link', { name: 'Open Health' })).toHaveAttribute(
      'href',
      '/health',
    );
    await expect(page.getByRole('meter')).toHaveCount(0);
    await expect(page.getByText('Warn at')).toHaveCount(0);
    await checkA11y('settings data and retention');
    await captureAtEveryWidth(page, 'ready');
  });

  test('with no storage rule the row shows the plain size and no warning dot', async ({ page }) => {
    await page.goto(ROUTE);

    const storage = row(page, 'storage-usage');
    await expect(storage.getByTestId('storage-size')).toHaveText(/^\d+(\.\d)? (B|KB|MB|GB|TB)$/);
    await expect(storage.locator('[data-cinder-status]')).toHaveCount(0);
    await expect(storage).not.toContainText('Open Health');
    await captureAtEveryWidth(page, 'storage-no-rule');
  });

  test('a window saves as it is left, and the heading and the row say so', async ({ page }) => {
    await page.goto(ROUTE);

    const audit = row(page, 'retention.audit');
    const days = audit.getByRole('spinbutton');
    await days.fill('365');
    await days.blur();
    await expect(audit).toContainText('Saved just now');
    // The whole number is readable: the field is not narrower than its value.
    expect(await days.evaluate((input) => input.scrollWidth <= input.clientWidth)).toBe(true);
    await expect(page.getByTestId('settings-header-status')).toContainText('Saved just now');
    await captureAtEveryWidth(page, 'saved');

    // It was saved: a reload reads it back. Then it is put back to the host's own 90 days.
    await page.reload();
    await expect(row(page, 'retention.audit').getByRole('spinbutton')).toHaveValue('365');
    const again = row(page, 'retention.audit').getByRole('spinbutton');
    await again.fill('90');
    await again.blur();
    await expect(row(page, 'retention.audit')).toContainText('Saved just now');
  });

  test('a number of days outside 1 to 3650 fails at the field, and nothing is saved', async ({
    page,
  }) => {
    await page.goto(ROUTE);

    const runs = row(page, 'retention.runs');
    await runs.getByRole('radio', { name: 'Delete after' }).click();
    const days = runs.getByRole('spinbutton');
    await days.fill('9999');
    await days.blur();

    await expect(runs).toContainText('Enter a number from 1 to 3650. Nothing was saved.');
    await expect(days).toHaveAttribute('aria-invalid', 'true');
    // Even the value it refuses shows whole, so the person sees what they typed.
    expect(await days.evaluate((input) => input.scrollWidth <= input.clientWidth)).toBe(true);
    await captureAtEveryWidth(page, 'field-error');

    await page.reload();
    await expect(
      row(page, 'retention.runs').getByRole('radio', { name: 'Keep forever' }),
    ).toHaveAttribute('aria-checked', 'true');
  });

  test('a read that fails after the settings were shown puts one banner over the old values, which stay', async ({
    page,
    pageErrors,
  }) => {
    pageErrors.expectEvery({
      pattern: loggedFailedResponse(500, /\/bureau\/jsonrpc/),
      reason: 'the test answers the refresh of the settings with a 500 to draw the banner',
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(ROUTE);
    const audit = row(page, 'retention.audit');
    await expect(audit.getByRole('spinbutton')).toHaveValue('90');

    // The next read of the settings fails, and the window regaining focus asks for one.
    await page.route('**/bureau/jsonrpc', async (route) => {
      const body = route.request().postDataJSON() as { method?: string } | null;
      if (body?.method === 'bureau.settings.get') {
        await route.fulfill({ status: 500, json: { error: 'The server broke.' } });
        return;
      }
      await route.fallback();
    });
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
    });

    const banner = page.getByTestId('settings-refresh-failed');
    await expect(banner).toContainText('Couldn’t refresh these settings.');
    await expect(banner).toContainText('Showing what loaded as of');
    await expect(banner.getByRole('button', { name: 'Try again' })).toBeVisible();
    // The old values stay at full contrast, and no full error state sits beside the banner.
    await expect(audit.getByRole('spinbutton')).toHaveValue('90');
    await expect(page.locator('.cinder-error-state')).toHaveCount(0);
    await captureAtEveryWidth(page, 'refresh-failed');
  });

  test('Clean-up is one row, "Remove expired records", with Clean up now as its own action', async ({
    page,
  }) => {
    await page.goto(`${E2E_SHOWCASE_URL}${ROUTE}`);

    const cleanUp = row(page, 'clean-up');
    await expect(page.locator('main h2').last()).toHaveText('Clean-up');
    await expect(cleanUp).toContainText('Remove expired records');
    await expect(cleanUp).toContainText(/Interborough does this every night at 3:00 AM .+ time\./);
    // The host last cleaned up at 3:00 AM on Sunday, and was off for Monday's.
    await expect(cleanUp).toContainText(/Last cleaned up .*Nov 1, 3:00 AM\./);
    await expect(cleanUp).toContainText(/Skipped .* while Interborough was off\./);
    // The button belongs to the row, and no button of that name is anywhere else on the page.
    await expect(cleanUp.getByRole('button', { name: 'Clean up now' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Clean up now' })).toHaveCount(1);
    await captureAtEveryWidth(page, 'clean-up');
  });

  test('Clean up now reports on its own row how many records it removed, and the button stays', async ({
    page,
  }) => {
    const cleanUps: string[] = [];
    await page.route('**/host/clean-up', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      cleanUps.push(route.request().method());
      return route.fulfill({
        json: {
          at: new Date().toISOString(),
          trigger: 'manual',
          removed: 31,
          byKind: {
            audit: 31,
            reviews: 0,
            memories: 0,
            logs: 0,
            notifications: 0,
            hookDeliveries: 0,
            chats: 0,
          },
          failed: [],
        },
      });
    });
    await page.goto(ROUTE);

    const cleanUp = row(page, 'clean-up');
    await cleanUp.getByRole('button', { name: 'Clean up now' }).click();

    await expect(cleanUp).toContainText('Cleaned up just now. Removed 31 records.');
    await expect(cleanUp).toContainText(/Interborough does this every night at 3:00 AM .+ time\./);
    await expect(cleanUp.getByRole('button', { name: 'Clean up now' })).toBeEnabled();
    expect(cleanUps).toEqual(['POST']);
    await captureAtEveryWidth(page, 'clean-up-result');
  });
});
