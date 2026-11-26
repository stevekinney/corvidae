/**
 * The Health Overview on the sample world (`fixtures/sample-world-seed.ts`, the showcase host;
 * COR-2018, rows 76b to 77f) and the Storage tab at a phone and a tablet width (rows 06o to 06r).
 *
 * The Overview is read at 1280, 768 and 375 pixels: the frame (the heading, the line that names the
 * storage backend, the Live indicator, the tabs with no Diagnostics among them), the four
 * counts, Needs attention with the sample world's three problems, Recent activity, the metric
 * cards, and Advanced collapsed at the foot, and then expanded the way an "Open Diagnostics" link
 * opens it. A fresh installation has no storage rule, so its list has no storage row (row 76i's
 * captioned state), which the first-run host draws.
 *
 * The times the sample world's hosts wrote follow the zone and the clock of the capture, so the
 * checks here read their shape ("10:45 AM"), and the design review reads the values.
 */
import type { Page } from '@playwright/test';

import { SAMPLE_NOW, SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import { answerRecentActivityAsDesigned } from './board-activity-world.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_BASE_URL, E2E_FIRST_RUN_URL, E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';
import { touchHeight } from './hit-area.ts';
import { readBoxes } from './read-boxes.ts';
import { expectTabOpen } from './workflow-support.ts';

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
  await expect(
    main.getByRole('link', { name: /^All [\d,]+ events? in the audit log/ }),
  ).toBeVisible();
}

