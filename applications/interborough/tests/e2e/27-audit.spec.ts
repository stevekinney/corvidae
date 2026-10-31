/**
 * `/health/audit` (COR-1493, COR-1658): the Bureau's audit trail, searched by type and by the resource a
 * record is about, with the records oldest first, at the two widths the application is built for,
 * and with axe on each. The seeded schedule's creation is in the trail, and so is anything these
 * specs do. Nothing here types a syntax: the type is chosen from the types the trail has shown (or
 * typed under Other), and the resource is a kind and an id, from which the page builds
 * `schedule:<id>`.
 */
import type { Page } from '@playwright/test';

import { AUDIT_COPY } from '../../src/app/copy.ts';
import { expect, test } from './fixtures.ts';

const WIDTHS = [375, 1280] as const;

const records = (page: Page) => page.locator('button[data-record]');

const typeSelect = (page: Page) => page.getByLabel(AUDIT_COPY.typeLabel, { exact: true });
const resourceKind = (page: Page) => page.getByLabel(AUDIT_COPY.resourceLabel, { exact: true });

/** The form's own buttons: the shell's search box is another button with Search in its name. */
const form = (page: Page) => page.getByRole('search', { name: AUDIT_COPY.searchLabel });

for (const width of WIDTHS) {
  test(`searches the trail by type and by resource at ${width} pixels, and passes axe`, async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/health/audit');
    await expect(page.locator('[data-view="audit"]')).toHaveAttribute('data-state', 'ready');
    await expect(page.getByRole('region', { name: AUDIT_COPY.caption })).toBeVisible();
    await expect(records(page).first()).toBeVisible();
    await checkA11y(`audit — the trail at ${width}px`);

    // A type the trail has shown, chosen from the list.
    await expect(typeSelect(page).locator('option', { hasText: 'schedule.created' })).toHaveCount(
      1,
    );
    await typeSelect(page).selectOption('schedule.created');
    await form(page).getByRole('button', { name: AUDIT_COPY.searchAction, exact: true }).click();
    await expect(page).toHaveURL(/type=schedule\.created/);
    await expect(records(page).first()).toBeVisible();
    await expect(records(page).filter({ hasNotText: 'schedule.created' })).toHaveCount(0);
    await checkA11y(`audit — a search by type at ${width}px`);

    // The resource of the first record found: one schedule, and nothing else. The picker takes its
    // kind and its id, and builds `schedule:<id>` itself.
    const resourceText = await records(page).first().locator('.ib-audit__resource').innerText();
    const resource = resourceText.trim();
    expect(resource).toMatch(/^schedule:/);
    await resourceKind(page).selectOption('schedule');
    await page
      .getByLabel(AUDIT_COPY.resourceIdLabel, { exact: true })
      .fill(resource.slice('schedule:'.length));
    await form(page).getByRole('button', { name: AUDIT_COPY.searchAction, exact: true }).click();
    await expect(page).toHaveURL(/resource=schedule/);
    await expect(records(page).first()).toBeVisible();
    await expect(records(page).filter({ hasNotText: resource })).toHaveCount(0);

    // A type nothing in the trail has is typed under Other, and is said so, and is not the empty trail.
    await typeSelect(page).selectOption({ label: AUDIT_COPY.otherType });
    await page.getByLabel(AUDIT_COPY.otherTypeLabel, { exact: true }).fill('no.such.type');
    await form(page).getByRole('button', { name: AUDIT_COPY.searchAction, exact: true }).click();
    await expect(page.getByRole('heading', { name: AUDIT_COPY.noMatches.title })).toBeVisible();
    await expect(page.locator('[data-view="audit"]')).toHaveAttribute('data-state', 'ready');
    await checkA11y(`audit — a search that finds nothing at ${width}px`);

    await form(page).getByRole('button', { name: AUDIT_COPY.clearAction }).click();
    await expect(records(page).first()).toBeVisible();
    await expect(page).toHaveURL(/\/health\/audit$/);
  });
}

test('a search can be opened from its address, and the filters are in the form', async ({
  page,
}) => {
  await page.goto('/health/audit?type=schedule.created');

  await expect(typeSelect(page)).toHaveValue('schedule.created');
  await expect(records(page).first()).toBeVisible();
  await expect(records(page).filter({ hasNotText: 'schedule.created' })).toHaveCount(0);
});

test('a resource in the address fills the kind and the id of the picker', async ({ page }) => {
  await page.goto('/health/audit?resource=schedule%3As-9');

  await expect(resourceKind(page)).toHaveValue('schedule');
  await expect(page.getByLabel(AUDIT_COPY.resourceIdLabel, { exact: true })).toHaveValue('s-9');
});
