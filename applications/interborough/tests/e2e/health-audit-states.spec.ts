/**
 * The Health Audit log tab in the states the sample world does not draw (COR-2018, rows 82s to
 * 82w, 83a to 83e, 83h and 83i). The showcase host holds a log with events in it, so each state is
 * drawn by answering the Bureau's reads of the log (`bureau.audit.query`) as a host in that state
 * would: nothing at all for first use and for filters that match nothing, held for a read that is
 * still loading, an error for one that failed, and an error once the page holds the log, which is
 * a refresh that failed. The log's own rows, and its filters against the real host, are in
 * `health-audit.spec.ts`.
 *
 * The page reads the log with three kinds of request that a state answers apart: the table's pages
 * (50 events), the one event the page asks for to learn whether the log is empty at all, and the
 * pages Export reads (100 events). A state answers the ones it is about and leaves the rest to the
 * host.
 */
import type { Page, Route } from '@playwright/test';

import { SAMPLE_NOW, SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, loggedFailedResponse, pressRecorder, test } from './fixtures.ts';

test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

const SOURCE = 'health-audit-states.spec.ts';
const WIDTHS = [1280, 375] as const;

/** What a request for the log asks for, from its own parameters. */
type Read = 'page' | 'total' | 'probe' | 'export';

/** Which kind of read the parameters are. */
function readOf(params: Record<string, unknown>): Read {
  if (params['includeTotal'] === true) return 'total';
  if (params['limit'] === 1) return 'probe';
  if (params['limit'] === 100) return 'export';
  return 'page';
}

/** A Bureau read of the log, once it has been parsed. */
interface AuditRequest {
  id: unknown;
  read: Read;
}

/**
 * Answers the Bureau's reads of the log. `answer` gets the kind of read and returns what to reply
 * with (a result, `'hold'` to leave it unanswered until `release`, `'fail'` for a 500), or
 * `undefined` to leave it to the host.
 */
async function answerAudit(
  page: Page,
  answer: (read: Read) => unknown,
  gate?: Promise<void>,
): Promise<void> {
  await page.route('**/bureau/jsonrpc', async (route: Route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as {
      id: unknown;
      method?: string;
      params?: Record<string, unknown>;
    };
    if (body.method !== 'bureau.audit.query') {
      await route.fallback();
      return;
    }
    const request: AuditRequest = { id: body.id, read: readOf(body.params ?? {}) };
    const reply = await answer(request.read);
    if (reply === undefined) {
      await route.fallback();
    } else if (reply === 'hold') {
      await gate;
      await route.fallback();
    } else if (reply === 'fail') {
      await route.fulfill({ status: 500, json: { error: 'The server broke.' } });
    } else {
      await route.fulfill({ json: { jsonrpc: '2.0', id: request.id, result: reply } });
    }
  });
}

const NOTHING = { records: [], nextCursor: null };
const NO_EVENTS_COUNTED = { records: [], nextCursor: null, total: 0 };

/** The Bureau's reads fail with a 500, which Chromium logs once for each. */
const LOGGED = /\/bureau\/jsonrpc/;

/** Opens the log on a clock that can be moved, which the loading state needs. */
async function openOnAClock(page: Page, width: number, address = '/health/audit'): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await page.clock.install({ time: SAMPLE_NOW });
  await page.goto(address);
}

/** Opens the log with the browser's clock pinned to the sample "now". */
async function open(page: Page, width: number, address = '/health/audit'): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await page.clock.setFixedTime(SAMPLE_NOW);
  await page.goto(address);
}

const rows = (page: Page) => page.locator('main tbody tr[data-cinder-row-id]');

