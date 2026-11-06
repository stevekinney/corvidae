/**
 * The Schedules list in the states that are not a list of rows (COR-2018, rows 70p–70w): nothing
 * scheduled yet, filters that match nothing, a read in progress, a read that failed with nothing to
 * show, and one that failed over rows already on screen. The page keeps its header in every one of
 * them (`ownsStates` in `src/app/views.ts`), so each is read at the header as well as the body. The
 * showcase host holds the sample world's four schedules, so a state that is not that world is drawn
 * by answering the engine's list (`/v1/schedules`) differently, which is also the probe the view
 * frame makes. The timings the placeholders keep (nothing for 300 ms, a status line at 10 s) are
 * proved with fake timers in `schedule-list-states.test.ts`, not slept here.
 */
import type { Page } from '@playwright/test';

import { SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, loggedFailedResponse, test } from './fixtures.ts';

test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

const SOURCE = 'schedules-states.spec.ts';
const WIDTHS = [1280, 375] as const;
const SCHEDULES_READ = /\/v1\/schedules(\?|$)/;
/** How Chromium words a failed answer for the list in the console, which ends the address with a line number. */
const SCHEDULES_LOGGED = /\/v1\/schedules/;
const HOST_REQUESTS = /\/(v1|bureau|api)\//;

const NOTHING = { items: [], total: 0 };

/** The engine lists no schedules, so the page has nothing to show. */
async function listNothing(page: Page): Promise<void> {
  await page.route(SCHEDULES_READ, (route) => route.fulfill({ json: NOTHING }));
}

/** The header's "+": a secondary icon button named for what it makes. */
const headerCreate = (page: Page) => page.locator('main .cinder-page-header__create');

/** Every primary button on the page, which a list page keeps to the one its state offers. */
const primaryButtons = (page: Page) => page.locator('main button[data-cinder-variant="primary"]');

for (const width of WIDTHS) {
  test(`nothing scheduled yet is the page, with no filter row and one primary New schedule, at ${width} pixels`, async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await listNothing(page);
    await page.goto('/schedules');
    const main = page.locator('main');

    await expect(main.getByRole('heading', { level: 1, name: 'Schedules' })).toBeVisible();
    await expect(main).toContainText('Runs that start on a timetable. Times are in Central time.');
    await expect(main.getByRole('heading', { level: 2, name: 'No schedules yet' })).toBeVisible();
    await expect(main).toContainText(
      'A schedule starts a chat or a workflow on a timetable, such as every weekday at 9:00 AM. Create one and its next runs show here.',
    );
    // The empty state is the page: no filter row, and no row.
    await expect(main.getByRole('toolbar', { name: 'Filter schedules' })).toHaveCount(0);
    await expect(main.locator('li[data-schedule]')).toHaveCount(0);

    // The header keeps its secondary "+", and the state's button is the only primary.
    await expect(headerCreate(page)).toBeVisible();
    await expect(headerCreate(page)).toHaveAccessibleName('New schedule');
    await expect(headerCreate(page)).toHaveAttribute('data-cinder-variant', 'secondary');
    await expect(primaryButtons(page)).toHaveCount(1);
    const create = primaryButtons(page).first();
    await expect(create).toHaveText('New schedule');
    // The disc is the accent tint of a first use, 48px, with a glyph in it.
    const disc = main.locator('.cinder-empty-state-icon');
    await expect(disc).toHaveCount(1);
    const box = await disc.boundingBox();
    expect(Math.round(box?.width ?? 0)).toBe(48);
    await expect(disc.locator('svg')).toHaveCount(1);

    await captureForDesignReview(page, { route: '/schedules', state: 'empty', source: SOURCE });
    await checkA11y(`schedules empty at ${width}px`);

    await create.click();
    await expect(page).toHaveURL(/\/schedules\/new$/);
  });
}

for (const width of WIDTHS) {
  test(`filtered to nothing keeps the filter bar and its counts over a Clear filters state, at ${width} pixels`, async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/schedules?status=paused&agent=tool-runner');
    const main = page.locator('main');

    await expect(
      main.getByRole('heading', { level: 2, name: 'No schedules match these filters' }),
    ).toBeVisible();
    await expect(main).toContainText(
      'Tool runner has no paused schedules. Try another status or agent.',
    );
    // The filter bar stays, with the counts of the one schedule Tool runner has.
    if (width >= 1024) {
      await expect(main.getByRole('radio', { name: /^All\s*,\s*1$/ })).toBeVisible();
      await expect(main.getByRole('radio', { name: /^Active\s*,\s*1$/ })).toBeVisible();
      const paused = main.getByRole('radio', { name: /^Paused\s*,\s*0$/ });
      await expect(paused).toBeChecked();
      await expect(main.getByRole('button', { name: /Missed runs/ })).toContainText('0');
      await expect(
        main.getByRole('button', { name: 'Agent: Tool runner', exact: true }),
      ).toBeVisible();
      await expect(main.getByRole('button', { name: /Workflow/ })).toBeVisible();
    }
    await expect(headerCreate(page)).toBeVisible();
    // The only action in the state is the secondary Clear filters, and nothing on the page is primary.
    const state = main.locator('.cinder-empty-state');
    await expect(state.getByRole('button')).toHaveCount(1);
    const clear = state.getByRole('button', { name: 'Clear filters' });
    await expect(clear).toHaveAttribute('data-cinder-variant', 'secondary');
    await expect(primaryButtons(page)).toHaveCount(0);
    // A neutral disc with a search glyph: the filtered kind, not the accent of a first use.
    await expect(state).toHaveAttribute('data-cinder-kind', 'filtered');

    await captureForDesignReview(page, { route: '/schedules', state: 'filtered', source: SOURCE });
    await checkA11y(`schedules filtered at ${width}px`);

    await clear.click();
    await expect(page).toHaveURL(/\/schedules$/);
    await expect(main.locator('li[data-schedule]')).toHaveCount(4);
  });
}

