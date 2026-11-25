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
    await page.getByLabel(AUDIT_COPY.actionLabel, { exact: true }).click();
    await page.getByRole('option', { name: 'Started', exact: true }).click();
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
    await expect(page).toHaveURL(/\/health\/audit(\?record=[^&]+)?$/);
  });
}

test('a search can be opened from its address, and the filters are in the row', async ({
  page,
}) => {
  await page.goto('/health/audit?actor=interborough&period=30d&action=started');

  await expect(page.getByLabel(AUDIT_COPY.actorLabel, { exact: true })).toContainText(
    'Interborough',
  );
  await expect(page.getByLabel(AUDIT_COPY.periodLabel, { exact: true })).toContainText(
    'Last 30 days',
  );
  await expect(page.getByLabel(AUDIT_COPY.actionLabel, { exact: true })).toContainText('Started');
  await expect(events(page).first()).toBeVisible();
});

test.describe('compact audit controls on touch', () => {
  test.use({ hasTouch: true });
  for (const width of [320, 375]) {
    test(`keeps compact faces with 44px interactive regions at ${String(width)}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/health/audit');
      await expect(events(page).first()).toBeVisible();
      for (const label of [
        'Section',
        AUDIT_COPY.actorLabel,
        AUDIT_COPY.periodLabel,
        AUDIT_COPY.actionLabel,
      ]) {
        const control = page.getByRole('combobox', { name: label, exact: true });
        const geometry = await control.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const hit = getComputedStyle(element, '::before');
          const top = Number.parseFloat(hit.top);
          const bottom = Number.parseFloat(hit.bottom);
          return {
            height: bounds.height,
            target: bounds.height - top - bottom,
            reaches:
              document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top - 5) === element,
          };
        });
        expect(geometry.height).toBeGreaterThanOrEqual(31);
        expect(geometry.height).toBeLessThanOrEqual(33);
        expect(geometry.target).toBeGreaterThanOrEqual(44);
        expect(geometry.reaches).toBe(true);
      }
      await page.getByRole('combobox', { name: AUDIT_COPY.actionLabel, exact: true }).focus();
      await page.keyboard.press('ArrowDown');
      await expect(page.getByRole('listbox')).toBeVisible();
      await page.getByRole('option', { name: 'Started', exact: true }).click();
      await expect(page).toHaveURL(/action=started/);
    });
  }
});

test('the audit content keeps a readable desktop measure', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/health/audit');
  await expect(events(page).first()).toBeVisible();
  await events(page).first().click();
  const audit = page.locator('[data-page="audit"]');
  const table = page.getByRole('table', { name: AUDIT_COPY.caption });
  const detail = page.getByTestId('audit-detail');
  const controls = page.getByRole('search', { name: AUDIT_COPY.searchLabel });
  const exportButton = page.getByRole('button', { name: AUDIT_COPY.exportAction });
  await expect(table).toBeVisible();
  await expect(detail).toBeVisible();
  const [area, tableBox, detailBox, controlsBox, exportBox] = await Promise.all([
    audit.boundingBox(),
    table.boundingBox(),
    detail.boundingBox(),
    controls.boundingBox(),
    exportButton.boundingBox(),
  ]);
  if (
    area === null ||
    tableBox === null ||
    detailBox === null ||
    controlsBox === null ||
    exportBox === null
  )
    throw new Error('Audit content must be visible');
  expect(area.width).toBeLessThanOrEqual(960);
  expect(detailBox.x).toBeGreaterThanOrEqual(tableBox.x + tableBox.width);
  for (const box of [tableBox, detailBox, controlsBox, exportBox]) {
    expect(box.x).toBeGreaterThanOrEqual(area.x);
    expect(box.x + box.width).toBeLessThanOrEqual(area.x + area.width + 1);
  }
});
