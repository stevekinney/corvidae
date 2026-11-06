/**
 * Settings › Data and retention (board PageSettingsSections, "Data and retention · /settings/data-
 * and-retention" and "Field error") on the sample world, whose storage alert is firing, and on the
 * seeded host, which has no storage rule. Every change a case makes is one nothing deletes by: the
 * audit window is lengthened and put back, and the field error is never saved.
 *
 * Each captioned state is captured for the design review (`design-review-capture.ts`) at the three
 * widths Settings is drawn at.
 */
import type { Page } from '@playwright/test';

import { DATA_RETENTION_COPY } from '../../src/app/copy.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

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
    for (const [key, name] of [
      ['retention.runs', 'Run history'],
      ['retention.chats', 'Chats'],
      ['retention.memory', 'Memory'],
    ] as const) {
      await expect(row(page, key)).toContainText(name);
      await expect(row(page, key).getByRole('radio', { name: 'Keep forever' })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      await expect(row(page, key).getByRole('spinbutton')).toHaveCount(0);
    }

    // Storage is one read-only row, with the alert firing and a link to Health, and no meter.
    const storage = row(page, 'storage-usage');
    await expect(storage).toContainText('Space used');
    await expect(storage).toContainText('Storage is over its warning level · 1.6 GB');
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
    await captureAtEveryWidth(page, 'field-error');

    await page.reload();
    await expect(
      row(page, 'retention.runs').getByRole('radio', { name: 'Keep forever' }),
    ).toHaveAttribute('aria-checked', 'true');
  });
});
