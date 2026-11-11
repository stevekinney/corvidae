/**
 * The Runs list (`/runs`) on the sample world (`fixtures/sample-world-seed.ts`, the showcase host) at
 * the browser's sample clock, Monday, Nov 2, 10:46 AM Central time (COR-2017, design rows 10k, 10l,
 * 10q, 10r, 12r to 12v, 14m, 14n, 14p, 14s, 15d, 52v to 52z, 53b, 05t to 05y, 06w and 07j): the list
 * on a phone, a tablet and in the dark, and each state of it that is not a list of rows (first use,
 * filtered to nothing, loading, still loading, canceled, failing, and a server that stopped
 * answering). The sample world's run list is All 20 = Waiting on you 2 + Done 15 + Failed 1 +
 * Canceled 2. A state the sample world does not hold is made by answering the Bureau's own operation
 * with what a different world would answer, and each is captured for the design review under its own
 * name. The timings the placeholders keep (nothing for 300 ms, a status line at 10 s) are driven with
 * the page's clock, never slept.
 */
import type { Page, Route } from '@playwright/test';

import {
  SAMPLE_NOW,
  SAMPLE_NOW_MILLISECONDS,
  SAMPLE_TIME_ZONE,
} from '../../fixtures/sample-now.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, loggedFailedResponse, test } from './fixtures.ts';

test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

const SOURCE = 'runs-states.spec.ts';
const WIDTHS = [1280, 375] as const;
/** Every request the page makes of the host, which a test takes away to make the server stop answering. */
const HOST_REQUESTS = /\/(v1|bureau|api)\//;

/** The runs the sample world holds, as the segments count them (Nov 3 correction). */
const SEGMENTS = [
  ['All', 20],
  ['Waiting on you', 2],
  ['Running', 0],
  ['Done', 15],
  ['Failed', 1],
  ['Canceled', 2],
] as const;

/** Opens the list at `width` and waits until the runs are listed. */
async function openRuns(page: Page, width = 1280, path = '/runs'): Promise<void> {
  await page.clock.setFixedTime(SAMPLE_NOW);
  await page.setViewportSize({ width, height: 900 });
  await page.goto(path);
  await expect(page.locator('main li[data-run]').first()).toBeVisible();
}

/** Answers the Bureau operation `method` with `answer`, and leaves every other operation to the host. */
async function answerOperation(
  page: Page,
  method: string,
  answer: (route: Route, id: unknown) => Promise<void> | void,
): Promise<void> {
  await page.route('**/bureau/jsonrpc', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as {
      method?: string;
      id?: unknown;
    };
    if (body.method === method) {
      await answer(route, body.id);
      return;
    }
    await route.fallback();
  });
}

/** The header's "+": a secondary icon button named for what it starts. */
const headerCreate = (page: Page) => page.locator('main .cinder-page-header__create');
/** Every primary button or link on the page, which a list page keeps to the one its state offers. */
const primaries = (page: Page) => page.locator('main [data-cinder-variant="primary"]');
const filterBar = (page: Page) => page.getByRole('toolbar', { name: 'Filter runs' });

test.describe('the list on a phone, a tablet and in the dark', () => {
  test('on a phone is two-line rows under day bands, with a Status select and a Filter button beside a secondary "+" (05t, 05v)', async ({
    page,
    checkA11y,
  }) => {
    await openRuns(page, 375);
    const main = page.locator('main');
    await expect(main.getByRole('heading', { level: 1, name: 'Runs' })).toBeVisible();
    await expect(main.getByText('What your agents have done, newest first.')).toBeVisible();
    await expect(headerCreate(page)).toHaveAttribute('data-cinder-variant', 'secondary');
    // The segments fold into one select and the chips into a Filter menu.
    await expect(filterBar(page).locator('.cinder-filter-bar__segments-select')).toContainText(
      'Status: All',
    );
    await expect(filterBar(page).getByRole('button', { name: 'Filter' })).toBeVisible();
    await expect(filterBar(page).getByRole('radio')).toHaveCount(0);
    // The day bands name the zone at the right.
    const bands = main.locator('.cinder-data-list-group__header');
    await expect(bands.nth(0)).toHaveText(/^Today, Monday, Nov 2\s*Central time$/);
    await expect(bands.nth(1)).toHaveText(/^Yesterday, Sunday, Nov 1\s*Central time$/);
    const scrolls = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(scrolls, 'the page never scrolls sideways').toBe(false);
    await captureForDesignReview(page, { route: '/runs', state: 'ready', source: SOURCE });
    await checkA11y('runs on a phone');
  });

  test('on a tablet folds the segments into a Status select, keeps the Started by and Agent chips, and turns search into an icon button (05x, 05y)', async ({
    page,
    checkA11y,
  }) => {
    await openRuns(page, 768);
    const bar = filterBar(page);
    await expect(bar.locator('.cinder-filter-bar__segments-select')).toContainText('Status: All');
    await expect(bar.getByRole('radio')).toHaveCount(0);
    await expect(bar.getByRole('button', { name: 'Started by', exact: true })).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Agent', exact: true })).toBeVisible();
    await expect(bar.getByRole('button', { name: 'Search runs' })).toBeVisible();
    await expect(headerCreate(page)).toHaveAttribute('data-cinder-variant', 'secondary');
    await captureForDesignReview(page, { route: '/runs', state: 'ready', source: SOURCE });
    await checkA11y('runs on a tablet');
  });

  test('in the dark keeps every segment with its count, the day bands and the rows legible (07j)', async ({
    page,
    checkA11y,
  }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await openRuns(page, 1280);
    for (const [word, count] of SEGMENTS) {
      await expect(
        page.getByRole('radio', { name: new RegExp(`^${word}\\s*,\\s*${String(count)}$`) }),
      ).toBeVisible();
    }
    await expect(page.locator('main .cinder-data-list-group__header').first()).toContainText(
      'Central time',
    );
    await captureForDesignReview(page, { route: '/runs', state: 'ready (dark)', source: SOURCE });
    await checkA11y('runs in the dark');
  });
});

