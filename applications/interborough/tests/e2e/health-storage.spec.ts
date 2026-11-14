/**
 * The Health Storage tab on the sample world (`fixtures/sample-world-seed.ts`, the showcase host;
 * COR-2018, rows 80a to 80e, 80g, 80i to 80k, 80p to 80r and 81e; and, in the second part of this
 * file, rows 80l, 80m, 80t, 80u, 80w, 81c and 81d). The page is read at 1280 pixels:
 * the frame (the heading, the storage line, the Live indicator, the four tabs), the warning, the
 * control row, the table with its footer, and the pane of a key the application manages; then the
 * storage popover, Range mode, a range whose end comes before its start, and a key thousands of
 * characters long.
 *
 * The sample world's storage is what the engine and the Bureau actually wrote, so its keys are the
 * real ones (`agent-session:summary-index`, `audit:v1:<time>:<id>`, `wf:<run>`), not the names the
 * board uses to show a table; the checks read the shape of each row and the design review reads the
 * values. The times the host wrote follow the clock of the capture, since the host stamps each key
 * with the sample world's clock.
 */
import type { APIRequestContext, Page, Route } from '@playwright/test';

import { SAMPLE_NOW, SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import { formatBytes } from '../../src/lib/format/index.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';
import { answerStorageFrom, BOARD_KEYS, BOARD_RANGE_KEYS } from './storage-board-world.ts';

test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

const SOURCE = 'health-storage.spec.ts';
// The pane's line: the day is a word for today and yesterday, and the date for any other. The
// browser's clock is the sample world's in a capture and the real one otherwise.
const UPDATED_SUMMARY =
  /^Chat sessions, [\d.]+ (B|KB), updated (today, \d{1,2}:\d{2} (AM|PM)|yesterday|[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} (AM|PM))$/;
const WHEN = /^(Today|Yesterday|[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2}), \d{1,2}:\d{2} (AM|PM)$/;

/** The first rows of the table, as the key, the group, the size and the time each one says. */
async function firstRows(page: Page, count: number): Promise<string[][]> {
  return page
    .locator('main .cinder-data-table tbody tr[data-cinder-row-id]')
    .evaluateAll(
      (rows, limit) =>
        rows
          .slice(0, limit)
          .map((row) =>
            [...row.querySelectorAll('th, td')].map((cell) => cell.textContent?.trim() ?? ''),
          ),
      count,
    );
}

/** Opens the Storage tab and waits for its table. */
async function openStorage(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/health/storage');
  await expect(page.locator('main tbody tr[data-cinder-row-id]').first()).toBeVisible();
}

test.describe('Health › Storage on the sample world', () => {
  test('is the Health frame, the warning, one row of controls, the key table with its footer, and the pane of a locked key', async ({
    page,
    checkA11y,
  }) => {
    await openStorage(page);
    const main = page.locator('main');

    // 80a, 80b: Health is active with its dot, the heading is Health, the tab is the leaf.
    await expect(page.getByRole('link', { name: /^Health/ }).first()).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.locator('header').getByText('Storage', { exact: true })).toBeVisible();
    await expect(main.getByRole('heading', { level: 1, name: 'Health' })).toBeVisible();
    await expect(main.getByText('Live', { exact: true })).toBeVisible();
    await expect(main.getByRole('tab')).toHaveText(['Overview', 'Workers', 'Storage', 'Audit log']);
    await expect(main.getByRole('tab', { name: 'Storage' })).toHaveAttribute(
      'aria-selected',
      'true',
    );

    // 80c: the storage line names the backend and does not count keys.
    const backend = main.getByTestId('storage-backend');
    await expect(backend).toContainText('Running on SQLite in');
    await expect(backend.getByRole('button', { name: 'Storage details' })).toBeVisible();
    await expect(backend).not.toContainText(/\d keys/);

    // 80d: the warning, with Change retention, and no capacity or threshold.
    const warning = main.getByTestId('storage-warning');
    await expect(warning).toContainText('Storage is over its warning level, 1.6 GB.');
    await expect(warning.getByRole('link', { name: 'Change retention' })).toBeVisible();
    await expect(warning).not.toContainText(/capacity|threshold/i);

    // 80e: a group select, a two-option switch, and a search field, left to right.
    const filters = main.getByRole('search', { name: 'Find a key' });
    const group = filters.getByLabel('Group', { exact: true });
    await expect(group).toHaveValue('');
    await expect(group.locator('option').first()).toHaveText('All groups');
    const mode = filters.getByRole('radiogroup', { name: 'Search mode' });
    await expect(mode.getByRole('radio')).toHaveText(['Starts with', 'Range']);
    await expect(mode.getByRole('radio', { name: 'Starts with' })).toBeChecked();
    const search = filters.getByPlaceholder('Keys starting with');
    await expect(search).toBeVisible();
    const boxes = await Promise.all(
      [group, mode, search].map(async (control) => control.boundingBox()),
    );
    expect((boxes[0]?.x ?? 0) < (boxes[1]?.x ?? 0)).toBe(true);
    expect((boxes[1]?.x ?? 0) < (boxes[2]?.x ?? 0)).toBe(true);
    // Groups are a select beside the search, not a third pane.
    await expect(group.locator('option', { hasText: 'Chat sessions' })).toHaveCount(1);

    // 80g: the table's columns, and each row's group, size and time.
    await expect(main.locator('thead th')).toHaveText([
      'Key',
      'Group',
      'Size',
      'Updated (Central time)',
    ]);
    const rows = await firstRows(page, 8);
    expect(rows.length).toBe(8);
    for (const [key, groupName, size, updated] of rows) {
      expect(key).toMatch(/^\S+$/);
      expect(groupName).not.toBe('');
      expect(size).toMatch(/^\d[\d.]* (B|KB|MB)$/);
      expect(updated).toMatch(WHEN);
    }
    const summary = main.locator('tr[data-cinder-row-id="agent-session:summary-index"]');
    await expect(summary.locator('td').nth(0)).toHaveText('Chat sessions');

    // 80i: the footer says how many keys there are, and that scrolling loads the rest.
    await expect(main.getByTestId('storage-count')).toHaveText(
      /^Showing 100 of [\d,]+ keys\. Scroll to load more\.$/,
    );
    await expect(main.getByRole('button', { name: 'Load more' })).toHaveCount(0);
    // The table's foot, scrolled into view, is the footer at rest.
    await main.getByTestId('storage-count').scrollIntoViewIfNeeded();
    await captureForDesignReview(page, {
      route: '/health/storage',
      state: 'footer at rest',
      source: SOURCE,
    });

    // 80j, 80k: a managed key's pane, top to bottom.
    await summary.click();
    const pane = main.getByTestId('storage-key');
    await expect(summary).toHaveAttribute('aria-current', 'true');
    await expect(pane.getByTestId('storage-key-summary')).toHaveText(UPDATED_SUMMARY);
    await expect(pane.getByTestId('storage-key-name')).toHaveText('agent-session:summary-index');
    await expect(pane.getByRole('button')).toContainText(['Copy key', 'Copy value']);
    await expect(pane.getByRole('button', { name: 'Edit' })).toHaveCount(0);
    await expect(pane.getByRole('button', { name: 'Delete' })).toHaveCount(0);
    // 80l: a managed key never offers Edit or Delete, nor the menu that holds Delete.
    await expect(pane.getByRole('button', { name: 'More actions' })).toHaveCount(0);
    await expect(pane.getByTestId('storage-key-managed')).toContainText(
      'Locked: Interborough manages keys that start with agent-session: and needs them to recover runs.',
    );
    await expect(pane.getByRole('heading', { name: 'Value' })).toHaveCount(0);
    const value = pane.getByRole('group', { name: 'Value' });
    await expect(value.getByText('Value', { exact: true })).toBeVisible();
    await expect(value.getByRole('radio')).toHaveText(['Fields', 'JSON']);
    await expect(value.getByRole('radio', { name: 'Fields' })).toBeChecked();
    await expect(value.getByText('Format version')).toBeVisible();
    await expect(value).not.toContainText(/\d+ values?/);
    await expect(value.getByRole('button', { name: /^Copy/ })).toHaveCount(0);

    // The pane is a card the value sits inside, so the value draws no second one.
    const framed = await value.evaluate((element) => getComputedStyle(element).borderTopWidth);
    expect(framed).toBe('0px');

    // Named for what it shows, so the showcase's own `ready` capture does not overwrite it (80k).
    await captureForDesignReview(page, {
      route: '/health/storage',
      state: 'key selected',
      source: SOURCE,
    });
    await checkA11y('health storage at 1280px');
  });

  test('shortens a UUID in the table, keeps the whole key in its title and pane, and narrows by what a key starts with', async ({
    page,
  }) => {
    await openStorage(page);
    const main = page.locator('main');

    // A key with a UUID in it reads "415b1fd8…" in the table, whole in its title and pane.
    const search = main.getByPlaceholder('Keys starting with');
    await search.fill('durable-run:');
    const row = main.locator('tbody tr[data-cinder-row-id]').first();
    const key = (await row.getAttribute('data-cinder-row-id')) ?? '';
    const shortened = await row.locator('th').innerText();
    expect(shortened).toMatch(/…/);
    expect(shortened.length).toBeLessThan(key.length);
    await expect(row.locator('th [title]').first()).toHaveAttribute('title', key);
    await row.click();
    await expect(main.getByTestId('storage-key-name')).toHaveText(key);

    // Starts with is a prefix: every row starts with the text, and the footer counts that prefix.
    for (const [rowKey] of await firstRows(page, 5)) {
      expect(rowKey?.startsWith('durable-run:')).toBe(true);
    }
    await expect(main.getByTestId('storage-count')).toHaveText(/^Showing \d+ of \d+ keys\.$/);

    // A chosen group and typed text that part ways match nothing.
    await main.getByLabel('Group', { exact: true }).selectOption({ label: 'Chat sessions' });
    await expect(main.getByRole('heading', { name: 'No keys match' })).toBeVisible();
    await main.getByRole('button', { name: 'Clear filters' }).click();
    await expect(main.getByTestId('storage-count')).toBeVisible();
  });

  test('loads the next page when the end of the table scrolls into view', async ({ page }) => {
    await openStorage(page);
    const main = page.locator('main');
    const footer = main.getByTestId('storage-count');
    await expect(footer).toContainText('Showing 100 of');
    // The table loads more when its end marker, the footer cell's last pixel, scrolls into view;
    // the footer text sits above the cell's padding, so bringing the text in can leave the marker
    // just under the fold when the pane overhangs the page.
    await main
      .locator('.cinder-list-detail__rows .cinder-data-table__end')
      .scrollIntoViewIfNeeded();
    await expect(footer).toContainText(/Showing (200|300) of/);
  });

  test('opens the storage details from the line, with its chevron turned up, and lists five facts', async ({
    page,
    checkA11y,
  }) => {
    await openStorage(page);
    const main = page.locator('main');
    const trigger = main.getByRole('button', { name: 'Storage details' });
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const details = page.getByTestId('storage-details');
    // The popover is named for the button that opened it; the body does not say it again.
    await expect(details.getByRole('heading')).toHaveCount(0);
    // Nothing sticks out past the popover's right edge, and no path is cut off.
    const fit = await details.evaluate((element) => {
      const popover = element.closest('.cinder-popover');
      const own = element.getBoundingClientRect();
      const frame = popover?.getBoundingClientRect();
      return {
        overflow: element.scrollWidth - element.clientWidth,
        right: own.right,
        frame: frame?.right ?? 0,
      };
    });
    expect(fit.overflow).toBeLessThanOrEqual(0);
    expect(fit.right).toBeLessThanOrEqual(Math.ceil(fit.frame));
    await expect(details.locator('dt')).toHaveText([
      'Backend',
      'Location',
      'Size',
      'Keys',
      'Writes',
    ]);
    await expect(details.locator('dd').nth(0)).toHaveText('SQLite');
    await expect(details.locator('dd').nth(2)).toHaveText('1.6 GB');
    await expect(details.locator('dd').nth(3)).toHaveText(/^[\d,]+\s*$/);
    await expect(details.locator('dd').nth(4)).toHaveText('Per key; managed keys are locked');
    await expect(details).toContainText('Storage is set up in Settings › Data and retention.');
    await expect(
      details.getByRole('link', { name: 'Settings › Data and retention' }),
    ).toHaveAttribute('href', '/settings/data-and-retention');
    // It replaces the Capabilities tab, so none of the capability words are drawn.
    await expect(details).not.toContainText(/Persistence|Conditional batch|Atomic batch/);
    await captureForDesignReview(page, {
      route: '/health/storage',
      state: 'popover',
      source: SOURCE,
    });
    await checkA11y('health storage details popover');
    await page.keyboard.press('Escape');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  test('Range reads from one key to another, both included, over every group, and says when the end comes first', async ({
    page,
    request,
    checkA11y,
  }) => {
    await openStorage(page);
    const main = page.locator('main');
    const listed = await request.get('/v1/storage?prefix=audit%3Av1%3A&limit=3');
    const listedText = await listed.text();
    const audit = listedText
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { key: string }).key);
    expect(audit.length).toBe(3);
    const [first, , third] = audit as [string, string, string];

    await main.getByRole('radio', { name: 'Range' }).click();
    // The search field is replaced by two key fields with "to" between them.
    await expect(main.getByPlaceholder('Keys starting with')).toHaveCount(0);
    const filters = main.getByRole('search', { name: 'Find a key' });
    const range = filters.getByRole('group', { name: 'Range' });
    const start = range.getByLabel('Range start');
    const end = range.getByLabel('Range end');
    await expect(range.getByText('to', { exact: true })).toBeVisible();
    await expect(filters.getByLabel('Group', { exact: true })).toHaveValue('');
    expect(await start.evaluate((element) => getComputedStyle(element).fontFamily)).toMatch(
      /mono/i,
    );
    await expect(main.getByRole('button', { name: 'Apply' })).toHaveCount(0);

    // The range applies as it is typed: the last key stands for every key that starts with it.
    await start.fill(first);
    await end.fill(third.slice(0, third.lastIndexOf(':')));
    await expect(main.locator('tbody tr[data-cinder-row-id]')).toHaveCount(3);
    const listedRows = await firstRows(page, 3);
    expect(listedRows.map(([key]) => key)).toEqual(audit);
    for (const [, groupName, , updated] of listedRows) {
      expect(groupName).toBe('Audit log');
      expect(updated).toMatch(WHEN);
    }
    await expect(main.getByTestId('storage-count')).toHaveText('Showing 3 keys.');
    // The frame the board draws has one row of the range chosen and highlighted (row 80q).
    await main.locator('tbody tr[data-cinder-row-id]').nth(1).click();
    await expect(main.locator('tbody tr[aria-current="true"]')).toHaveCount(1);
    await captureForDesignReview(page, {
      route: '/health/storage',
      state: 'range',
      source: SOURCE,
    });
    await checkA11y('health storage range');

    // An end that sorts before the start: the End field is invalid, the note says what is shown.
    await start.fill(third);
    await end.fill(first);
    await expect(end).toHaveAttribute('aria-invalid', 'true');
    await expect(main.getByRole('alert')).toHaveText(
      'The end comes before the start. Swap them, or pick a later end.',
    );
    await expect(main.getByTestId('storage-last-result')).toContainText(
      'Showing the last result: ',
    );
    // The table keeps the last good result: nothing new was read.
    await expect(main.locator('tbody tr[data-cinder-row-id]').first()).toBeVisible();
    // The border follows the field's state through a short transition, so it is waited for.
    const startBorder = await start.evaluate((element) => getComputedStyle(element).borderColor);
    await expect
      .poll(() => end.evaluate((element) => getComputedStyle(element).borderColor))
      .not.toBe(startBorder);
    await captureForDesignReview(page, {
      route: '/health/storage',
      state: 'range-reversed',
      source: SOURCE,
    });
    await checkA11y('health storage reversed range');

    // Swapping them clears it.
    await start.fill(first);
    await end.fill(third);
    await expect(main.getByRole('alert')).toHaveCount(0);
    await expect(end).not.toHaveAttribute('aria-invalid', 'true');
  });

  test.describe('a very long key', () => {
    const LONG_KEY = `agent-session:415b1fd8-77c2-4f0e-9a6d-2b1c0e5f3a11:messages:${'0123456789abcdef'.repeat(124)}:thumbnail`;

    test.beforeEach(async ({ request }) => {
      await request.put(`/v1/storage/${encodeURIComponent(LONG_KEY)}`, {
        data: '{"formatVersion":3,"messages":14}',
      });
    });

    test.afterEach(async ({ request }) => {
      await request.delete(`/v1/storage/${encodeURIComponent(LONG_KEY)}`);
    });

    test('wraps inside the pane without widening it, says how long it is, and copies the whole key', async ({
      page,
      context,
      checkA11y,
    }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await openStorage(page);
      const main = page.locator('main');
      await main.getByPlaceholder('Keys starting with').fill('agent-session:415b1fd8');
      const row = main.locator('tbody tr[data-cinder-row-id]').first();
      await row.click();
      const pane = main.getByTestId('storage-key');
      await expect(pane.getByTestId('storage-key-name')).toHaveText(LONG_KEY);
      await expect(pane).toContainText(`(${LONG_KEY.length.toLocaleString('en-US')} characters)`);
      await expect(pane.getByTestId('storage-key-summary')).toHaveText(UPDATED_SUMMARY);
      await expect(pane.getByRole('button')).toContainText(['Copy key', 'Copy value']);
      await expect(pane.getByText('Format version')).toBeVisible();

      // The key wraps inside the pane, and nothing scrolls sideways: not the pane's own scroller and
      // not the page. (The pane's scrollWidth is not the measure: a SegmentedControl keeps room for
      // its focus ring past its edge and hands it back with a negative margin, COR-2312, which
      // nothing draws in.)
      const widths = await pane.evaluate((element) => {
        const key = element.querySelector('[data-testid="storage-key-name"]');
        let scroller = element.parentElement;
        while (scroller !== null && !/auto|scroll/.test(getComputedStyle(scroller).overflowX)) {
          scroller = scroller.parentElement;
        }
        return {
          paneRight: element.getBoundingClientRect().right,
          keyRight: key?.getBoundingClientRect().right ?? Infinity,
          keyOverflow: key === null ? Infinity : key.scrollWidth - key.clientWidth,
          scrollerOverflow: scroller === null ? 0 : scroller.scrollWidth - scroller.clientWidth,
          page: document.documentElement.scrollWidth,
          viewport: innerWidth,
        };
      });
      expect(widths.keyOverflow).toBeLessThanOrEqual(0);
      expect(widths.keyRight).toBeLessThanOrEqual(Math.ceil(widths.paneRight));
      expect(widths.scrollerOverflow).toBeLessThanOrEqual(0);
      expect(widths.page).toBeLessThanOrEqual(widths.viewport);

      await pane.getByRole('button', { name: 'Copy key' }).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(LONG_KEY);
      await captureForDesignReview(page, {
        route: '/health/storage',
        state: 'long-key',
        source: SOURCE,
      });
      await checkA11y('health storage long key');
    });
  });

  test.describe('on a touch phone', () => {
    test.use({ viewport: { width: 375, height: 900 }, hasTouch: true, isMobile: true });

    test('Range stacks its two fields at 44 pixels and never widens the page, and the details fit the screen', async ({
      page,
      checkA11y,
    }) => {
      await page.goto('/health/storage');
      const main = page.locator('main');
      await expect(main.locator('tbody tr[data-cinder-row-id]').first()).toBeVisible();
      await main.getByRole('radio', { name: 'Range' }).click();
      const range = main.getByRole('group', { name: 'Range' });
      for (const field of [range.getByLabel('Range start'), range.getByLabel('Range end')]) {
        const box = await field.boundingBox();
        expect(box?.height).toBeGreaterThanOrEqual(44);
        expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(375);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await captureForDesignReview(page, {
        route: '/health/storage',
        state: 'range-phone',
        source: SOURCE,
      });
      await checkA11y('health storage range at 375px');

      await main.getByRole('button', { name: 'Storage details' }).click();
      const details = page.getByTestId('storage-details');
      await expect(details).toBeVisible();
      const box = await details.boundingBox();
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(375);
      expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
      await captureForDesignReview(page, {
        route: '/health/storage',
        state: 'popover-phone',
        source: SOURCE,
      });
    });
  });
});

// The second part: writing, and every state the table and the pane are in on the way. A key the
// application does not manage (`app:welcome-banner`, the board's own) is written for the cases that
// change data, and removed after each, so the sample world is left as it was found.
const BANNER = 'app:welcome-banner';
// 96 bytes, which the board's pane header says (row 80w): the text is padded with spaces, which JSON ignores.
const BANNER_VALUE = '{"dismissed":true,"dismissedOn":"2026-11-01T22:12:00Z"}'.padEnd(96, ' ');
const BANNER_SUMMARY =
  /^App data and memory, \d+ B, updated (today, \d{1,2}:\d{2} (AM|PM)|yesterday|[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} (AM|PM))$/;

/** The address of one key's value, which the pane reads when a row is opened. */
const valueAddress = (key: string): string => `/v1/storage/${encodeURIComponent(key)}`;

/** What the host holds under `key`, as text. */
async function storedText(request: APIRequestContext, key: string): Promise<string> {
  const response = await request.get(valueAddress(key));
  return response.text();
}

/**
 * Holds every request `matches` accepts, and `release` lets them all through. The rest are
 * answered as the host does.
 */
async function holdRequests(
  page: Page,
  matches: (url: URL, method: string) => boolean,
): Promise<{ release: () => void }> {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    () => true,
    async (route: Route) => {
      const request = route.request();
      if (!matches(new URL(request.url()), request.method())) {
        await route.fallback();
        return;
      }
      await gate;
      await route.fallback();
    },
  );
  return { release };
}

