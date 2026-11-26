/**
 * `/health/audit` (COR-1493, COR-1658, COR-2018): the audit log on the main host, at the two widths
 * the application is built for, with axe on each. The seeded schedule's creation is in the log, and
 * so is anything these specs do. The filters are the ones the page offers (who, period, action and
 * a search), held in the address; the sample world's own log is read in `health-audit.spec.ts`.
 */
import type { Page } from '@playwright/test';

import { AUDIT_COPY } from '../../src/app/copy/audit.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { expect, test } from './fixtures.ts';
import { readBoxes } from './read-boxes.ts';

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

test.describe('/health/audit compact controls on touch', () => {
  test.use({ hasTouch: true });
  for (const width of [320, 375]) {
    test(`keeps compact faces with 44px interactive regions at ${String(width)}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: width === 320 ? 640 : 667 });
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
      const search = page.getByRole('searchbox', { name: AUDIT_COPY.textLabel });
      const searchFace = page.locator('.ib-audit__search');
      const searchGeometry = await searchFace.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const hit = getComputedStyle(element, '::before');
        return {
          x: bounds.left + bounds.width / 2,
          y: bounds.top - 5,
          height: bounds.height,
          target: bounds.height - Number.parseFloat(hit.top) - Number.parseFloat(hit.bottom),
          reaches:
            document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top - 5) === element,
        };
      });
      expect(searchGeometry.height).toBeGreaterThanOrEqual(31);
      expect(searchGeometry.height).toBeLessThanOrEqual(33);
      expect(searchGeometry.target).toBeGreaterThanOrEqual(44);
      expect(searchGeometry.reaches).toBe(true);
      const { firstEvent, navigation } = await readBoxes(page, {
        firstEvent: events(page).first(),
        navigation: page.locator('nav.weft-shell-tab-bar'),
      });
      expect(firstEvent.y).toBeGreaterThanOrEqual(0);
      expect(firstEvent.y + firstEvent.height).toBeLessThanOrEqual(navigation.y);
      expect(
        await events(page)
          .first()
          .evaluate((row) => {
            const scrollBox = row.closest('.cinder-table-scroll');
            if (scrollBox === null) throw new Error('Audit event has no table scroll viewport');
            const box = row.getBoundingClientRect();
            const clip = scrollBox.getBoundingClientRect();
            // The cells can be wider than the viewport. Hit the middle of the visible row.
            const left = Math.max(box.left, clip.left, 0);
            const right = Math.min(box.right, clip.right, innerWidth);
            if (right <= left) return false;
            const hit = document.elementFromPoint((left + right) / 2, box.top + box.height / 2);
            return hit !== null && row.contains(hit);
          }),
      ).toBe(true);
      await captureForDesignReview(page, {
        route: '/health/audit',
        state: `compact touch controls at ${String(width)} pixels`,
        source: '27-audit.spec.ts',
        ready: () => expect(events(page).first()).toBeVisible(),
      });
      await page.mouse.click(searchGeometry.x, searchGeometry.y);
      await expect(search).toBeFocused();
      await page.keyboard.type('probe');
      await expect(search).toHaveValue('probe');
      await search.fill('');
      await page.getByRole('combobox', { name: AUDIT_COPY.actionLabel, exact: true }).focus();
      await page.keyboard.press('ArrowDown');
      await expect(
        page.getByRole('combobox', { name: AUDIT_COPY.actionLabel, exact: true }),
      ).toHaveAttribute('aria-expanded', 'true');
      await expect(page.getByRole('option', { name: 'Started', exact: true })).toBeVisible();
      await page.getByRole('option', { name: 'Started', exact: true }).click();
      await expect(page).toHaveURL(/action=started/);
      const action = page.getByRole('combobox', { name: AUDIT_COPY.actionLabel, exact: true });
      await action.focus();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Home');
      await page.keyboard.press('Enter');
      await expect(action).toHaveText('Any action');
      await expect(page).not.toHaveURL(/action=/);
    });
  }
});

test('/health/audit keeps a readable desktop measure', async ({ page }) => {
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
  await expect(audit.locator('.ib-audit__layout')).toHaveAttribute('data-cinder-layout', 'split');
  const tableViewport = audit.locator('.cinder-table-scroll').filter({ has: table });
  await expect(tableViewport).toHaveCSS('overflow-x', 'auto');
  const { area, tableViewportBox, detailBox, controlsBox, exportBox } = await readBoxes(page, {
    area: audit,
    tableViewportBox: tableViewport,
    detailBox: detail,
    controlsBox: controls,
    exportBox: exportButton,
  });
  expect(area.width).toBeLessThanOrEqual(960);
  expect(detailBox.x).toBeGreaterThanOrEqual(tableViewportBox.x + tableViewportBox.width);
  for (const box of [tableViewportBox, detailBox, controlsBox, exportBox]) {
    expect(box.x).toBeGreaterThanOrEqual(area.x);
    expect(box.x + box.width).toBeLessThanOrEqual(area.x + area.width + 1);
  }
  await captureForDesignReview(page, {
    route: '/health/audit',
    state: 'bounded desktop detail',
    source: '27-audit.spec.ts',
    ready: async () => {
      await expect(table).toBeVisible();
      await expect(detail).toBeVisible();
    },
  });
});