for (const width of WIDTHS) {
  test.describe(`the states of the list, at ${width} pixels`, () => {
    test('first use is "No runs yet" with the only primary Start run beside a secondary Chat with an agent (52v, 52w)', async ({
      page,
      checkA11y,
    }) => {
      await answerOperation(page, 'bureau.tasks.list', (route, id) =>
        route.fulfill({
          json: { jsonrpc: '2.0', id, result: { tasks: [], nextPageToken: null } },
        }),
      );
      await answerOperation(page, 'bureau.goals.list', (route, id) =>
        route.fulfill({ json: { jsonrpc: '2.0', id, result: { goals: [], nextOffset: null } } }),
      );
      await page.clock.setFixedTime(SAMPLE_NOW);
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/runs');
      const main = page.locator('main');

      await expect(main.getByRole('heading', { level: 1, name: 'Runs' })).toBeVisible();
      await expect(main.getByRole('heading', { level: 2, name: 'No runs yet' })).toBeVisible();
      await expect(main).toContainText(
        'A run is one piece of work an agent or workflow does. Chat with an agent, or start a workflow, and it shows up here.',
      );
      // The empty state is the page: no filter bar.
      await expect(filterBar(page)).toHaveCount(0);
      await expect(headerCreate(page)).toHaveAttribute('data-cinder-variant', 'secondary');
      await expect(primaries(page)).toHaveCount(1);
      await expect(primaries(page).first()).toHaveText('Start run');
      await expect(main.getByRole('link', { name: 'Chat with an agent' })).toHaveAttribute(
        'data-cinder-variant',
        'secondary',
      );
      const disc = main.locator('.cinder-empty-state-icon');
      await expect(disc).toHaveCount(1);
      await expect(disc.locator('svg')).toHaveCount(1);

      await captureForDesignReview(page, { route: '/runs', state: 'first use', source: SOURCE });
      await checkA11y(`runs first use at ${width}px`);

      await primaries(page).first().click();
      await expect(page).toHaveURL(/\/runs\/new$/);
    });

    test('filtered to nothing keeps the bar, every segment at 0 and the chip, over a Clear filters state that names the agent (10q, 10r, 12r to 12t)', async ({
      page,
      checkA11y,
    }) => {
      await page.clock.setFixedTime(SAMPLE_NOW);
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/runs?agent=model-switcher');
      const main = page.locator('main');

      await expect(
        main.getByRole('heading', { level: 2, name: 'No runs match these filters' }),
      ).toBeVisible();
      await expect(main).toContainText('Model switcher has no runs. Try another agent.');
      await expect(headerCreate(page)).toHaveAttribute('data-cinder-variant', 'secondary');
      if (width >= 1024) {
        for (const [word] of SEGMENTS) {
          await expect(
            main.getByRole('radio', { name: new RegExp(`^${word}\\s*,\\s*0$`) }),
          ).toBeVisible();
        }
        await expect(main.getByRole('radio', { name: /^Waiting\s*,/ })).toHaveCount(0);
        await expect(
          main.getByRole('button', { name: 'Agent: Model switcher', exact: true }),
        ).toBeVisible();
      }
      // A neutral disc with a funnel, and the secondary Clear filters as the only action.
      const state = main.locator('.cinder-empty-state');
      await expect(state).toHaveAttribute('data-cinder-kind', 'filtered');
      await expect(state.getByRole('button')).toHaveCount(1);
      const clear = state.getByRole('button', { name: 'Clear filters' });
      await expect(clear).toHaveAttribute('data-cinder-variant', 'secondary');
      await expect(primaries(page)).toHaveCount(0);

      await captureForDesignReview(page, {
        route: '/runs',
        state: 'filtered to nothing',
        source: SOURCE,
      });
      await checkA11y(`runs filtered to nothing at ${width}px`);

      await clear.click();
      await expect(page).toHaveURL(/\/runs$/);
      await expect(main.locator('li[data-run]').first()).toBeVisible();
    });

    test('an agent and an origin together are named in the sentence (52x, 52y)', async ({
      page,
    }) => {
      await page.clock.setFixedTime(SAMPLE_NOW);
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/runs?agent=model-switcher&startedBy=goal');
      const main = page.locator('main');
      await expect(main).toContainText(
        'Model switcher has no runs started by a goal. Try another agent or origin.',
      );
      await expect(headerCreate(page)).toBeVisible();
      await captureForDesignReview(page, {
        route: '/runs',
        state: 'filtered to nothing (agent and origin)',
        source: SOURCE,
      });
    });

    test('failing is the full error state under the header, with Try again as the only primary and Check Health beside it (12u, 12v, 14s, 53b)', async ({
      page,
      pageErrors,
      checkA11y,
    }) => {
      // The test answers the runs' read with a 500, and Chromium logs each such response.
      pageErrors.expectEvery({
        pattern: loggedFailedResponse(500, /\/bureau\/jsonrpc/),
        reason: 'the test answers the runs list with a 500',
      });
      await answerOperation(page, 'bureau.tasks.list', (route) =>
        route.fulfill({ status: 500, json: { error: 'The server broke.' } }),
      );
      await page.clock.setFixedTime(SAMPLE_NOW);
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/runs');
      const main = page.locator('main');

      await expect(
        main.getByRole('heading', { level: 2, name: 'Couldn’t load runs' }),
      ).toBeVisible();
      await expect(main.getByRole('heading', { level: 1, name: 'Runs' })).toBeVisible();
      await expect(main).toContainText(
        'The server answered with an error (500). Nothing you did caused it.',
      );
      // The full state replaces the list: no rows, no filter bar, and no banner beside it.
      await expect(main.locator('li[data-run]')).toHaveCount(0);
      await expect(filterBar(page)).toHaveCount(0);
      await expect(main.getByRole('region', { name: /problem/ })).toHaveCount(0);
      await expect(primaries(page)).toHaveCount(1);
      await expect(primaries(page).first()).toHaveText('Try again');
      await expect(main.getByRole('link', { name: 'Check Health' })).toHaveAttribute(
        'data-cinder-variant',
        'secondary',
      );
      await expect(main.getByText('Show the error details')).toBeVisible();
      // The header's "+" is the secondary icon button, muted: inert, so Try again is the one strong action.
      await expect(headerCreate(page)).toHaveAttribute('data-cinder-variant', 'secondary');
      await expect(headerCreate(page)).toHaveAttribute('aria-disabled', 'true');

      await captureForDesignReview(page, { route: '/runs', state: 'failing', source: SOURCE });
      await checkA11y(`runs failing at ${width}px`);

      // The server comes back, and Try again reads the runs.
      await page.unroute('**/bureau/jsonrpc');
      await primaries(page).first().click();
      await expect(main.locator('li[data-run]').first()).toBeVisible();
      await expect(headerCreate(page)).not.toHaveAttribute('aria-disabled', 'true');
    });
  });
}