for (const width of WIDTHS) {
  test.describe(`Health › Audit log states at ${width} pixels`, () => {
    test('nothing selected: the pane says what to do', async ({ page, checkA11y }) => {
      test.skip(width < 600, 'below its push breakpoint the log shows the table alone');
      await open(page, width);
      const main = page.locator('main');
      await expect(rows(page).first()).toBeVisible();

      // Filters that list different events leave none of them open.
      await main.getByLabel('Who', { exact: true }).selectOption('agents');
      await expect(page).toHaveURL(/actor=agents/);
      const pane = main.locator('.cinder-list-detail__detail');
      // 82s: a document icon in an accent disc, the title, and the line under it.
      await expect(
        pane.getByRole('heading', { name: 'Select an event to see what changed' }),
      ).toBeVisible();
      await expect(
        pane.getByText('Each event shows who did it, when, and the before and after.'),
      ).toBeVisible();
      await expect(pane.locator('.cinder-empty-state-icon svg')).toBeVisible();
      await expect(main.locator('tbody tr[aria-current="true"]')).toHaveCount(0);
      await captureForDesignReview(page, {
        route: '/health/audit',
        state: 'nothing-selected',
        source: SOURCE,
      });
      await checkA11y(`health audit, nothing selected at ${width}px`);
    });

    test('filters that match nothing: 0 events, a search icon in a neutral disc, and Clear filters', async ({
      page,
      checkA11y,
    }) => {
      await answerAudit(page, (read) =>
        read === 'page' ? NOTHING : read === 'total' ? NO_EVENTS_COUNTED : undefined,
      );
      await open(page, width, '/health/audit?actor=agents&period=today');
      const main = page.locator('main');

      // 82t: the count, the empty state, and a secondary Clear filters.
      await expect(main.getByTestId('audit-count')).toHaveText('0 events');
      const state = main.locator('.cinder-empty-state');
      await expect(
        state.getByRole('heading', { name: 'No events match these filters' }),
      ).toBeVisible();
      await expect(
        state.getByText('Nothing by agents was recorded today. Try a longer period.'),
      ).toBeVisible();
      await expect(state).toHaveAttribute('data-cinder-kind', 'filtered');
      await expect(state.locator('.cinder-empty-state-icon svg')).toBeVisible();
      const clear = state.getByRole('button', { name: 'Clear filters' });
      await expect(clear).toHaveAttribute('data-cinder-variant', 'secondary');
      await captureForDesignReview(page, {
        route: '/health/audit',
        state: 'empty-filtered',
        source: SOURCE,
      });
      await checkA11y(`health audit, filters that match nothing at ${width}px`);

      await clear.click();
      await expect(page).toHaveURL(/\/health\/audit$/);
      await expect(main.getByLabel('Who', { exact: true })).toHaveValue('');
      await expect(main.getByLabel('Period', { exact: true })).toHaveValue('7d');
    });

    test('a search with no match keeps what was typed, names it, and Clear filters resets the search too', async ({
      page,
      checkA11y,
    }) => {
      await open(page, width);
      const main = page.locator('main');
      await expect(rows(page).first()).toBeVisible();
      await main.getByLabel('Who', { exact: true }).selectOption('you');

      const box = main.getByPlaceholder('Search by actor, action or target');
      await box.fill('refund 9999');

      // 83h: the box keeps what was typed, the count is 0, and the title names the search.
      await expect(box).toHaveValue('refund 9999');
      await expect(main.getByTestId('audit-count')).toHaveText('0 events');
      await expect(
        main.getByRole('heading', { name: 'No events match “refund 9999”' }),
      ).toBeVisible();
      await expect(
        main.getByText('Check the spelling, or search by actor, action or target.'),
      ).toBeVisible();
      await captureForDesignReview(page, {
        route: '/health/audit',
        state: 'search-no-match',
        source: SOURCE,
      });
      await checkA11y(`health audit, a search with no match at ${width}px`);

      // 83i: Clear filters resets the search as well as Who, the period and the action.
      await main.getByRole('button', { name: 'Clear filters' }).click();
      await expect(box).toHaveValue('');
      await expect(main.getByLabel('Who', { exact: true })).toHaveValue('');
      await expect(page).toHaveURL(/\/health\/audit(\?record=[^&]*)?$/);
      await expect(rows(page).first()).toBeVisible();
    });

    test('a log with nothing in it is the page body: a document icon, "Nothing recorded yet", and no action', async ({
      page,
      checkA11y,
    }) => {
      await answerAudit(page, (read) => (read === 'total' ? NO_EVENTS_COUNTED : NOTHING));
      await open(page, width);
      const main = page.locator('main');

      // 82u
      const state = main.locator('.cinder-empty-state');
      await expect(state.getByRole('heading', { name: 'Nothing recorded yet' })).toBeVisible();
      await expect(
        state.getByText(
          'Changes you and your agents make show up here, newest first, with who made them and what changed.',
        ),
      ).toBeVisible();
      await expect(state.locator('.cinder-empty-state-icon svg')).toBeVisible();
      await expect(state.getByRole('button')).toHaveCount(0);
      await expect(state.getByRole('link')).toHaveCount(0);
      // Health's heading and tabs stay, and there is nothing to filter.
      await expect(main.getByRole('heading', { level: 1, name: 'Health' })).toBeVisible();
      await expect(main.getByRole('search')).toHaveCount(0);
      await captureForDesignReview(page, {
        route: '/health/audit',
        state: 'first-use',
        source: SOURCE,
      });
      await checkA11y(`health audit, first use at ${width}px`);
    });

    test('a failed load is a full error state that names the status, with Try again', async ({
      page,
      pageErrors,
      checkA11y,
    }) => {
      // The reads this test fails are the cause it declares: the page asks again as the person retries.
      pageErrors.expectEvery({
        pattern: loggedFailedResponse(500, LOGGED),
        reason: 'the test answers the log’s reads with a 500',
      });
      let failing = true;
      await answerAudit(page, (read) => (failing && read !== 'probe' ? 'fail' : undefined));
      await open(page, width);
      const main = page.locator('main');

      // 82w
      const state = main.locator('.cinder-error-state');
      await expect(
        state.getByRole('heading', { name: 'Couldn’t load the audit log' }),
      ).toBeVisible();
      await expect(
        state.getByText('The server answered with an error (500). Nothing you did caused it.'),
      ).toBeVisible();
      const retry = state.getByRole('button', { name: 'Try again' });
      await expect(retry).toHaveAttribute('data-cinder-variant', 'primary');
      await expect(retry.locator('svg')).toBeVisible();
      // This page is already on Health, so the error offers no link to it.
      await expect(state.getByRole('link')).toHaveCount(0);
      await expect(main.getByText('Check Health')).toHaveCount(0);
      await expect(main.locator('.cinder-banner')).toHaveCount(0);
      await captureForDesignReview(page, {
        route: '/health/audit',
        state: 'failed',
        source: SOURCE,
      });
      await checkA11y(`health audit, failed at ${width}px`);

      failing = false;
      await retry.click();
      await expect(rows(page).first()).toBeVisible();
    });

    test('a failed refresh keeps the log at full contrast under the shared banner, and holds only Export', async ({
      page,
      pageErrors,
      checkA11y,
    }) => {
      pageErrors.expectEvery({
        pattern: loggedFailedResponse(500, LOGGED),
        reason: 'the test answers the log’s reads with a 500 once the page holds it',
      });
      let failing = false;
      let failedReads = 0;
      // The reads keep failing until Retry now is pressed, so the banner's own countdown cannot
      // recover them and remove the button under the click.
      let pressed: () => Promise<boolean> = async () => false;
      await answerAudit(page, async (read) => {
        if (!failing || read !== 'page' || (await pressed())) return undefined;
        failedReads += 1;
        return 'fail';
      });
      await open(page, width);
      const main = page.locator('main');
      await expect(rows(page).first()).toBeVisible();
      const count = await rows(page).count();

      failing = true;
      // The person comes back to the tab, which reads the log again. A read the page began on its
      // own may still be on its way (at 1280 pixels the log is read a second time just after it
      // first shows), and coming back then joins that read instead of making one, so the person
      // comes back until a read of the log is made, and fails.
      await expect
        .poll(async () => {
          await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
          return failedReads;
        })
        .toBeGreaterThan(0);
      const banner = main.getByRole('region', { name: 'Refresh problem' });

      // 83a: the shared preset's words, with Retry now, and nothing to dismiss.
      await expect(banner).toContainText('Couldn’t refresh this page.');
      await expect(banner).toContainText(/Showing what loaded as of \d{1,2}:\d{2} (AM|PM)/);
      await expect(banner.getByRole('button', { name: 'Retry now' })).toBeVisible();
      pressed = await pressRecorder(page, 'Retry now');
      await expect(banner.getByRole('button', { name: /dismiss/i })).toHaveCount(0);
      // 83b: the filter row and the rows stay, at full contrast.
      await expect(rows(page)).toHaveCount(count);
      await expect(main.getByRole('search')).toBeVisible();
      for (const target of [main.locator('table'), main.getByRole('search')]) {
        expect(
          await target.evaluate((element) => {
            for (let node: Element | null = element; node !== null; node = node.parentElement) {
              if (Number(getComputedStyle(node).opacity) < 1) return false;
            }
            return true;
          }),
        ).toBe(true);
      }
      // 83c: Export is inert and says why; filters, search, rows and Retry now are live.
      const exportButton = main.getByRole('button', { name: 'Export' });
      await expect(exportButton).toHaveAttribute('aria-disabled', 'true');
      await expect(exportButton).toHaveAccessibleDescription('Off until the audit log loads again');
      await expect(main.getByLabel('Period', { exact: true })).not.toHaveAttribute(
        'aria-disabled',
        'true',
      );
      await expect(banner.getByRole('button', { name: 'Retry now' })).not.toHaveAttribute(
        'aria-disabled',
        'true',
      );
      await captureForDesignReview(page, {
        route: '/health/audit',
        state: 'refresh-failed',
        source: SOURCE,
      });
      await checkA11y(`health audit, a failed refresh at ${width}px`);

      await banner.getByRole('button', { name: 'Retry now' }).click();
      await expect(banner).toHaveCount(0);
      await expect(exportButton).not.toHaveAttribute('aria-disabled', 'true');
    });
  });
}