for (const width of WIDTHS) {
  test(`a read in progress shows the header, the filter bar without counts and four placeholder rows, at ${width} pixels`, async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(SCHEDULES_READ, async (route) => {
      await held;
      await route.fallback();
    });
    await page.goto('/schedules');
    const main = page.locator('main');

    // The header, its subtitle and the live "+" are real while the schedules load.
    await expect(main.getByRole('heading', { level: 1, name: 'Schedules' })).toBeVisible();
    await expect(main).toContainText('Runs that start on a timetable.');
    await expect(headerCreate(page)).toBeVisible();
    await expect(headerCreate(page)).not.toHaveAttribute('aria-disabled', 'true');

    // After 300 ms: four rows in the real layout, each with a dot, two bars and a time bar.
    const rows = main.locator('.cinder-skeleton-row');
    await expect(rows).toHaveCount(4);
    await expect(main.locator('.cinder-skeleton-status-bar[data-cinder-marker="dot"]')).toHaveCount(
      4,
    );
    await expect(main.locator('.cinder-skeleton-row .cinder-skeleton-time-bar')).toHaveCount(4);
    // The segments read All, Active and Paused with no number, and the chips stay.
    if (width >= 1024) {
      for (const label of ['All', 'Active', 'Paused']) {
        await expect(
          main.getByRole('radio', { name: new RegExp(`^${label}\\s*,\\s*loading$`) }),
        ).toBeVisible();
      }
      await expect(main.getByRole('button', { name: 'Missed runs' })).toBeVisible();
      await expect(main.getByRole('button', { name: /^Missed runs\s*\d/ })).toHaveCount(0);
      await expect(main.getByRole('button', { name: /Agent/ })).toBeVisible();
      await expect(main.getByRole('button', { name: /Workflow/ })).toBeVisible();
    }
    await expect(main.locator('li[data-schedule]')).toHaveCount(0);

    await captureForDesignReview(page, { route: '/schedules', state: 'loading', source: SOURCE });
    await checkA11y(`schedules loading at ${width}px`);

    release();
    await expect(main.locator('li[data-schedule]')).toHaveCount(4);
    await expect(rows).toHaveCount(0);
  });
}

