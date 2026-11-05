/**
 * The Health Storage tab on the sample world (`fixtures/sample-world-seed.ts`, the showcase host;
 * COR-2018, rows 80a to 80e, 80g, 80i to 80k, 80p to 80r and 81e). The page is read at 1280 pixels:
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
import type { Page } from '@playwright/test';

import { SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

const SOURCE = 'health-storage.spec.ts';
// The pane's line: the day is a word for today and yesterday, and the date for any other. The
// browser's clock is the sample world's in a capture and the real one otherwise.
const UPDATED_SUMMARY =
  /^Chat sessions · [\d.]+ (B|KB) · updated (today, \d{1,2}:\d{2} (AM|PM)|yesterday|[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} (AM|PM))$/;
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
    await expect(warning).toContainText('Storage is over its warning level · 1.6 GB.');
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

    // 80j, 80k: a managed key's pane, top to bottom.
    await summary.click();
    const pane = main.getByTestId('storage-key');
    await expect(summary).toHaveAttribute('aria-current', 'true');
    await expect(pane.getByTestId('storage-key-summary')).toHaveText(UPDATED_SUMMARY);
    await expect(pane.getByTestId('storage-key-name')).toHaveText('agent-session:summary-index');
    await expect(pane.getByRole('button')).toContainText(['Copy key', 'Copy value']);
    await expect(pane.getByRole('button', { name: 'Edit' })).toHaveCount(0);
    await expect(pane.getByRole('button', { name: 'Delete' })).toHaveCount(0);
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

    await captureForDesignReview(page, {
      route: '/health/storage',
      state: 'ready',
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
    await footer.scrollIntoViewIfNeeded();
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
    await expect(details.getByRole('heading', { name: 'Storage details' })).toBeVisible();
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
    const borderColor = await end.evaluate((element) => getComputedStyle(element).borderColor);
    expect(borderColor).not.toBe(
      await start.evaluate((element) => getComputedStyle(element).borderColor),
    );
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

      const widths = await pane.evaluate((element) => ({
        pane: element.getBoundingClientRect().width,
        scroll: element.scrollWidth,
        page: document.documentElement.scrollWidth,
        viewport: innerWidth,
      }));
      expect(widths.scroll).toBeLessThanOrEqual(Math.ceil(widths.pane));
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