test.describe('Health › Audit log export and loading states', () => {
  test('while Export reads the log, Export reads Exporting… and is inert, and a line with Cancel says what is made', async ({
    page,
    checkA11y,
  }) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await answerAudit(page, (read) => (read === 'export' ? 'hold' : undefined), gate);
    await open(page, 1280);
    const main = page.locator('main');
    await expect(rows(page).first()).toBeVisible();
    // The count beside the search, which the line below repeats while Export prepares that many.
    const counted = await main.getByTestId('audit-count').innerText();

    await main.getByRole('button', { name: 'Export' }).click();

    // 83d
    const exporting = main.getByRole('button', { name: 'Exporting…' });
    await expect(exporting).toHaveAttribute('aria-disabled', 'true');
    const progress = main.getByTestId('audit-export-progress');
    const events = counted.replace(/ events?.*$/, '');
    await expect(progress).toContainText(`Preparing ${events} events as JSON Lines…`);
    await expect(progress.locator('.cinder-spinner')).toBeVisible();
    await expect(progress.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await captureForDesignReview(page, {
      route: '/health/audit',
      state: 'export-progress',
      source: SOURCE,
    });
    await checkA11y('health audit, export in progress');

    // Cancel stops the read, and says nothing failed.
    await progress.getByRole('button', { name: 'Cancel' }).click();
    await expect(progress).toHaveCount(0);
    await expect(main.getByRole('button', { name: 'Export', exact: true })).toBeVisible();
    await expect(main.locator('.cinder-alert')).toHaveCount(0);
    release();
  });

  for (const width of WIDTHS) {
    test(`a failed export is a danger alert with Export again at its right, at ${width} pixels`, async ({
      page,
      pageErrors,
      checkA11y,
    }) => {
      pageErrors.expectEvery({
        pattern: loggedFailedResponse(500, LOGGED),
        reason: 'the test answers the export’s reads with a 500',
      });
      let failing = true;
      await answerAudit(page, (read) => (failing && read === 'export' ? 'fail' : undefined));
      await open(page, width);
      const main = page.locator('main');
      await expect(rows(page).first()).toBeVisible();

      await main.getByRole('button', { name: 'Export' }).click();

      // 83e
      const alert = main.locator('.cinder-alert[data-cinder-variant="danger"]');
      await expect(alert).toContainText(
        'Couldn’t export. The server stopped while writing the file. Your filters are unchanged; nothing was downloaded.',
      );
      await expect(alert.locator('strong')).toHaveText('Couldn’t export.');
      const again = alert.getByRole('button', { name: 'Export again' });
      await expect(again).toBeVisible();
      if (width >= 1280) {
        // At the alert's right edge, not under its words.
        const alertBox = await alert.boundingBox();
        const againBox = await again.boundingBox();
        const textBox = await alert.locator('.cinder-alert__content').boundingBox();
        expect((againBox?.x ?? 0) + (againBox?.width ?? 0)).toBeLessThanOrEqual(
          (alertBox?.x ?? 0) + (alertBox?.width ?? 0),
        );
        expect(againBox?.x ?? 0).toBeGreaterThanOrEqual(
          (textBox?.x ?? 0) + (textBox?.width ?? 0) - 1,
        );
      }
      // Export stays available as the retry, and the filters are as they were.
      await expect(main.getByRole('button', { name: 'Export', exact: true })).not.toHaveAttribute(
        'aria-disabled',
        'true',
      );
      await expect(main.getByLabel('Period', { exact: true })).toHaveValue('7d');
      await captureForDesignReview(page, {
        route: '/health/audit',
        state: 'export-failed',
        source: SOURCE,
      });
      await checkA11y(`health audit, a failed export at ${width}px`);

      failing = false;
      await again.click();
      await expect(alert).toHaveCount(0);
    });
  }

  test('while the log is read the filters stay, rows appear after 300 ms, Still loading with Cancel after 10 s, and Cancel stops the read', async ({
    page,
    checkA11y,
  }) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await answerAudit(page, (read) => (read === 'page' ? 'hold' : undefined), gate);
    await openOnAClock(page, 1280);
    const main = page.locator('main');

    // The real filter selects, at once; nothing is counted yet.
    const filters = main.getByRole('search', { name: 'Filter the audit log' });
    await expect(filters.getByLabel('Who', { exact: true })).toHaveValue('');
    await expect(filters.getByLabel('Period', { exact: true })).toHaveValue('7d');
    await expect(main.getByTestId('audit-count')).toHaveCount(0);
    const loading = main.getByTestId('audit-loading');
    await expect(loading).toBeVisible();

    // 82v: after 300 ms, rows in the real layout (a dot, two bars and a trailing bar).
    await page.clock.runFor(300);
    await expect(loading.locator('.cinder-skeleton-row')).toHaveCount(5);
    await expect(
      loading.locator('.cinder-skeleton-status-bar[data-cinder-marker="dot"]'),
    ).toHaveCount(5);
    await expect(loading.locator('.cinder-skeleton-title-bar')).toHaveCount(5);
    await expect(loading.locator('.cinder-skeleton-meta-bar')).toHaveCount(5);
    await expect(loading.locator('.cinder-skeleton-time-bar')).toHaveCount(5);
    await captureForDesignReview(page, {
      route: '/health/audit',
      state: 'loading',
      source: SOURCE,
    });
    await checkA11y('health audit, loading');

    // After 10 s: the skeleton's own line, and a Cancel.
    await page.clock.runFor(10_000);
    await expect(
      loading.getByText('Still loading. This is taking longer than usual.'),
    ).toBeVisible();
    await expect(loading.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await captureForDesignReview(page, {
      route: '/health/audit',
      state: 'loading-slow',
      source: SOURCE,
    });

    // Cancel stops the read and says so; Try again reads again.
    await loading.getByRole('button', { name: 'Cancel' }).click();
    await expect(
      main.getByRole('heading', { name: 'Stopped loading the audit log' }),
    ).toBeVisible();
    release();
    await main.getByRole('button', { name: 'Try again' }).click();
    await expect(rows(page).first()).toBeVisible();
  });
});