/** Opens the Storage tab on a clock that can be moved, which the loading states need. */
async function openStorageOnAClock(page: Page, width = 1280): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await page.clock.install();
  await page.goto('/health/storage');
}

test.describe('Health › Storage writes and states', () => {
  test.beforeEach(async ({ request }) => {
    await request.put(valueAddress(BANNER), { data: BANNER_VALUE });
  });

  test.afterEach(async ({ request }) => {
    await request.delete(valueAddress(BANNER));
  });

  /** Opens the banner key's pane. */
  async function openBanner(page: Page) {
    await openStorage(page);
    const main = page.locator('main');
    await main.getByPlaceholder('Keys starting with').fill('app:welcome');
    await main.locator(`tr[data-cinder-row-id="${BANNER}"]`).click();
    return main.getByTestId('storage-key');
  }

  test('a key the app does not manage: Copy key, Copy value and Edit are buttons, Delete is in the ⋯ menu, and Delete asks first', async ({
    page,
    checkA11y,
  }) => {
    const pane = await openBanner(page);
    const main = page.locator('main');

    // 80l: the table is Cinder's list and the pane is its detail, beside it.
    const layout = main.locator('.cinder-list-detail');
    await expect(layout).toHaveAttribute('data-cinder-layout', 'split');
    await expect(layout.locator('.cinder-list-detail__list .cinder-data-table')).toBeVisible();
    const tableBox = await layout.locator('.cinder-list-detail__list').boundingBox();
    const paneBox = await layout.locator('.cinder-list-detail__detail').boundingBox();
    expect((tableBox?.x ?? 0) + (tableBox?.width ?? 0)).toBeLessThanOrEqual(paneBox?.x ?? 0);

    // 80m: the line, the key, then the buttons and the menu at the end of the row.
    await expect(pane.getByTestId('storage-key-summary')).toHaveText(BANNER_SUMMARY);
    await expect(pane.getByTestId('storage-key-name')).toHaveText(BANNER);
    // Rendered text: a Copy button lays out its hidden "Copied" word too, so it keeps one width.
    await expect(pane.locator('.ib-storage-key__actions').first().getByRole('button')).toHaveText(
      ['Copy key', 'Copy value', 'Edit', 'More actions'],
      { useInnerText: true },
    );
    await expect(pane.getByRole('button', { name: 'Delete' })).toHaveCount(0);
    const fields = pane.getByRole('group', { name: 'Value' });
    await expect(fields.getByText('Dismissed', { exact: true })).toBeVisible();
    await expect(fields.getByText('Yes', { exact: true })).toBeVisible();
    await expect(fields.getByText('Dismissed on')).toBeVisible();
    await expect(fields.getByText('Sun Nov 1, 4:12 PM')).toBeVisible();

    await captureForDesignReview(page, {
      route: '/health/storage',
      state: 'unmanaged-key',
      source: SOURCE,
    });
    await checkA11y('health storage, a key the app does not manage');

    // Every destructive write confirms first: the key, its size, and that it cannot be undone.
    await pane.getByRole('button', { name: 'More actions' }).click();
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem')).toHaveText(['Delete']);
    await menu.getByRole('menuitem', { name: 'Delete' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete this key?' });
    await expect(dialog).toContainText(`${BANNER} and its`);
    await expect(dialog).toContainText(
      /\d+ B value are removed from storage\. This can’t be undone\./,
    );
    await expect(dialog.getByRole('button', { name: 'Delete key' })).toBeVisible();
    await captureForDesignReview(page, {
      route: '/health/storage',
      state: 'delete-confirm',
      source: SOURCE,
    });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
  });

  test('a save that fails says so in one line over the editor, keeps the typed JSON, and Save value is the retry', async ({
    page,
    pageErrors,
    checkA11y,
  }) => {
    // The writes this test cuts are the cause it declares: the page asks again as the person retries.
    for (const pattern of [
      /request failed: POST \S+\/v1\/storage\/-\/conditional-batch/,
      /Failed to load resource: net::ERR_FAILED \(\S+\/v1\/storage\/-\/conditional-batch/,
    ]) {
      pageErrors.expectEvery({
        pattern,
        reason: 'the test makes the host unanswering for a write',
      });
    }
    const pane = await openBanner(page);
    await pane.getByRole('button', { name: 'Edit' }).click();
    const editor = pane.getByRole('textbox', { name: 'Value' });
    await editor.fill('{\n  "dismissed": false\n}');

    // The host does not answer a write.
    const unanswered = (url: URL): boolean => url.pathname.startsWith('/v1/storage/');
    await page.route(unanswered, async (route) => {
      if (route.request().method() === 'GET') await route.fallback();
      else await route.abort();
    });
    // The shell probes the host once a request gets no answer, and holds changes until it answers.
    const probed = page.waitForResponse((response) => response.url().endsWith('/v1/health'));
    await pane.getByRole('button', { name: 'Save value' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();

    const alert = pane.getByTestId('storage-save-failed');
    await expect(alert).toHaveText(
      'Couldn’t save the value. Interborough didn’t answer. Your edit is still here.',
    );
    await expect(alert.locator('strong')).toHaveText('Couldn’t save the value.');
    // The failure is said once: no toast repeats the alert (row 80w).
    await expect(page.getByRole('group', { name: 'Notification' })).toHaveCount(0);
    // The alert is above the editor, which keeps what was typed; the header folds the key into its line.
    const alertBox = await alert.boundingBox();
    const editorBox = await editor.boundingBox();
    expect((alertBox?.y ?? 0) + (alertBox?.height ?? 0)).toBeLessThanOrEqual(editorBox?.y ?? 0);
    await expect(editor).toHaveValue('{\n  "dismissed": false\n}');
    await expect(pane.getByTestId('storage-key-summary')).toHaveText(
      new RegExp(`^App data and memory, 96 B, ${BANNER}$`),
    );
    // Cancel, then Save value, and Save value keeps its own label as the retry.
    await expect(pane.getByRole('button')).toHaveText(['Cancel', 'Save value']);
    // A write the host never answered makes the shell hold what changes things until the host
    // answers its probe, which it does at once here (only writes are cut). The frame is the page
    // once that has passed: no connection banner, and Save value live as the retry the row names.
    await probed;
    await expect(page.getByRole('region', { name: 'Connection problem' })).toHaveCount(0);
    await expect(pane.getByRole('button', { name: 'Save value' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await expect(pane.getByRole('button', { name: 'Save value' })).toBeEnabled();
    await captureForDesignReview(page, {
      route: '/health/storage',
      state: 'save-failed',
      source: SOURCE,
    });
    await checkA11y('health storage, a failed save');

    // The retry writes when the host answers again.
    await page.unroute(unanswered);
    await pane.getByRole('button', { name: 'Save value' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click();
    await expect(pane.getByTestId('storage-save-failed')).toHaveCount(0);
    await expect(pane.getByRole('textbox', { name: 'Value' })).toHaveCount(0);
  });

  test('the app rewrites the key while it is edited: a warning with three ways on, the draft kept, and nothing overwritten', async ({
    page,
    request,
    checkA11y,
  }) => {
    const pane = await openBanner(page);
    await pane.getByRole('button', { name: 'Edit' }).click();
    const editor = pane.getByRole('textbox', { name: 'Value' });
    await editor.fill('{\n  "dismissed": false\n}');

    // The app writes the key while the editor is open.
    const theirs = '{"dismissed":true,"dismissedOn":"2026-11-02T16:45:00Z"}';
    await request.put(valueAddress(BANNER), { data: theirs });

    // 80x: a warning-tone alert with a bold lead and when the app wrote, over the editor.
    const alert = pane.getByTestId('storage-rewritten');
    await expect(alert).toHaveText(
      /^This key changed while you were editing\. The app wrote a new value at \d{1,2}:\d{2} (AM|PM)\.$/,
    );
    await expect(alert.locator('strong')).toHaveText('This key changed while you were editing.');
    const banner = page.locator('main .cinder-alert[data-cinder-variant="warning"]');
    await expect(banner).toHaveCount(1);
    // The alert only says it. The three ways on are one row under the editor: Discard my edit and
    // Save over it are secondary, Show new value is the primary, left to right.
    await expect(banner.getByRole('button')).toHaveCount(0);
    const buttons = pane.locator('.ib-storage-key__actions').getByRole('button');
    const editorBox = await editor.boundingBox();
    const rowBox = await pane.locator('.ib-storage-key__actions').boundingBox();
    expect(rowBox?.y ?? 0).toBeGreaterThan((editorBox?.y ?? 0) + (editorBox?.height ?? 0) - 1);
    const boxes = await buttons.evaluateAll((all) =>
      all.map((button) => button.getBoundingClientRect().top),
    );
    expect(new Set(boxes.map(Math.round)).size).toBe(1);
    await expect(buttons).toHaveText(['Discard my edit', 'Save over it…', 'Show new value']);
    await expect(buttons.nth(0)).toHaveAttribute('data-cinder-variant', 'secondary');
    await expect(buttons.nth(1)).toHaveAttribute('data-cinder-variant', 'secondary');
    await expect(buttons.nth(2)).toHaveAttribute('data-cinder-variant', 'primary');
    // The draft stays in the editor, under the alert, and the editor's own buttons give way.
    await expect(editor).toHaveValue('{\n  "dismissed": false\n}');
    await expect(pane.getByRole('button', { name: 'Save value' })).toHaveCount(0);
    await expect(pane.getByTestId('storage-key-summary')).toHaveText(
      new RegExp(`^App data and memory, \\d+ B, ${BANNER}$`),
    );
    expect(await storedText(request, BANNER)).toBe(theirs);
    await captureForDesignReview(page, {
      route: '/health/storage',
      state: 'rewritten-while-editing',
      source: SOURCE,
    });
    await checkA11y('health storage, a key rewritten while it is edited');

    // Save over it asks first, because it replaces the app's newer value.
    await buttons.nth(1).click();
    const dialog = page.getByRole('dialog', { name: 'Overwrite the app’s newer value?' });
    await expect(dialog.getByRole('button', { name: 'Save over it' })).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    expect(await storedText(request, BANNER)).toBe(theirs);

    // Show new value puts what the app wrote in the editor to edit again.
    await buttons.nth(2).click();
    await expect(alert).toHaveCount(0);
    await expect(editor).toHaveValue(theirs);
  });

  test('a value too large to lay out is text under its size: the first 64 KB, no switch, and Copy value copies all of it', async ({
    page,
    request,
    checkA11y,
  }) => {
    const key = 'log:server';
    const line = '2026-11-02 09:00:02 server started\n';
    // The REST write takes at most 1 MiB, so the live host holds the largest value it can be handed;
    // the board's 2.1 MB log reads the same way (component tests cover that size).
    const log = line.repeat(Math.floor(1_000_000 / line.length));
    const size = formatBytes(new TextEncoder().encode(log).byteLength);
    const written = await request.put(valueAddress(key), { data: log });
    expect(written.ok()).toBe(true);
    try {
      await openStorage(page);
      const main = page.locator('main');
      await main.getByPlaceholder('Keys starting with').fill(key);
      await main.locator(`tr[data-cinder-row-id="${key}"]`).click();
      const pane = main.getByTestId('storage-key');

      // 81b: the heading names the kind and the size, the text is the start of the value, and a note says why.
      await expect(pane.getByTestId('storage-key-summary')).toHaveText(
        new RegExp(`, ${size}, updated `),
      );
      await expect(pane.getByText(`Value, text, ${size}`)).toBeVisible();
      await expect(pane.getByRole('radio')).toHaveCount(0);
      await expect(pane.getByTestId('storage-text-note')).toHaveText(
        `Showing the first 64 KB. Copy value copies all ${size}. This value isn’t JSON, so there is no Fields or JSON switch.`,
      );
      await expect(pane.getByRole('button', { name: 'Copy key' })).toBeVisible();
      await expect(pane.getByRole('button', { name: 'Copy value' })).toBeVisible();
      const drawn = (await pane.locator('.cinder-code-block').textContent()) ?? '';
      expect(drawn.length).toBeLessThanOrEqual(64 * 1024 + 64);
      expect(drawn).toContain('2026-11-02 09:00:02 server started');
      await captureForDesignReview(page, {
        route: '/health/storage',
        state: 'large-text-value',
        source: SOURCE,
      });
      await checkA11y('health storage, a value shown as text');
    } finally {
      await request.delete(valueAddress(key));
    }
  });

  test('nothing selected: the pane says what to do, the table keeps no row highlighted', async ({
    page,
    checkA11y,
  }) => {
    await openStorage(page);
    const main = page.locator('main');
    const detail = main.locator('.cinder-list-detail__detail');
    await expect(
      detail.getByRole('heading', { name: 'Select a key to see its value' }),
    ).toBeVisible();
    await expect(
      detail.getByText(
        'Pick a row to read what is stored. Keys Interborough doesn’t manage can also be edited and deleted.',
      ),
    ).toBeVisible();
    await expect(detail.locator('.cinder-empty-state svg')).toBeVisible();
    await expect(main.locator('tbody tr[aria-current="true"]')).toHaveCount(0);
    await captureForDesignReview(page, {
      route: '/health/storage',
      state: 'nothing-selected',
      source: SOURCE,
    });
    await checkA11y('health storage, nothing selected');
  });

  test('while the keys are read the filters stay, rows appear after 300 ms, Still loading with Cancel after 10 s, and Cancel stops the read', async ({
    page,
    checkA11y,
  }) => {
    const held = await holdRequests(
      page,
      (url, method) => method === 'GET' && url.pathname === '/v1/storage',
    );
    await openStorageOnAClock(page);
    const main = page.locator('main');

    // The real filter row, at once.
    const filters = main.getByRole('search', { name: 'Find a key' });
    await expect(filters.getByLabel('Group', { exact: true })).toHaveValue('');
    await expect(filters.getByRole('radio')).toHaveText(['Starts with', 'Range']);
    await expect(filters.getByPlaceholder('Keys starting with')).toBeVisible();
    const loading = main.getByTestId('storage-loading');
    await expect(loading).toBeVisible();

    // After 300 ms: rows in the real layout (a dot, a key bar, a meta bar, a size bar).
    await page.clock.runFor(300);
    await expect(loading.locator('.cinder-skeleton-row')).toHaveCount(5);
    await expect(
      loading.locator('.cinder-skeleton-status-bar[data-cinder-marker="dot"]'),
    ).toHaveCount(5);
    await expect(loading.locator('.cinder-skeleton-title-bar')).toHaveCount(5);
    await expect(loading.locator('.cinder-skeleton-meta-bar')).toHaveCount(5);
    await expect(loading.locator('.cinder-skeleton-time-bar')).toHaveCount(5);
    await captureForDesignReview(page, {
      route: '/health/storage',
      state: 'loading',
      source: SOURCE,
    });
    await checkA11y('health storage, loading');

    // After 10 s: the skeleton's own line, and a Cancel.
    await page.clock.runFor(10_000);
    await expect(
      loading.getByText('Still loading. This is taking longer than usual.'),
    ).toBeVisible();
    await expect(loading.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await captureForDesignReview(page, {
      route: '/health/storage',
      state: 'loading-slow',
      source: SOURCE,
    });

    // Cancel stops the read and says so; Try again reads again.
    await loading.getByRole('button', { name: 'Cancel' }).click();
    await expect(main.getByRole('heading', { name: 'Stopped loading keys' })).toBeVisible();
    held.release();
    await main.getByRole('button', { name: 'Try again' }).click();
    await expect(main.locator('tbody tr[data-cinder-row-id]').first()).toBeVisible();
  });

  test('a key being read: the group and the key at once, Copy key disabled, the value a skeleton, Still loading with Cancel after 10 s', async ({
    page,
    checkA11y,
  }) => {
    await openStorageOnAClock(page);
    const main = page.locator('main');
    await expect(main.locator('tbody tr[data-cinder-row-id]').first()).toBeVisible();
    const key = 'agent-session:summary-index';
    const held = await holdRequests(
      page,
      (url, method) => method === 'GET' && url.pathname === valueAddress(key),
    );
    await main.locator(`tr[data-cinder-row-id="${key}"]`).click();
    const pane = main.getByTestId('storage-key');

    await expect(pane.getByTestId('storage-key-summary')).toHaveText('Chat sessions');
    await expect(pane.getByTestId('storage-key-name')).toHaveText(key);
    await expect(pane.getByRole('button')).toHaveText(['Copy key'], { useInnerText: true });
    await expect(pane.getByRole('button', { name: 'Copy key' })).toBeDisabled();
    await page.clock.runFor(300);
    await expect(pane.locator('.cinder-skeleton')).not.toHaveCount(0);
    await expect(pane.getByText('Format version')).toHaveCount(0);

    await page.clock.runFor(10_000);
    await expect(pane.getByText('Still loading. This is taking longer than usual.')).toBeVisible();
    await expect(pane.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await captureForDesignReview(page, {
      route: '/health/storage',
      state: 'value-loading-slow',
      source: SOURCE,
    });
    await checkA11y('health storage, a value being read');

    await pane.getByRole('button', { name: 'Cancel' }).click();
    await expect(pane.getByTestId('storage-key-stopped')).toBeVisible();
    held.release();
    await pane.getByRole('button', { name: 'Try again' }).click();
    await expect(pane.getByText('Format version')).toBeVisible();
    await expect(pane.getByRole('button', { name: 'Copy key' })).toBeEnabled();
  });

  test('when Scroll to load more fails, the rows stay and the footer is Cinder’s load more with its retry', async ({
    page,
    pageErrors,
    checkA11y,
  }) => {
    // The next page is the one cause this test declares: the host answers it with a 500.
    pageErrors.expectEvery({
      pattern: /status of 500.*\/v1\/storage\?.*gt=/,
      reason: 'the test makes the host fail the page after the first',
    });
    await openStorage(page);
    const main = page.locator('main');
    const footer = main.getByTestId('storage-count');
    await expect(footer).toContainText('Showing 100 of');
    const rowCount = await main.locator('tbody tr[data-cinder-row-id]').count();

    // The next page is not answered.
    const nextPage = (url: URL): boolean =>
      url.pathname === '/v1/storage' && url.searchParams.has('gt');
    await page.route(nextPage, (route) =>
      route.fulfill({ status: 500, json: { error: 'The store is unavailable.' } }),
    );
    await main
      .locator('.cinder-list-detail__rows .cinder-data-table__end')
      .scrollIntoViewIfNeeded();
    const loadMore = main.locator('.cinder-load-more');
    await loadMore.scrollIntoViewIfNeeded();
    await expect(loadMore).toBeVisible();
    await expect(loadMore.locator('[role="alert"] strong')).toHaveText('Couldn’t load more keys.');
    await expect(loadMore.getByRole('alert')).toHaveText(
      /^Couldn’t load more keys\. Showing 100 of [\d,]+\.$/,
    );
    await expect(loadMore.getByRole('button', { name: 'Load more' })).toBeVisible();
    await expect(main.locator('tbody tr[data-cinder-row-id]')).toHaveCount(rowCount);
    await captureForDesignReview(page, {
      route: '/health/storage',
      state: 'load-more-failed',
      source: SOURCE,
    });
    await checkA11y('health storage, load more failed');

    // A keyboard user retries with the button; the footer goes back to counting.
    await page.unroute(nextPage);
    await loadMore.getByRole('button', { name: 'Load more' }).focus();
    await page.keyboard.press('Enter');
    await expect(main.getByTestId('storage-count')).toContainText(/Showing (200|300) of/);
    await expect(main.locator('.cinder-load-more')).toHaveCount(0);
  });

  test.describe('on a touch phone', () => {
    test.use({ viewport: { width: 375, height: 900 }, hasTouch: true, isMobile: true });

    test('the table and the pane are one at a time, the pane with a Back button, and the page never scrolls sideways', async ({
      page,
      checkA11y,
    }) => {
      await page.goto('/health/storage');
      const main = page.locator('main');
      const first = main.locator('tbody tr[data-cinder-row-id]').first();
      await expect(first).toBeVisible();
      await expect(main.locator('.cinder-list-detail')).toHaveAttribute(
        'data-cinder-layout',
        'stacked',
      );
      await first.click();
      await expect(main.getByTestId('storage-key')).toBeVisible();
      await expect(main.locator('tbody tr[data-cinder-row-id]')).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await captureForDesignReview(page, {
        route: '/health/storage',
        state: 'pane-phone',
        source: SOURCE,
      });
      await checkA11y('health storage, a key at 375px');

      await main.getByRole('button', { name: 'Back' }).click();
      await expect(main.locator('tbody tr[data-cinder-row-id]').first()).toBeVisible();
      await expect(main.getByTestId('storage-key')).toHaveCount(0);
    });
  });
});

test.describe('Health › Storage with the design’s own keys', () => {
  test('the table lists the ten sample rows in the board’s order with the first open, and its Fields are the flat list', async ({
    page,
    checkA11y,
  }) => {
    await page.clock.setFixedTime(SAMPLE_NOW);
    await answerStorageFrom(page, BOARD_KEYS);
    await openStorage(page);
    const main = page.locator('main');

    // 80g: the ten rows, each with its group, its size and its time in Central time.
    expect(await firstRows(page, 10)).toEqual([
      ['agent-session:summary-index', 'Chat sessions', '1.2 KB', 'Today, 10:44 AM'],
      ['agent-session:415b1fd8…:messages', 'Chat sessions', '310 B', 'Today, 10:42 AM'],
      ['app:preferences', 'App data and memory', '64 B', 'Today, 9:40 AM'],
      ['app:goals', 'App data and memory', '410 B', 'Today, 9:00 AM'],
      ['audit:2026-11-02T16:33:08Z', 'Audit log', '220 B', 'Today, 10:33 AM'],
      ['bureau-goal:seeded-goal', 'Goals', '880 B', 'Today, 9:00 AM'],
      ['bureau-task:run-1-12b71b8b…', 'Tasks', '540 B', 'Today, 9:00 AM'],
      ['bureau-catalog-run:run-1-12b71b8b…', 'Runs', '2.4 KB', 'Today, 9:00 AM'],
      ['steering-log:415b1fd8…:0001', 'Chat steering', '180 B', 'Today, 10:42 AM'],
      ['schedule:daily-summary', 'Schedules', '360 B', 'Today, 10:40 AM'],
    ]);

    // The first row is open and tinted, and the pane says what the board's does.
    const first = main.locator('tr[data-cinder-row-id="agent-session:summary-index"]');
    await first.click();
    await expect(first).toHaveAttribute('aria-current', 'true');
    const pane = main.getByTestId('storage-key');
    await expect(pane.getByTestId('storage-key-summary')).toHaveText(
      'Chat sessions, 1.2 KB, updated today, 10:44 AM',
    );
    // 80k: Fields is the flat list of label and value the board draws.
    const value = pane.getByRole('group', { name: 'Value' });
    await expect(value.getByRole('radio', { name: 'Fields' })).toBeChecked();
    await expect(value).toContainText(
      /Format version\s*3\s*Chat\s*Refund order 4471\s*Agent\s*Tool runner\s*Messages\s*14\s*Summarized\s*Today, 10:44 AM/,
    );
    await captureForDesignReview(page, {
      route: '/health/storage',
      state: 'ready',
      source: SOURCE,
    });
    await captureForDesignReview(page, {
      route: '/health/storage',
      state: 'key selected',
      source: SOURCE,
    });
    await checkA11y('health storage with the design’s keys');
  });

  test('Range lists the three audit keys between its two ends, the middle one highlighted', async ({
    page,
    checkA11y,
  }) => {
    await page.clock.setFixedTime(SAMPLE_NOW);
    await answerStorageFrom(page, BOARD_RANGE_KEYS);
    await openStorage(page);
    const main = page.locator('main');

    await main.getByRole('radio', { name: 'Range' }).click();
    const range = main.getByRole('search', { name: 'Find a key' }).getByRole('group', {
      name: 'Range',
    });
    await range.getByLabel('Range start').fill('audit:2026-11-01');
    await range.getByLabel('Range end').fill('audit:2026-11-02');
    await expect(main.locator('tbody tr[data-cinder-row-id]')).toHaveCount(3);
    // 80q: the keys, their sizes, and their times in Central time.
    expect(await firstRows(page, 3)).toEqual([
      ['audit:2026-11-01T22:12:31Z', 'Audit log', '210 B', 'Sun Nov 1, 4:12 PM'],
      ['audit:2026-11-02T15:00:02Z', 'Audit log', '224 B', 'Today, 9:00 AM'],
      ['audit:2026-11-02T16:33:08Z', 'Audit log', '220 B', 'Today, 10:33 AM'],
    ]);
    await main.locator('tbody tr[data-cinder-row-id]').nth(1).click();
    await expect(main.locator('tbody tr[aria-current="true"]')).toHaveCount(1);
    await captureForDesignReview(page, {
      route: '/health/storage',
      state: 'range',
      source: SOURCE,
    });
    await checkA11y('health storage range with the design’s keys');
  });
});
