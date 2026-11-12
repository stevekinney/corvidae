/**
 * `/health/audit` (COR-1493, COR-1658, COR-2018): the audit log on the main host, at the two widths
 * the application is built for, with axe on each. The seeded schedule's creation is in the log, and
 * so is anything these specs do. The filters are the ones the page offers (who, period, action and
 * a search), held in the address; the sample world's own log is read in `health-audit.spec.ts`.
 */
import type { Page } from '@playwright/test';

import { AUDIT_COPY } from '../../src/app/copy/audit.ts';
import { expect, test } from './fixtures.ts';

const WIDTHS = [375, 1280] as const;

const events = (page: Page) => page.locator('tbody tr[data-cinder-row-id]');

for (const width of WIDTHS) {
  test(`reads the log and narrows it by action and by text at ${width} pixels, and passes axe`, async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/health/audit');
    await expect(page.locator('[data-view="audit"]')).toHaveAttribute('data-state', 'ready');
    await expect(page.getByRole('region', { name: AUDIT_COPY.caption })).toBeVisible();
    await expect(events(page).first()).toBeVisible();
    await checkA11y(`audit — the log at ${width}px`);

    // The action reaches the Bureau as the types of one kind, and is held in the address.
    await page.getByLabel(AUDIT_COPY.actionLabel, { exact: true }).selectOption('started');
    await expect(page).toHaveURL(/action=started/);
    await expect(events(page).first()).toBeVisible();
    await expect(events(page).filter({ hasNotText: /Started|Server started/ })).toHaveCount(0);

    // Text that matches nothing is the filtered empty state, and says so; it is not the empty log.
    await page.getByPlaceholder(AUDIT_COPY.textPlaceholder).fill('no-such-event-anywhere');
    await expect(
      page.getByRole('heading', {
        name: AUDIT_COPY.noMatches.titleForSearch('no-such-event-anywhere'),
      }),
    ).toBeVisible();
    await expect(page.locator('[data-view="audit"]')).toHaveAttribute('data-state', 'ready');
    await checkA11y(`audit — a search that finds nothing at ${width}px`);

    await page.getByRole('button', { name: AUDIT_COPY.noMatches.clear }).click();
    await expect(events(page).first()).toBeVisible();
    await expect(page).toHaveURL(/\/health\/audit$/);
  });
}

test('a search can be opened from its address, and the filters are in the row', async ({
  page,
}) => {
  await page.goto('/health/audit?actor=interborough&period=30d&action=started');

  await expect(page.getByLabel(AUDIT_COPY.actorLabel, { exact: true })).toHaveValue('interborough');
  await expect(page.getByLabel(AUDIT_COPY.periodLabel, { exact: true })).toHaveValue('30d');
  await expect(page.getByLabel(AUDIT_COPY.actionLabel, { exact: true })).toHaveValue('started');
  await expect(events(page).first()).toBeVisible();
});
