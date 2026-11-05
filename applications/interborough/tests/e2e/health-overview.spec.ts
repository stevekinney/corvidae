/**
 * The Health Overview on the sample world (`fixtures/sample-world-seed.ts`, the showcase host;
 * COR-2018, rows 76b to 77f) and the Storage tab at a phone and a tablet width (rows 06o to 06r).
 *
 * The Overview is read at 1280, 768 and 375 pixels: the frame (the heading, the line that names the
 * storage backend, the Live indicator, the four tabs with no Diagnostics among them), the four
 * counts, Needs attention with the sample world's three problems, Recent activity, the metric
 * cards, and Advanced collapsed at the foot, and then expanded the way an "Open Diagnostics" link
 * opens it. A fresh installation has no storage rule, so its list has no storage row (row 76i's
 * captioned state), which the first-run host draws.
 *
 * The times the sample world's hosts wrote follow the zone and the clock of the capture, so the
 * checks here read their shape ("10:45 AM"), and the design review reads the values.
 */
import type { Page } from '@playwright/test';

import { SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_FIRST_RUN_URL, E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

const SOURCE = 'health-overview.spec.ts';
const WIDTHS = [1280, 768, 375] as const;
// The clock for a time today, and the day for one that is not: the browser's clock is the real one unless a capture fixes it.
const WHEN = /^(\d{1,2}:\d{2} (AM|PM)|[A-Z][a-z]{2} \d{1,2})$/;

/** The counts' cards, in order. */
const countCards = (page: Page) =>
  page.getByRole('group', { name: 'Health counts' }).locator('.cinder-statistic');

/** Waits for the three reads the Overview's lists come from. */
async function settled(page: Page): Promise<void> {
  const main = page.locator('main');
  await expect(main.getByTestId('needs-attention').locator('li').first()).toBeVisible();
  await expect(main.locator('[data-activity]').first()).toBeVisible();
  await expect(main.getByRole('link', { name: /^Open audit log \(\d/ })).toBeVisible();
}

test.describe('the sample world', () => {
  test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

  for (const width of WIDTHS) {
    test(`the Overview is the frame, the counts, Needs attention, Recent activity, three cards and Advanced, at ${width} pixels`, async ({
      page,
      checkA11y,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/health');
      await settled(page);
      const main = page.locator('main');

      // 76b, 76d: the heading, the storage line, the tabs.
      await expect(main.getByRole('heading', { level: 1, name: 'Health' })).toBeVisible();
      await expect(main.getByTestId('storage-backend')).toContainText('Running on SQLite in');
      await expect(main.getByRole('button', { name: 'Storage details' })).toBeVisible();
      if (width >= 640) {
        await expect(main.getByRole('tab')).toHaveText([
          'Overview',
          'Workers',
          'Storage',
          'Audit log',
        ]);
        await expect(main.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
          'aria-selected',
          'true',
        );
      } else {
        await expect(main.locator('.cinder-tabs__collapse')).toContainText('Section: Overview');
      }
      await expect(
        main.getByRole('tab', { name: /Diagnostics|Metrics|Alerts|Checks/ }),
      ).toHaveCount(0);

      // The four counts, as Home draws them: amber dots only on a non-zero bad count.
      await expect(countCards(page).locator('.cinder-statistic__label')).toHaveText([
        'Running now',
        'Needs you',
        'Failed in 24 hours',
        'Missed schedule runs (7 days)',
      ]);
      await expect(countCards(page).locator('.cinder-statistic__value')).toHaveText([
        '0',
        '2',
        '0',
        '4',
      ]);
      await expect(countCards(page).locator('.cinder-statistic__caption')).toHaveText([
        'Nothing is running',
        'An approval and a question',
        'No failed runs',
        'Daily summary',
      ]);
      await expect(page.locator('.cinder-statistic__attention')).toHaveCount(2);

      // 76f, 76h, 76i, 76j, 76g: Needs attention is a card with the three problems, a count of 3 in neutral,
      // and no banner above it.
      const attention = main.getByTestId('needs-attention');
      await expect(attention.locator('h2')).toHaveText('Needs attention');
      await expect(attention.locator('.cinder-badge')).toHaveText('3');
      const rows = attention.locator('li');
      await expect(rows).toHaveCount(3);
      await expect(rows.nth(0)).toContainText('No model provider connected');
      await expect(rows.nth(0)).toContainText('The Anthropic key was removed at');
      // A phone folds a row's buttons into one menu; the larger widths draw each button.
      const action = (row: number, name: string) =>
        width >= 640
          ? rows.nth(row).getByRole('link', { name })
          : rows.nth(row).getByRole('button', { name: 'More actions' });
      await expect(action(0, 'Connect a provider')).toBeVisible();
      await expect(rows.nth(1)).toContainText('Storage is over its warning level · 1.6 GB');
      await expect(rows.nth(1)).toContainText('Alert firing since');
      await expect(rows.nth(1)).not.toContainText(/capacity|threshold|limit/i);
      await expect(action(1, 'View storage')).toBeVisible();
      if (width >= 640) await expect(action(1, 'Change retention')).toBeVisible();
      await expect(rows.nth(2)).toContainText('Daily summary missed 4 runs since Oct 30');
      await expect(action(2, 'View schedule')).toBeVisible();
      await expect(main.getByRole('region', { name: /reach the Interborough server/ })).toHaveCount(
        0,
      );

      // 76l, 76m: Recent activity, newest first, the time at the right.
      await expect(main.getByRole('heading', { level: 2, name: /^Recent activity/ })).toContainText(
        'Central time',
      );
      const lines = main.locator('[data-activity] .ib-recent-activity__text');
      // Nine lines at most. The sample world holds older runs the canvas does not draw (the Oct 30
      // order 4468 run and the chat the server stopped on Oct 29), which follow these.
      await expect(lines).toHaveCount(9);
      for (const [index, text] of [
        'You removed the Anthropic key',
        'Run started · Refund order 4471 · waiting on you',
        'Run finished · Refund order 4471',
        'Storage alert firing · over its warning level',
        /^Missed runs noticed · Daily summary · was due /,
        'Server started',
        'Run finished · Say hello',
      ].entries()) {
        await expect(lines.nth(index)).toHaveText(text);
      }
      await expect(main.locator('[data-activity] .ib-recent-activity__time').first()).toHaveText(
        WHEN,
      );

      // 76n: three cards.
      await expect(main.getByTestId('metric-cards').locator('h2')).toHaveText([
        'Storage use',
        'Runs started',
        'Time to finish',
      ]);

      // 76o: Advanced is collapsed at the foot, and holds no Diagnostics tab.
      const advanced = main.getByTestId('advanced-diagnostics');
      await expect(advanced).toContainText('Advanced');
      await expect(advanced).toContainText('Metrics, alerts and checks');
      await expect(advanced.locator('button[aria-expanded]')).toHaveAttribute(
        'aria-expanded',
        'false',
      );
      await expect(advanced.getByText('Open metrics ›')).toBeHidden();

      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await captureForDesignReview(page, { route: '/health', state: 'overview', source: SOURCE });
      await checkA11y(`health overview at ${width}px`);
    });
  }

  test('Advanced opened by an Open Diagnostics link shows Metrics, Alerts and Checks, each with a link', async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/health?advanced=open');
    await settled(page);
    const advanced = page.getByTestId('advanced-diagnostics');

    await expect(advanced.locator('button[aria-expanded]')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(advanced.locator('[data-section]')).toHaveCount(3);
    await expect(advanced.locator('[data-section="metrics"]')).toContainText(
      'Storage use, runs started, time to finish; each opens its chart.',
    );
    await expect(advanced.getByText('Open metrics ›')).toBeVisible();
    await expect(advanced.locator('[data-section="alerts"]')).toContainText(
      /storage\.size · firing since \d{1,2}:\d{2} (AM|PM) · 1 rule/,
    );
    await expect(advanced.getByText('Open alerts ›')).toBeVisible();
    // Checks says the same three problems Needs attention does.
    await expect(advanced.locator('[data-section="checks"]')).toContainText(
      '3 need attention · Storage, Schedules, Providers',
    );
    await expect(advanced.getByText('Open checks ›')).toBeVisible();
    await captureForDesignReview(page, {
      route: '/health',
      state: 'advanced-expanded',
      source: SOURCE,
    });
    await checkA11y('health, Advanced expanded');

    // A link opens its panel under the row, and the address says which.
    await advanced.getByText('Open alerts ›').click();
    await expect(page).toHaveURL(/\/health\?advanced=alerts$/);
    await expect(advanced.getByRole('listitem', { name: 'Alerts detail' })).toBeVisible();
  });

  test.describe('on a touch phone', () => {
    test.use({ viewport: { width: 375, height: 900 }, hasTouch: true, isMobile: true });

    test('the Storage tab collapses its tabs to a select, warns without inventing a capacity, and scrolls its table inside its own box', async ({
      page,
      checkA11y,
    }) => {
      await page.goto('/health/storage');
      const main = page.locator('main');
      await expect(main.getByTestId('storage-warning')).toBeVisible();

      await expect(main.getByRole('heading', { level: 1, name: 'Health' })).toBeVisible();
      // 06o: the sections are one select, the warning names no capacity, and the controls are 44px.
      await expect(main.locator('.cinder-tabs__collapse')).toContainText('Section: Storage');
      await expect(main.getByRole('tab')).toHaveCount(0);
      await expect(main.getByTestId('storage-warning')).toContainText(
        'Storage is over its warning level · 1.6 GB.',
      );
      await expect(main.getByTestId('storage-warning')).toContainText('Change retention');
      await expect(main.getByTestId('storage-warning')).not.toContainText(/capacity|threshold/i);
      // The groups select and the key search are each a 44px control.
      for (const control of await main.locator('.ib-storage__filters > *').all()) {
        const box = await control.boundingBox();
        expect(box?.height).toBeGreaterThanOrEqual(44);
      }

      // 06p: the columns, the absolute times, and the table in its own box with no sideways page scroll.
      await expect(main.locator('.ib-storage__table th')).toHaveText([
        'Key',
        'Group',
        'Size',
        'Updated (Central time)',
      ]);
      await expect(main.locator('.ib-storage__updated-column').nth(1)).toHaveText(
        /^(Today|Yesterday|[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2}), \d{1,2}:\d{2} (AM|PM)$/,
      );
      const scroller = main.locator('.cinder-table-scroll');
      await expect(scroller).toBeVisible();
      const frame = await scroller.evaluate((element) => ({
        overflowing: element.scrollWidth > element.clientWidth,
        border: getComputedStyle(element).borderTopWidth,
      }));
      expect(frame.overflowing).toBe(true);
      expect(frame.border).not.toBe('0px');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await captureForDesignReview(page, {
        route: '/health/storage',
        state: 'phone',
        source: SOURCE,
      });
      await checkA11y('health storage at 375px');
    });
  });

  test('the Storage tab at a tablet width brings the tab bar back, drops the key detail below the table, and offers a managed key only Copy key and Copy value', async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width: 768, height: 900 });
    await page.goto('/health/storage');
    const main = page.locator('main');

    // 06q: the tab bar, without a Diagnostics tab.
    await expect(main.getByRole('tab')).toHaveText(['Overview', 'Workers', 'Storage', 'Audit log']);
    await expect(main.getByRole('tab', { name: 'Storage' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(main.getByRole('tab', { name: 'Diagnostics' })).toHaveCount(0);

    // 06r: a key the application manages offers only Copy key and Copy value.
    const managed = main.locator('.ib-storage__key', { hasText: 'agent-session:' }).first();
    await managed.click();
    const pane = main.getByTestId('storage-key');
    await expect(pane.getByRole('button', { name: 'Copy key', exact: true })).toBeVisible();
    await expect(pane.getByRole('button', { name: 'Copy value', exact: true })).toBeVisible();
    await expect(pane.getByRole('button', { name: 'Edit' })).toHaveCount(0);
    await expect(pane.getByRole('button', { name: 'Delete' })).toHaveCount(0);

    // 06q: the pane sits under the table at this width, and the page never scrolls sideways.
    const table = await main.locator('.ib-storage__keys').boundingBox();
    const detail = await pane.boundingBox();
    expect((detail?.y ?? 0) >= (table?.y ?? 0) + (table?.height ?? 0) - 1).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await captureForDesignReview(page, {
      route: '/health/storage',
      state: 'tablet-key',
      source: SOURCE,
    });
    await checkA11y('health storage at 768px');
  });
});

test.describe('a fresh installation', () => {
  test.use({ baseURL: E2E_FIRST_RUN_URL, timezoneId: SAMPLE_TIME_ZONE });

  test('has no storage rule, so Needs attention never lists the storage row', async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/health');
    const main = page.locator('main');
    await expect(main.getByTestId('needs-attention')).toBeVisible();
    await expect(main.getByTestId('needs-attention')).toContainText(
      /No model provider connected|Nothing needs attention/,
    );
    await expect(main.getByTestId('needs-attention')).not.toContainText(
      'Storage is over its warning level',
    );
    await captureForDesignReview(page, {
      route: '/health',
      state: 'fresh-install',
      source: SOURCE,
    });
    await checkA11y('health on a fresh installation');
  });
});