for (const width of WIDTHS) {
  test(`a first load that failed is the error state under the header, with the header's "+" inert and no banner, at ${width} pixels`, async ({
    page,
    checkA11y,
    pageErrors,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    // An answer of 500 is asked again with a back-off before the read gives up, and the count of
    // asks follows the clock, so the status is what is declared.
    pageErrors.expectEvery({
      pattern: loggedFailedResponse(500, SCHEDULES_LOGGED),
      reason: 'the test answers the schedules list with a 500',
    });
    await page.route(SCHEDULES_READ, (route) =>
      route.fulfill({ status: 500, json: { error: 'The server broke.' } }),
    );
    await page.goto('/schedules');
    const main = page.locator('main');

    await expect(
      main.getByRole('heading', { level: 2, name: 'Couldn’t load schedules' }),
    ).toBeVisible();
    await expect(main.getByRole('heading', { level: 1, name: 'Schedules' })).toBeVisible();
    await expect(main).toContainText(
      'Interborough didn’t answer, so nothing changed. Schedules keep their timetable while Interborough is off, and missed runs are listed when it returns. New schedule is off until it answers.',
    );
    // The full state replaces the list: no rows, no filter bar, and no banner beside it.
    await expect(main.locator('li[data-schedule]')).toHaveCount(0);
    await expect(main.getByRole('toolbar', { name: 'Filter schedules' })).toHaveCount(0);
    await expect(main.getByRole('region', { name: /problem/ })).toHaveCount(0);
    // The state's Try again is the only primary, and the header's "+" is secondary and inert.
    await expect(primaryButtons(page)).toHaveCount(1);
    await expect(primaryButtons(page).first()).toHaveText('Try again');
    await expect(headerCreate(page)).toHaveAttribute('data-cinder-variant', 'secondary');
    await expect(headerCreate(page)).toHaveAttribute('aria-disabled', 'true');

    await captureForDesignReview(page, { route: '/schedules', state: 'error', source: SOURCE });
    await checkA11y(`schedules failed first load at ${width}px`);

    // The server comes back, and Try again reads the list.
    await page.unroute(SCHEDULES_READ);
    await primaryButtons(page).first().click();
    await expect(main.locator('li[data-schedule]')).toHaveCount(4);
    await expect(headerCreate(page)).not.toHaveAttribute('aria-disabled', 'true');
  });
}

for (const width of WIDTHS) {
  test(`a refresh that failed over rows on screen keeps them and says so in a banner under the header, at ${width} pixels`, async ({
    page,
    checkA11y,
    pageErrors,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    pageErrors.expectEvery({
      pattern: loggedFailedResponse(500, SCHEDULES_LOGGED),
      reason: 'the test answers the schedules list with a 500 once the page holds it',
    });
    await page.goto('/schedules');
    const main = page.locator('main');
    await expect(main.locator('li[data-schedule]')).toHaveCount(4);

    await page.route(SCHEDULES_READ, (route) =>
      route.fulfill({ status: 500, json: { error: 'The server broke.' } }),
    );
    // The person comes back to the tab, which reads the list again.
    await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
    // The shared unreachable preset with its countdown, under the header (row 70u).
    const banner = main.getByRole('region', { name: 'Connection problem' });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Can’t reach the Interborough server.');
    await expect(banner).toContainText('Showing what loaded as of');
    await expect(banner).toContainText(/Retrying in \d+ s \(attempt \d+ of \d+\)\./);
    await expect(banner.getByRole('button', { name: 'Retry now' })).toBeVisible();
    // No dismiss, and the rows stay.
    await expect(banner.getByRole('button', { name: /dismiss/i })).toHaveCount(0);
    await expect(main.locator('li[data-schedule]')).toHaveCount(4);
    // The banner sits under the header, above the filters and the rows.
    const header = await main.locator('.cinder-page-header').boundingBox();
    const bannerBox = await banner.boundingBox();
    expect(bannerBox?.y ?? 0).toBeGreaterThan(header?.y ?? 0);
    // The rows keep full contrast.
    await expect(main.locator('li[data-schedule]').first()).toHaveCSS('opacity', '1');

    await captureForDesignReview(page, {
      route: '/schedules',
      state: 'refresh-failed',
      source: SOURCE,
    });
    await checkA11y(`schedules failed refresh at ${width}px`);

    await page.unroute(SCHEDULES_READ);
    await banner.getByRole('button', { name: 'Retry now' }).click();
    await expect(banner).toHaveCount(0);
    await expect(main.locator('li[data-schedule]')).toHaveCount(4);
  });
}

test('a server that stops answering over rows on screen keeps them, holds the header "+", and leaves the filters live', async ({
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
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/schedules');
  const main = page.locator('main');
  await expect(main.locator('li[data-schedule]')).toHaveCount(4);
  await expect(headerCreate(page)).not.toHaveAttribute('aria-disabled', 'true');

  await page.route(HOST_REQUESTS, (route) => route.abort('connectionrefused'));
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));

  // The page says it once, under its header, with the unreachable preset's words; the shell leaves
  // its own to the page.
  const banner = main.getByRole('region', { name: 'Connection problem' });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('Can’t reach the Interborough server.');
  await expect(banner).toContainText('Showing what loaded as of');
  await expect(banner).toContainText('Changes are off until it’s back.');
  // The shared preset counts down to the next try and says which attempt it is (row 70u).
  await expect(banner).toContainText(/Retrying in \d+ s \(attempt \d+ of \d+\)\./);
  await expect(banner.getByRole('button', { name: 'Retry now' })).toBeVisible();
  await captureForDesignReview(page, { route: '/schedules', state: 'stale', source: SOURCE });
  await expect(page.getByRole('region', { name: 'Connection problem' })).toHaveCount(1);
  const header = await main.locator('.cinder-page-header').boundingBox();
  const bannerBox = await banner.boundingBox();
  expect(bannerBox?.y ?? 0).toBeGreaterThan(header?.y ?? 0);
  // The page keeps its rows at full contrast, and holds only the "+".
  await expect(main.getByRole('region', { name: 'Refresh problem' })).toHaveCount(0);
  await expect(main.locator('li[data-schedule]')).toHaveCount(4);
  await expect(headerCreate(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(main.getByRole('radio', { name: /^Paused/ })).toBeEnabled();
  await main.getByRole('radio', { name: /^Paused/ }).click();
  await expect(page).toHaveURL(/status=paused/);
  await expect(main.locator('li[data-schedule]').first()).toBeVisible();

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