test.describe('the sample world', () => {
  test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

  for (const width of [320, 375]) {
    test(`COR-2736 phone attention action fits at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 640 });
      await page.goto('/health');
      await settled(page);
      const attention = page.getByTestId('needs-attention');
      const heading = attention.getByRole('heading', { name: 'Needs attention' });
      const action = attention.getByRole('link', { name: 'Connect a provider' });
      await expect(heading).toBeInViewport();
      await expect(action).toBeInViewport();
      const actionBox = await action.boundingBox();
      expect(actionBox!.y + actionBox!.height).toBeLessThanOrEqual(640);
      await action.focus();
      await expect(action).toBeFocused();
      await expect(page.getByTestId('health-counts')).toHaveAttribute(
        'data-cinder-variant',
        'plain',
      );
    });
  }

  test('COR-2736 captures storage details and expanded Advanced', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/health');
    await settled(page);
    const details = page.getByRole('button', { name: 'Storage details' });
    await details.focus();
    await page.keyboard.press('Enter');
    await expect(details).toHaveAttribute('aria-expanded', 'true');
    await captureForDesignReview(page, {
      route: '/health',
      state: 'storage details expanded',
      source: SOURCE,
    });
    await page.keyboard.press('Escape');
    await expect(details).toBeFocused();
    const advanced = page.getByTestId('advanced-diagnostics');
    const disclosure = advanced.locator('button[aria-expanded]');
    await disclosure.focus();
    await page.keyboard.press('Enter');
    await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    await expect(advanced.locator('[data-section="checks"]')).toContainText('3 need attention');
    await expect(page.getByTestId('needs-attention').locator('li')).toHaveCount(3);
    await captureForDesignReview(page, {
      route: '/health',
      state: 'advanced expanded',
      source: SOURCE,
    });
    await page.getByTestId('needs-attention').getByRole('link', { name: 'View storage' }).click();
    await expect(page).toHaveURL(/\/health\/storage/);
    await captureForDesignReview(page, {
      route: '/health/storage',
      state: 'storage alert destination',
      source: SOURCE,
    });
  });

  test('COR-2736 captures phone Health section selector', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 900 });
    await page.goto('/health');
    await settled(page);
    const section = page.getByRole('combobox', { name: 'Section' });
    await section.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('option', { name: 'Overview' })).toBeVisible();
    await captureForDesignReview(page, {
      route: '/health',
      state: 'section selector open',
      source: SOURCE,
    });
    await page.keyboard.press('Escape');
    await expect(section).toBeFocused();
  });

  test('desktop content width contains overview actions and activity times without constraining the frame', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1920, height: 900 });
    await page.goto('/health');
    await settled(page);
    const overview = page.locator('.ib-health-overview');
    const bounds = await overview.boundingBox();
    const frame = await page.locator('.ib-health-frame').boundingBox();
    expect(bounds).not.toBeNull();
    expect(frame).not.toBeNull();
    const maximum = await overview.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).maxInlineSize),
    );
    expect(maximum).toBe(1152);
    expect(bounds!.width).toBeLessThanOrEqual(maximum);
    expect(frame!.width).toBeGreaterThan(bounds!.width);
    for (const item of [
      page.getByTestId('needs-attention').getByRole('link', { name: 'Connect a provider' }),
      page.locator('[data-activity] .ib-recent-activity__time').first(),
    ]) {
      const box = await item.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x + box!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width + 1);
    }
    await page.goto('/health/storage');
    await expect(page.locator('.ib-health-frame')).toHaveAttribute('data-tab', 'storage');
    expect((await page.locator('.ib-health-frame').boundingBox())!.width).toBeGreaterThan(maximum);
  });

  for (const width of WIDTHS) {
    test(`the Overview is the frame, the counts, Needs attention, Recent activity, three cards and Advanced, at ${width} pixels`, async ({
      page,
      checkA11y,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      // Recent activity lists the runs and events the board draws (`board-activity-world.ts`); the
      // rest of the sample world's trail follows them in the Audit log's own specification.
      await answerRecentActivityAsDesigned(page);
      // Yesterday and Oct 29 are told against the sample world's "now", whatever day it is.
      await page.clock.setFixedTime(SAMPLE_NOW);
      await page.goto('/health');
      await settled(page);
      const main = page.locator('main');

      // 76b, 76d: the heading, the storage line, the tabs.
      await expect(main.getByRole('heading', { level: 1, name: 'Health' })).toBeVisible();
      // The storage in plain words, no path, and the button beside the words, never over them
      // (owner, 2026-11-19).
      await expect(
        main.getByTestId('storage-backend').locator('.ib-storage-backend__line'),
      ).toHaveText('Running on SQLite');
      await expect(main.getByRole('button', { name: 'Storage details' })).toBeVisible();
      const { words, details } = await readBoxes(page, {
        words: main.locator('.ib-storage-backend__line'),
        details: main.getByRole('button', { name: 'Storage details' }),
      });
      expect(
        details.x >= words.x + words.width - 1 || details.y >= words.y + words.height - 1,
        'Storage details overlaps the storage line',
      ).toBe(true);
      await expectTabOpen(main, 'Overview', 'Section');
      await expect(
        main.getByRole('tab', { name: /Diagnostics|Metrics|Alerts|Checks/ }),
      ).toHaveCount(0);

      // The counts that are not zero, as Home draws them (owner, 2026-11-19: no tile reads zero),
      // with amber dots on the bad ones and no label in parentheses.
      await expect(countCards(page).locator('.cinder-statistic__label')).toHaveText([
        'Needs you',
        'Missed runs in 7 days',
      ]);
      await expect(countCards(page).locator('.cinder-statistic__value')).toHaveText(['2', '4']);
      await expect(countCards(page).locator('.cinder-statistic__caption')).toHaveText([
        'An approval and a question',
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
      // A single action stays a link. Multiple actions collapse whenever the row's measured space
      // requires it, which can happen at a tablet viewport as well as on a phone.
      const expectActions = async (row: number, names: string[]) => {
        const item = rows.nth(row);
        const more = item.getByRole('button', { name: 'More actions' });
        if (await more.isVisible()) {
          await more.click();
          await expect(page.getByRole('menu').getByRole('menuitem')).toHaveText(names);
          await page.keyboard.press('Escape');
          return;
        }
        for (const name of names) await expect(item.getByRole('link', { name })).toBeVisible();
      };
      await expect(rows.nth(0).getByRole('link', { name: 'Connect a provider' })).toBeVisible();
      // Line two sits directly under the title, not a row below the buttons (76h, 76i).
      for (let index = 0; index < 3; index += 1) {
        const title = await rows
          .nth(index)
          .locator('.cinder-stacked-list-item__title')
          .boundingBox();
        const lineTwo = await rows
          .nth(index)
          .locator('.cinder-stacked-list-item__line-two')
          .boundingBox();
        const gap = (lineTwo?.y ?? 0) - ((title?.y ?? 0) + (title?.height ?? 0));
        expect(gap, `line two of row ${String(index)} is tight under its title`).toBeLessThan(10);
        expect(gap).toBeGreaterThanOrEqual(0);
      }
      await expect(rows.nth(1)).toContainText('Storage is over its warning level, 1.6 GB');
      await expect(rows.nth(1)).toContainText('Alert firing since');
      await expect(rows.nth(1)).not.toContainText(/capacity|threshold|limit/i);
      await expectActions(1, ['View storage', 'Change retention']);
      await expect(rows.nth(2)).toContainText('Daily summary missed 4 runs since Oct 30');
      await expect(rows.nth(2).getByRole('link', { name: 'View schedule' })).toBeVisible();
      await expect(main.getByRole('region', { name: /reach the Interborough server/ })).toHaveCount(
        0,
      );
      // 77m: the showcase host has plugins that only wait for a key (OpenAI, Gemini, TypeSafe),
      // and none of them adds a row: the provider row already covers a provider without a key.
      await expect(attention).not.toContainText(/OpenAI|Gemini|TypeSafe|didn’t load/i);
      // 76k: most recent first (provider 10:45 AM, storage 9:05 AM, then Daily summary), and the
      // sidebar's Health dot is amber while the list is not empty. System problems are never
      // counted as Needs you, so Reviews keeps its 2. The sidebar is a drawer on a phone.
      if (width >= 1024) {
        const health = page
          .getByRole('navigation')
          .getByRole('link', { name: 'Health, 3 need attention' });
        await expect(health.locator('.cinder-status-dot')).toHaveAttribute(
          'data-cinder-status',
          'warning',
        );
        await expect(
          page.getByRole('navigation').getByRole('link', { name: 'Reviews, 2 need you' }),
        ).toBeVisible();
      }

      // 76l, 76m: Recent activity, newest first, the time at the right.
      // The zone is said as every page says it, the viewer's own (owner, 2026-11-19: it said a fixed
      // Central while Home said the viewer's Mountain), with no parentheses in the heading.
      await expect(main.getByRole('heading', { level: 2, name: /^Recent activity/ })).toHaveText(
        'Recent activity',
      );
      await expect(main.getByTestId('recent-activity-zone')).toContainText(
        await page.evaluate(
          () =>
            `Times show in ${new Intl.DateTimeFormat('en-US', { timeZoneName: 'longGeneric' })
              .formatToParts(Date.now())
              .find((part) => part.type === 'timeZoneName')
              ?.value.replace(/ Time$/, ' time')}`,
        ),
      );
      const lines = main.locator('[data-activity] .ib-recent-activity__text');
      // Nine lines, the board's: the sample world's other chats (the Oct 30 order 4468 run, the
      // chat the server stopped on Oct 29) are not drawn in this frame.
      await expect(lines).toHaveCount(9);
      for (const [index, text] of [
        'You removed the Anthropic key',
        'Run started, Refund order 4471, waiting on you',
        'Run finished, Refund order 4472',
        'Storage alert firing, over its warning level',
        /^Missed runs noticed, Daily summary, was due /,
        'Server started',
        'Run finished, Say hello',
        'You deleted a chat, “Scratch test”',
        'Schedule ran, Daily summary',
      ].entries()) {
        await expect(lines.nth(index)).toHaveText(text);
      }
      await expect(main.locator('[data-activity] .ib-recent-activity__time').first()).toHaveText(
        WHEN,
      );
      // The last three lines are older than today: yesterday's, and the Oct 29 run's day.
      const times = main.locator('[data-activity] .ib-recent-activity__time');
      await expect(times.nth(6)).toHaveText('Yesterday, 4:12 PM');
      await expect(times.nth(7)).toHaveText('Yesterday, 4:12 PM');
      await expect(times.nth(8)).toHaveText('Oct 29');

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

  for (const width of [1280, 375] as const) {
    test.describe(`engine run link at ${String(width)}px`, () => {
      test.use({ hasTouch: width === 375, isMobile: width === 375 });
      test(`engine runs in Health at ${width} pixels`, async ({ page, checkA11y }) => {
        await page.setViewportSize({ width, height: 900 });
        // The showcase host owns Health's board data but has no engine run rows. The seeded engine
        // host carries the real order-processing run this screen must make usable.
        await page.goto(`${E2E_BASE_URL}/workflows/order-processing?tab=runs`);
        const allRuns = page.getByRole('link', { name: 'All runs', exact: true });
        await expect(allRuns).toHaveAttribute('href', '/health/runs?type=order-processing');
        await captureForDesignReview(page, {
          route: '/workflows/:workflow',
          tab: 'runs',
          state: 'All runs links to engine runs in Health',
          source: SOURCE,
        });
        await allRuns.click();
        await expect(page).toHaveURL(/\/health\/runs\?type=order-processing$/);
        const main = page.locator('main');
        const table = main.locator('table.weft-workflows-table');
        await expect(table.locator('tbody tr').first()).toBeVisible();

        await expect(main.getByRole('heading', { level: 1, name: 'Health' })).toBeVisible();
        await expect(main.getByRole('heading', { level: 2, name: 'Workflow runs' })).toBeVisible();
        if (width === 375) {
          await expect(main.getByRole('combobox', { name: 'Section' })).toHaveText(
            /Section:\s*Runs/,
          );
        } else {
          await expectTabOpen(main, 'Runs', 'Section');
        }
        await expect(main.getByRole('button', { name: 'Live' })).toBeVisible();
        await expect(main.getByRole('status', { name: /Connection/ })).toHaveCount(1);
        const runLink = table
          .locator('tbody tr')
          .first()
          .locator('a.weft-workflows-table__id-link');
        await expect(runLink).toBeVisible();

        const scroller = main.locator('.cinder-table-scroll');
        expect(
          await scroller.evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await captureForDesignReview(page, {
          route: '/health/runs',
          state: 'engine runs in Health',
          source: SOURCE,
        });
        await checkA11y(`health engine runs at ${width}px`);
        if (width === 375) {
          await runLink.scrollIntoViewIfNeeded();
          const hit = await runLink.evaluate((link) => {
            const box = link.getBoundingClientRect();
            const x = box.x + box.width / 2;
            const y = box.y + box.height / 2;
            const above = y - 21.5;
            const below = y + 21.5;
            return {
              x,
              above,
              reachesEdges: [above, below].map((target) =>
                link.contains(document.elementFromPoint(x, target)),
              ),
            };
          });
          expect(hit.reachesEdges).toEqual([true, true]);
          await page.touchscreen.tap(hit.x, hit.above);
          await expect(page).toHaveURL(/\/workflows\/order-processing\/runs\/[^/?]+$/);
        }
      });
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
      /storage\.size, firing since \d{1,2}:\d{2} (AM|PM), 1 rule/,
    );
    await expect(advanced.getByText('Open alerts ›')).toBeVisible();
    // Checks says the same three problems Needs attention does.
    await expect(advanced.locator('[data-section="checks"]')).toContainText(
      '3 need attention, Storage, Schedules, Providers',
    );
    await expect(advanced.locator('[data-section="checks"]')).not.toContainText('Plugins');
    await expect(advanced.getByText('Open system checks ›')).toBeVisible();
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

    test('the Storage tab stays selected after responsive tab measurement, warns without inventing a capacity, and scrolls its table inside its own box', async ({
      page,
      checkA11y,
    }) => {
      await page.goto('/health/storage');
      const main = page.locator('main');
      await expect(main.getByTestId('storage-warning')).toBeVisible();

      await expect(main.getByRole('heading', { level: 1, name: 'Health' })).toBeVisible();
      // 06o: the responsive section control keeps Storage selected, whether the tab bar fits or
      // Cinder collapses it after measuring its container.
      await expectTabOpen(main, 'Storage', 'Section');
      await expect(main.getByTestId('storage-warning')).toContainText(
        'Storage is over its warning level, 1.6 GB.',
      );
      await expect(main.getByTestId('storage-warning')).toContainText('Change retention');
      await expect(main.getByTestId('storage-warning')).not.toContainText(/capacity|threshold/i);
      // The groups select and the key search are each a 44px control.
      const controls = await main
        .getByRole('search', { name: 'Find a key' })
        .locator(':scope > *')
        .all();
      // The groups select, the Starts with / Range switch and the search field.
      expect(controls).toHaveLength(3);
      // 44px to a finger: a compact control (the switch, COR-2489 AC5) paints at a Button's height
      // and reaches 44px through its hit area.
      for (const control of controls) {
        const parts = [
          control,
          ...(await control
            .locator('button, input, select, .cinder-segmented-control-option')
            .all()),
        ];
        const heights = await Promise.all(parts.map(async (part) => touchHeight(part)));
        expect(Math.max(...heights)).toBeGreaterThanOrEqual(44);
      }

      // 06p: the columns, the absolute times, and the table in its own box with no sideways page scroll.
      await expect(main.locator('.cinder-data-table thead th')).toHaveText([
        'Key',
        'Group',
        'Size',
        'Updated (Central time)',
      ]);
      await expect(main.locator('.cinder-data-table tbody tr td:nth-child(4)').first()).toHaveText(
        /^(Today|Yesterday|[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2}), \d{1,2}:\d{2} (AM|PM)$/,
      );
      // The table's own box is the bordered box of Cinder's list and detail, which the table fills edge to edge.
      const scroller = main.locator('.cinder-table-scroll');
      await expect(scroller).toBeVisible();
      const overflowing = await scroller.evaluate(
        (element) => element.scrollWidth > element.clientWidth,
      );
      expect(overflowing).toBe(true);
      const box = await main
        .locator('.cinder-list-detail')
        .evaluate((element) => getComputedStyle(element).borderTopWidth);
      expect(box).not.toBe('0px');
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
    await expect(main.getByRole('tab')).toHaveText([
      'Overview',
      'Runs',
      'Workers',
      'Storage',
      'Audit log',
    ]);
    await expect(main.getByRole('tab', { name: 'Storage' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(main.getByRole('tab', { name: 'Diagnostics' })).toHaveCount(0);

    // 06r: a key the application manages offers only Copy key and Copy value.
    const managed = main.locator('tr[data-cinder-row-id="agent-session:summary-index"]');
    await managed.click();
    const pane = main.getByTestId('storage-key');
    await expect(pane.getByRole('button', { name: 'Copy key', exact: true })).toBeVisible();
    await expect(pane.getByRole('button', { name: 'Copy value', exact: true })).toBeVisible();
    await expect(pane.getByRole('button', { name: 'Edit' })).toHaveCount(0);
    await expect(pane.getByRole('button', { name: 'Delete' })).toHaveCount(0);

    // 06q: the pane sits under the table at this width, and the page never scrolls sideways.
    await expect(main.locator('.cinder-list-detail')).toHaveAttribute(
      'data-cinder-layout',
      'below',
    );
    const table = await main.locator('.cinder-list-detail__list').boundingBox();
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
    // The table narrowed to the key, so the pane under it is in the capture (06q, 06r): the full
    // table is thousands of pixels tall and the capture stops short of its foot.
    await main.getByPlaceholder('Keys starting with').fill('agent-session:summary');
    await expect(main.locator('tbody tr[data-cinder-row-id]')).toHaveCount(1);
    await main.locator('tbody tr[data-cinder-row-id]').click();
    await expect(pane.getByRole('button', { name: 'Copy key', exact: true })).toBeInViewport();
    await expect(pane.getByRole('button', { name: 'Copy value', exact: true })).toBeInViewport();
    await captureForDesignReview(page, {
      route: '/health/storage',
      state: 'tablet-key pane',
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
    const attention = main
      .getByTestId('needs-attention')
      .or(main.getByTestId('needs-attention-clear'));
    await expect(attention).toBeVisible();
    await expect(attention).toContainText(/No model provider connected|Nothing needs attention/);
    await expect(attention).not.toContainText('Storage is over its warning level');
    await captureForDesignReview(page, {
      route: '/health',
      state: 'fresh-install',
      source: SOURCE,
    });
    await checkA11y('health on a fresh installation');
  });
});
