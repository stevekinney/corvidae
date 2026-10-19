/**
 * `/audit` (COR-1493): the Bureau's audit trail, searched by type and by the resource a record is
 * about, with the records oldest first, at the two widths the application is built for, and with
 * axe on each. The seeded schedule's creation is in the trail, and so is anything these specs do.
 */
import type { Page } from '@playwright/test';

import { AUDIT_COPY } from '../../src/app/copy.ts';
import { expect, test } from './fixtures.ts';

const WIDTHS = [375, 1280] as const;

const records = (page: Page) => page.locator('[data-record]');

/** The form's own buttons: the shell's search box is another button with Search in its name. */
const form = (page: Page) => page.getByRole('search', { name: AUDIT_COPY.searchLabel });

for (const width of WIDTHS) {
  test(`searches the trail by type and by resource at ${width} pixels, and passes axe`, async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/audit');
    await expect(page.locator('[data-view="audit"]')).toHaveAttribute('data-state', 'ready');
    await expect(page.getByRole('table', { name: AUDIT_COPY.caption })).toBeVisible();
    await expect(records(page).first()).toBeVisible();
    await checkA11y(`audit — the trail at ${width}px`);

    // A free-text type, which includes types outside the audit event types.
    await page.getByLabel(AUDIT_COPY.typeLabel).fill('schedule.created');
    await form(page).getByRole('button', { name: AUDIT_COPY.searchAction, exact: true }).click();
    await expect(page).toHaveURL(/type=schedule\.created/);
    await expect(records(page).first()).toBeVisible();
    await expect(records(page).filter({ hasNotText: 'schedule.created' })).toHaveCount(0);
    await checkA11y(`audit — a search by type at ${width}px`);

    // The resource of the first record found: one schedule, and nothing else.
    const cell = await records(page).first().locator('td').nth(2).innerText();
    const resource = cell.trim();
    expect(resource).toMatch(/^schedule:/);
    await page.getByLabel(AUDIT_COPY.resourceLabel).fill(resource);
    await form(page).getByRole('button', { name: AUDIT_COPY.searchAction, exact: true }).click();
    await expect(page).toHaveURL(/resource=schedule/);
    await expect(records(page).first()).toBeVisible();
    await expect(records(page).filter({ hasNotText: resource })).toHaveCount(0);

    // A type nothing in the trail has is said so, and is not the empty trail.
    await page.getByLabel(AUDIT_COPY.typeLabel).fill('no.such.type');
    await form(page).getByRole('button', { name: AUDIT_COPY.searchAction, exact: true }).click();
    await expect(page.getByRole('heading', { name: AUDIT_COPY.noMatches.title })).toBeVisible();
    await expect(page.locator('[data-view="audit"]')).toHaveAttribute('data-state', 'ready');
    await checkA11y(`audit — a search that finds nothing at ${width}px`);

    await form(page).getByRole('button', { name: AUDIT_COPY.clearAction }).click();
    await expect(records(page).first()).toBeVisible();
    await expect(page).toHaveURL(/\/audit$/);
  });
}

test('a search can be opened from its address, and the filters are in the form', async ({
  page,
}) => {
  await page.goto('/audit?type=schedule.created');

  await expect(page.getByLabel(AUDIT_COPY.typeLabel)).toHaveValue('schedule.created');
  await expect(records(page).first()).toBeVisible();
  await expect(records(page).filter({ hasNotText: 'schedule.created' })).toHaveCount(0);
});