test.describe('a read in progress (10k, 10l, 14m, 14n, 14p, 52z)', () => {
  /** Holds every read of the runs until `release`, with the page's clock paused at the sample instant. */
  async function openLoading(page: Page, width: number): Promise<() => void> {
    await page.clock.install({ time: SAMPLE_NOW_MILLISECONDS - 1_000 });
    await page.clock.pauseAt(SAMPLE_NOW);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await answerOperation(page, 'bureau.tasks.list', async (route) => {
      await gate;
      await route.fallback().catch(() => undefined);
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/runs');
    return release;
  }

  test('is skeleton rows under the live header and "+", after 300 ms, with the six segments and no counts', async ({
    page,
    checkA11y,
  }) => {
    const release = await openLoading(page, 1280);
    const main = page.locator('main');
    await expect(main.getByRole('heading', { level: 1, name: 'Runs' })).toBeVisible();
    await expect(headerCreate(page)).toBeVisible();
    await expect(headerCreate(page)).not.toHaveAttribute('aria-disabled', 'true');
    await expect(main.locator('.cinder-skeleton-list')).toHaveCount(0);
    await expect(filterBar(page)).toHaveCount(0);

    await page.clock.runFor(300);
    await expect(main.locator('.cinder-skeleton-list')).toBeVisible();
    await expect(main.locator('.cinder-skeleton-day-band')).toHaveCount(1);
    await expect(main.locator('.cinder-skeleton-row')).toHaveCount(5);
    for (const [word] of SEGMENTS) {
      await expect(
        main.getByRole('radio', { name: new RegExp(`^${word}\\s*,\\s*loading$`) }),
      ).toBeVisible();
    }
    await expect(main.locator('li[data-run]')).toHaveCount(0);

    await captureForDesignReview(page, { route: '/runs', state: 'loading', source: SOURCE });
    await checkA11y('runs loading');
    await page.clock.resume();
    release();
    await expect(main.locator('li[data-run]').first()).toBeVisible();
    await expect(main.locator('.cinder-skeleton-row')).toHaveCount(0);
  });

  test('says it is taking longer than usual after 10 s, and Cancel leaves Loading canceled with Try again', async ({
    page,
    checkA11y,
  }) => {
    const release = await openLoading(page, 1280);
    const main = page.locator('main');
    await page.clock.runFor(300);
    await expect(main.locator('.cinder-skeleton-list')).toBeVisible();
    await expect(main).not.toContainText('Still loading runs.');

    await page.clock.runFor(10_000);
    await expect(main).toContainText('Still loading runs. This is taking longer than usual.');
    await captureForDesignReview(page, { route: '/runs', state: 'still loading', source: SOURCE });

    await main.getByRole('button', { name: 'Cancel' }).click();
    await expect(main.getByRole('heading', { level: 2, name: 'Loading canceled' })).toBeVisible();
    await expect(main).toContainText(
      'Runs didn’t finish loading. Nothing is missing; it just wasn’t fetched.',
    );
    // The header and the six segments stay; nothing that had data is blanked.
    await expect(main.getByRole('heading', { level: 1, name: 'Runs' })).toBeVisible();
    for (const [word] of SEGMENTS) {
      await expect(
        main.getByRole('radio', { name: new RegExp(`^${word}\\s*,\\s*loading$`) }),
      ).toBeVisible();
    }
    await expect(main.locator('.cinder-skeleton-row')).toHaveCount(0);
    await expect(primaries(page)).toHaveCount(1);
    await expect(primaries(page).first()).toHaveText('Try again');
    await captureForDesignReview(page, {
      route: '/runs',
      state: 'loading canceled',
      source: SOURCE,
    });
    await checkA11y('runs loading canceled');

    await page.clock.resume();
    release();
    await primaries(page).first().click();
    await expect(main.locator('li[data-run]').first()).toBeVisible();
  });
});

test('a server that stops answering over the list keeps it at full contrast and holds the header "+" with its reason (06w, 15d)', async ({
  page,
  pageErrors,
}) => {
  const refused = 'net::ERR_CONNECTION_REFUSED';
  let requests = 0;
  let consoles = 0;
  page.on('requestfailed', (request) => {
    if (request.failure()?.errorText === refused) requests += 1;
  });
  page.on('console', (message) => {
    if (message.type() === 'error' && message.text().includes(refused)) consoles += 1;
  });
  // The clock is the browser's own here: the shell's countdown to the next try follows it.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/runs');
  const main = page.locator('main');
  await expect(main.locator('li[data-run]').first()).toBeVisible();
  await expect(headerCreate(page)).not.toHaveAttribute('aria-disabled', 'true');

  await page.route(HOST_REQUESTS, (route) => route.abort('connectionrefused'));
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));

  // The shell says it once, with the unreachable preset's words; the list stays on screen.
  const banner = page.getByRole('region', { name: 'Connection problem' });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('Can’t reach the Interborough server.');
  await expect(headerCreate(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(main.locator('li[data-run]').first()).toBeVisible();
  await expect(main.locator('li[data-run]').first()).toHaveCSS('opacity', '1');
  await expect(main.getByRole('radio', { name: /^All\s*,\s*20$/ })).toBeVisible();
  await captureForDesignReview(page, { route: '/runs', state: 'stale', source: SOURCE });
  // Reading controls stay live: a segment narrows the list.
  await main.getByRole('radio', { name: /^Failed\s*,\s*1$/ }).click();
  await expect(page).toHaveURL(/status=failed/);

  await page.unroute(HOST_REQUESTS);
  await expect(banner).toHaveCount(0);
  await expect(headerCreate(page)).not.toHaveAttribute('aria-disabled', 'true');

  const reason = 'the test took the page’s network away on purpose';
  if (requests > 0) {
    pageErrors.expect({
      pattern: new RegExp(`^request failed: .* \\(${refused}\\)$`),
      reason,
      count: requests,
    });
  }
  if (consoles > 0) {
    pageErrors.expect({
      pattern: new RegExp(`^console error: .*${refused}`),
      reason,
      count: consoles,
    });
  }
});
