/**
 * The Checks page (`/checks`) on the sample world (`fixtures/sample-world-seed.ts`, the showcase
 * host) at the browser's sample clock, Monday, Nov 2, 10:46 AM Central time (COR-2114, design rows
 * C2-01 to C2-26): the list on a phone, a tablet and in the dark, with scorers and with a filter menu
 * open, and each state of it that is not a list of rows (first use, filtered to nothing, loading,
 * still loading, canceled, failing, a Load more that failed, and a server that stopped answering).
 * The sample world holds more than fifty results of every kind across Oct 29 and Oct 30 (the goals'
 * verdicts, the guardrails, a tripwire, three scorers and a flagged chat), so Load more is real. A
 * state the sample world does not hold is made by answering the Bureau's own `bureau.checks.list`
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
import { readBoxes } from './read-boxes.ts';

test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

const SOURCE = 'checks-states.spec.ts';
const WIDTHS = [1280, 375] as const;
/** Every request the page makes of the host, which a test takes away to make the server stop answering. */
const HOST_REQUESTS = /\/(v1|bureau|api)\/|\/jsonrpc$/;
/** The longest a check's name is let to be on a row: three hundred characters with no place to break. */
const LONG_NAME = `check-${'a'.repeat(294)}`;

/** The results the page lists, one per row. */
const rows = (page: Page) => page.locator('main li[data-check-kind]');
const filterBar = (page: Page) => page.getByRole('search', { name: 'Filter checks' });
/** Every primary button or link on the page, which a list page keeps to the one its state offers. */
const primaries = (page: Page) => page.locator('main .button-variant-primary');

/** Opens the page at `width` with the sample clock and waits until the results are listed. */
async function openChecks(page: Page, width = 1280, path = '/checks'): Promise<void> {
  await page.clock.setFixedTime(SAMPLE_NOW);
  await page.setViewportSize({ width, height: 900 });
  await page.goto(path);
  await expect(rows(page).nth(0)).toBeVisible();
}

/** Answers the Bureau operation `method` with `answer`, and leaves every other operation to the host. */
async function answerOperation(
  page: Page,
  method: string,
  answer: (route: Route, id: unknown, params: Record<string, unknown>) => Promise<void> | void,
): Promise<void> {
  await page.route('**/jsonrpc', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as {
      method?: string;
      id?: unknown;
      params?: Record<string, unknown>;
    };
    if (body.method === method) {
      await answer(route, body.id, body.params ?? {});
      return;
    }
    await route.fallback();
  });
}

/** One result as the operation answers it, in a goal's words unless the test says otherwise. */
function resultOf(index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'goal.attempt.validated',
    checkId: `check-number-${String(index)}@3`,
    agentName: 'tool-runner',
    outcome: 'pass',
    timestamp: new Date(SAMPLE_NOW_MILLISECONDS - index * 60_000).toISOString(),
    runId: `run-${String(index)}`,
    goalRunId: `goal-${String(index)}`,
    attemptId: `attempt-${String(index)}`,
    score: null,
    ...overrides,
  };
}

/** Answers every read of the results with `checks` and no next page. */
async function answerWith(page: Page, checks: readonly Record<string, unknown>[]): Promise<void> {
  await answerOperation(page, 'bureau.checks.list', (route, id) =>
    route.fulfill({ json: { jsonrpc: '2.0', id, result: { checks, nextCursor: null } } }),
  );
}

test.describe('the list (/checks) on a phone, a tablet, with scorers, a menu open and in the dark', () => {
  for (const width of [320, 375, 768, 1280, 1920]) {
    test(`COR-2736 check details and time fit at ${width}px`, async ({ page }) => {
      await openChecks(page, width);
      for (const row of await rows(page).all()) {
        const geometry = await row.evaluate((element) => {
          const title = element.querySelector('.ib-checks-row__name')!;
          const time = element.querySelector('.ib-checks-row__time')!;
          const meta = element.querySelector('.cinder-stacked-list-item__meta')!;
          const titleBox = title.getBoundingClientRect();
          const timeBox = time.getBoundingClientRect();
          const style = getComputedStyle(meta);
          const measure = document.createElement('div');
          measure.style.width = 'var(--cinder-space-6)';
          element.append(measure);
          const maxGap = measure.getBoundingClientRect().width;
          measure.remove();
          return {
            gap: timeBox.left - titleBox.right,
            maxGap,
            metaOverflow: meta.scrollWidth - meta.clientWidth,
            metaWhiteSpace: style.whiteSpace,
            timeOverflow: time.scrollWidth - time.clientWidth,
            sameLine: Math.abs(titleBox.top - timeBox.top),
          };
        });
        expect(geometry.metaWhiteSpace).toBe('normal');
        expect(geometry.metaOverflow).toBeLessThanOrEqual(1);
        expect(geometry.timeOverflow).toBeLessThanOrEqual(1);
        expect(geometry.sameLine).toBeLessThan(4);
        if (width >= 768) expect(geometry.gap).toBeLessThanOrEqual(geometry.maxGap);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    });
  }

  test('COR-2736 captures and selects each desktop facet', async ({ page }) => {
    for (const facet of ['Check', 'Outcome', 'Agent', 'Time']) {
      await openChecks(page, 1280);
      const trigger = filterBar(page).getByRole('button', { name: facet, exact: true });
      await trigger.click();
      const options = page.locator('.cinder-filter-bar__options label');
      await expect(options.first()).toBeVisible();
      await captureForDesignReview(page, {
        route: '/checks',
        state: `${facet} facet open`,
        source: SOURCE,
      });
      await options.first().click();
      const selected = filterBar(page).getByRole('button', { name: new RegExp(`^${facet}:`) });
      await expect(selected).toHaveAttribute('aria-expanded', 'true');
      await page.keyboard.press('Escape');
      await expect(selected).toHaveAttribute('aria-expanded', 'false');
      await expect(selected).toBeFocused();
    }
  });

  test('COR-2736 captures phone kind and filter controls', async ({ page }) => {
    await openChecks(page, 375);
    const kind = filterBar(page)
      .locator('.cinder-filter-bar__segments-select')
      .getByRole('combobox');
    const filter = filterBar(page).getByRole('button', { name: 'Filter' });
    const phoneBoxes = await readBoxes(page, { kind, filter });
    expect(Math.abs(phoneBoxes.kind.y - phoneBoxes.filter.y)).toBeLessThanOrEqual(1);
    await kind.click();
    await captureForDesignReview(page, {
      route: '/checks',
      state: 'kind selector open',
      source: SOURCE,
    });
    await page.getByRole('option', { name: 'Scorers', exact: true }).click();
    await expect(page).toHaveURL(/[?&]kind=scorer/);
    await captureForDesignReview(page, {
      route: '/checks',
      state: 'kind selected',
      source: SOURCE,
    });
    await filter.click();
    await expect(
      page.locator('.cinder-filter-bar__menu-row .cinder-filter-bar__menu-label'),
    ).toHaveText(['Check', 'Outcome', 'Agent', 'Time']);
    await captureForDesignReview(page, {
      route: '/checks',
      state: 'filter menu open',
      source: SOURCE,
    });
  });
  test('desktop content width contains checks and their timestamps', async ({ page }) => {
    await openChecks(page, 1920);
    const records = page.locator('.ib-records[data-page="checks"]');
    const { bounds, timestamp } = await readBoxes(page, {
      bounds: records,
      timestamp: rows(page).first().locator('time'),
    });
    const maximum = await records.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).maxInlineSize),
    );
    expect(bounds.width).toBeLessThanOrEqual(maximum);
    expect(timestamp.x + timestamp.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
    expect(maximum).toBe(1152);
  });
  test('on a phone is two-line rows under day bands, with a Kind select and a Filter button on one row (C2-04, C2-15)', async ({
    page,
    checkA11y,
  }) => {
    await openChecks(page, 375);
    const main = page.locator('main');
    await expect(main.getByRole('heading', { level: 1, name: 'Checks' })).toBeVisible();
    await expect(
      main.getByText('What every check decided about your agents’ work, newest first.'),
    ).toBeVisible();
    await expect(filterBar(page).locator('.cinder-filter-bar__segments-select')).toContainText(
      'Kind: All',
    );
    await expect(filterBar(page).getByRole('button', { name: 'Filter' })).toBeVisible();
    await expect(filterBar(page).getByRole('radio')).toHaveCount(0);
    for (const band of await main.locator('.cinder-data-list-group__header').all()) {
      await expect(band).toContainText('Central time');
    }
    const scrolls = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(scrolls, 'the page never scrolls sideways').toBe(false);
    await captureForDesignReview(page, { route: '/checks', state: 'ready', source: SOURCE });
    await checkA11y('checks on a phone');
  });

  test('on a tablet folds the segments into a Kind select and keeps the four chips on one row (C2-04)', async ({
    page,
    checkA11y,
  }) => {
    await openChecks(page, 768);
    const bar = filterBar(page);
    await expect(bar.locator('.cinder-filter-bar__segments-select')).toContainText('Kind: All');
    await expect(bar.getByRole('radio')).toHaveCount(0);
    for (const chip of ['Check', 'Outcome', 'Agent', 'Time']) {
      await expect(bar.getByRole('button', { name: chip, exact: true })).toBeVisible();
    }
    const boxes = await readBoxes(page, {
      kind: bar.locator('.cinder-filter-bar__segments-select'),
      check: bar.getByRole('button', { name: 'Check', exact: true }),
      outcome: bar.getByRole('button', { name: 'Outcome', exact: true }),
      agent: bar.getByRole('button', { name: 'Agent', exact: true }),
      time: bar.getByRole('button', { name: 'Time', exact: true }),
    });
    const tops = Object.values(boxes).map((box) => box.y);
    expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(1);
    await captureForDesignReview(page, { route: '/checks', state: 'ready', source: SOURCE });
    await checkA11y('checks on a tablet');
  });

  test('at full width is one bar on one row: the six Kind segments with no counts, the four chips, and no search (C2-03)', async ({
    page,
    checkA11y,
  }) => {
    await openChecks(page, 1280);
    const bar = filterBar(page);
    await expect(bar.getByRole('radio')).toHaveText([
      'All',
      'Goal checks',
      'Scorers',
      'Guardrails',
      'Tripwires',
      'Flagged sessions',
    ]);
    for (const chip of ['Check', 'Outcome', 'Agent', 'Time']) {
      await expect(bar.getByRole('button', { name: chip, exact: true })).toBeVisible();
    }
    await expect(bar.getByRole('searchbox')).toHaveCount(0);
    await expect(page.locator('main .cinder-page-header__create')).toHaveCount(0);
    await expect(
      page.locator('main').getByRole('link', { name: 'New goal', exact: true }),
    ).toHaveCount(0);
    await checkA11y('checks at full width');
  });

  test('filtered to Scorers lists each score as "score 0.82" in plain muted text, and no message (C2-09, C2-13)', async ({
    page,
    checkA11y,
  }) => {
    await openChecks(page, 1280, '/checks?kind=scorer');
    await expect(rows(page)).toHaveCount(3);
    // Each scored row is named by its check; the one that could not check has no score to list (C2-09).
    const scored = (title: string) => rows(page).filter({ hasText: title });
    await expect(scored('Politeness')).toContainText(/Scorer, .*score 0\.82, version 2/);
    await expect(scored('Accuracy')).toContainText(/Scorer, .*score 0\.31, version 1/);
    const unchecked = scored('Groundedness');
    await expect(unchecked).toContainText("Couldn't check");
    await expect(unchecked).toContainText('Scorer, Tool runner, version 1');
    await expect(unchecked).not.toContainText(/score \d/);
    await expect(
      filterBar(page).getByRole('radio', { name: 'Scorers', exact: true }),
    ).toHaveAttribute('aria-checked', 'true');
    await captureForDesignReview(page, {
      route: '/checks',
      state: 'ready (scores)',
      source: SOURCE,
    });
    await checkA11y('checks filtered to scorers');
  });

  test('on a phone, the Filter menu lists Check, Outcome, Agent and Time (C2-04)', async ({
    page,
    checkA11y,
  }) => {
    await openChecks(page, 375);
    await filterBar(page).getByRole('button', { name: 'Filter' }).click();
    await expect(
      page.locator('.cinder-filter-bar__menu-row .cinder-filter-bar__menu-label'),
    ).toHaveText(['Check', 'Outcome', 'Agent', 'Time']);
    await captureForDesignReview(page, {
      route: '/checks',
      state: 'filter menu open',
      source: SOURCE,
    });
    await checkA11y('checks with the filter menu open');
  });

  test('in the dark keeps every status word, the day bands and the rows legible (C2-25)', async ({
    page,
    checkA11y,
  }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await openChecks(page, 1280);
    await expect(page.locator('main .cinder-data-list-group__header').nth(0)).toContainText(
      'Central time',
    );
    await captureForDesignReview(page, { route: '/checks', state: 'ready (dark)', source: SOURCE });
    await checkA11y('checks in the dark');
  });

  test('a 300-character check name is cut at two lines, its line two at one, and the page never scrolls sideways (C2-16)', async ({
    page,
    checkA11y,
  }) => {
    await answerWith(page, [
      resultOf(0, { checkId: `${LONG_NAME}@3`, agentName: `agent-${'b'.repeat(120)}` }),
      resultOf(1, { kind: 'run.guardrail', checkId: LONG_NAME, outcome: 'block', goalRunId: null }),
    ]);
    await openChecks(page, 320);
    await expect(rows(page)).toHaveCount(2);
    const scrolls = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(scrolls, 'the page never scrolls sideways').toBe(false);
    const outlet = await page.locator('main.weft-shell-outlet').evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
    expect(outlet.scrollWidth).toBeLessThanOrEqual(outlet.clientWidth);
    await captureForDesignReview(page, { route: '/checks', state: 'long values', source: SOURCE });
    await checkA11y('checks with long values');
  });
});

test.describe('Load more (/checks)', () => {
  test('lists fifty results, then the next fifty under their bands, with no count and no repeated band (C2-17)', async ({
    page,
    checkA11y,
  }) => {
    await openChecks(page, 1280);
    await expect(rows(page)).toHaveCount(50);
    const more = page.locator('main').getByRole('button', { name: 'Load more' });
    await expect(more).toBeVisible();
    await expect(page.locator('main')).not.toContainText(/Showing \d/);
    await checkA11y('checks with Load more');

    await more.click();
    await expect.poll(() => rows(page).count()).toBeGreaterThan(50);
    await expect(more).toHaveCount(0);
    const bands = await page.locator('main .cinder-data-list-group__label').allTextContents();
    expect(new Set(bands).size, 'a band is never repeated').toBe(bands.length);
  });

  test('at 375 and 320, Load more is no taller than 36 pixels, with a hit area of at least 44 (C2-17)', async ({
    page,
  }) => {
    for (const width of [375, 320] as const) {
      await openChecks(page, width);
      const more = page.locator('main').getByRole('button', { name: 'Load more' });
      await more.scrollIntoViewIfNeeded();
      const box = await more.boundingBox();
      expect(box?.height ?? 99, `Load more at ${width}`).toBeLessThanOrEqual(36);
    }
  });

  test('a Load more that failed keeps every row and says so, and Try again reads the next page (C2-22)', async ({
    page,
    pageErrors,
    checkA11y,
  }) => {
    pageErrors.expectEvery({
      pattern: loggedFailedResponse(500, /\/jsonrpc/),
      reason: 'the test answers the second page of the checks with a 500',
    });
    let failing = true;
    await answerOperation(page, 'bureau.checks.list', async (route, _id, params) => {
      if (failing && typeof params['cursor'] === 'string') {
        await route.fulfill({ status: 500, json: { error: 'The server broke.' } });
        return;
      }
      await route.fallback();
    });
    await openChecks(page, 1280);
    await expect(rows(page)).toHaveCount(50);

    await page.locator('main').getByRole('button', { name: 'Load more' }).click();
    await expect(page.locator('main')).toContainText('Couldn’t load more checks.');
    await expect(rows(page)).toHaveCount(50);
    await expect(page.locator('main').getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(page.locator('main').getByRole('button', { name: 'Retry' })).toHaveCount(0);
    await captureForDesignReview(page, {
      route: '/checks',
      state: 'load more failed',
      source: SOURCE,
    });
    await checkA11y('checks with a Load more that failed');

    failing = false;
    await page.locator('main').getByRole('button', { name: 'Try again' }).click();
    await expect.poll(() => rows(page).count()).toBeGreaterThan(50);
  });
});

for (const width of WIDTHS) {
  test.describe(`the states of the list (/checks), at ${width} pixels`, () => {
    test('first use is "No checks yet" with the only primary New goal, and no filter bar (C2-18)', async ({
      page,
      checkA11y,
    }) => {
      await answerWith(page, []);
      await page.clock.setFixedTime(SAMPLE_NOW);
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/checks');
      const main = page.locator('main');

      await expect(main.getByRole('heading', { level: 1, name: 'Checks' })).toBeVisible();
      await expect(main.getByRole('heading', { level: 2, name: 'No checks yet' })).toBeVisible();
      await expect(main).toContainText(
        'Each time a goal’s check, a scorer or a guardrail decides something about a run, it’s listed here.',
      );
      await expect(filterBar(page)).toHaveCount(0);
      await expect(primaries(page)).toHaveCount(1);
      await expect(primaries(page)).toHaveText('New goal');
      const disc = main.locator('.cinder-empty-state-icon');
      await expect(disc).toHaveCount(1);
      await expect(disc.locator('svg')).toHaveCount(1);

      await captureForDesignReview(page, { route: '/checks', state: 'first use', source: SOURCE });
      await checkA11y(`checks first use at ${width}px`);

      await primaries(page).click();
      await expect(page).toHaveURL(/\/goals\/new$/);
    });

    test('filtered to nothing keeps the bar and the chip over a Clear filters state that leaves the filters (C2-19)', async ({
      page,
      checkA11y,
    }) => {
      await page.clock.setFixedTime(SAMPLE_NOW);
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/checks?kind=tripwire&agent=nobody-at-all');
      const main = page.locator('main');

      await expect(
        main.getByRole('heading', { level: 2, name: 'No checks match these filters' }),
      ).toBeVisible();
      await expect(main).toContainText('Change or clear the filters to see more checks.');
      await expect(filterBar(page)).toBeVisible();
      if (width >= 1024) {
        await expect(
          main.getByRole('button', { name: 'Agent: Nobody at all', exact: true }),
        ).toBeVisible();
      }
      const state = main.locator('.cinder-empty-state');
      await expect(state).toHaveAttribute('data-cinder-kind', 'filtered');
      await expect(state.getByRole('button')).toHaveCount(1);
      const clear = state.getByRole('button', { name: 'Clear filters' });
      await expect(clear).toContainClass('button-variant-secondary');
      await expect(primaries(page)).toHaveCount(0);

      await captureForDesignReview(page, {
        route: '/checks',
        state: 'filtered to nothing',
        source: SOURCE,
      });
      await checkA11y(`checks filtered to nothing at ${width}px`);

      await clear.click();
      await expect(page).toHaveURL(/\/checks$/);
      await expect(rows(page).nth(0)).toBeVisible();
    });

    test('failing is the full error state under the header, with Try again the only primary and Check Health beside it (C2-21)', async ({
      page,
      pageErrors,
      checkA11y,
    }) => {
      pageErrors.expectEvery({
        pattern: loggedFailedResponse(500, /\/jsonrpc/),
        reason: 'the test answers the checks list with a 500',
      });
      await answerOperation(page, 'bureau.checks.list', (route) =>
        route.fulfill({ status: 500, json: { error: 'The server broke.' } }),
      );
      await page.clock.setFixedTime(SAMPLE_NOW);
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/checks');
      const main = page.locator('main');

      await expect(
        main.getByRole('heading', { level: 2, name: 'Couldn’t load checks' }),
      ).toBeVisible();
      await expect(main.getByRole('heading', { level: 1, name: 'Checks' })).toBeVisible();
      await expect(main).toContainText(
        'The server answered with an error (500). Nothing you did caused it.',
      );
      await expect(rows(page)).toHaveCount(0);
      await expect(filterBar(page)).toHaveCount(0);
      await expect(primaries(page)).toHaveCount(1);
      await expect(primaries(page)).toHaveText('Try again');
      await expect(main.getByRole('link', { name: 'Check Health' })).toContainClass(
        'button-variant-secondary',
      );
      await expect(main.getByText('Show the error details')).toBeVisible();

      await captureForDesignReview(page, { route: '/checks', state: 'failing', source: SOURCE });
      await checkA11y(`checks failing at ${width}px`);

      // The server comes back, and Try again reads the results.
      await page.unroute('**/jsonrpc');
      await primaries(page).click();
      await expect(rows(page).nth(0)).toBeVisible();
    });
  });
}

test.describe('a read in progress (/checks) (C2-20)', () => {
  /** Holds every read of the checks until `release`, with the page's clock paused at the sample instant. */
  async function openLoading(page: Page, width: number): Promise<() => void> {
    await page.clock.install({ time: SAMPLE_NOW_MILLISECONDS - 1_000 });
    await page.clock.pauseAt(SAMPLE_NOW);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await answerOperation(page, 'bureau.checks.list', async (route) => {
      await gate;
      await route.fallback().catch(() => undefined);
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/checks');
    // The placeholders' timers start when the page mounts, so the clock is moved only after it has.
    await expect(
      page.locator('main').getByRole('heading', { level: 1, name: 'Checks' }),
    ).toBeVisible();
    return release;
  }

  for (const width of WIDTHS) {
    test(`shows nothing under the header for 300 ms, then the bar and five skeleton rows, at ${width} pixels`, async ({
      page,
      checkA11y,
    }) => {
      const release = await openLoading(page, width);
      const main = page.locator('main');
      await expect(main.locator('.cinder-skeleton-list')).toHaveCount(0);
      await expect(filterBar(page)).toHaveCount(0);

      await page.clock.runFor(300);
      await expect(main.locator('.cinder-skeleton-list')).toBeVisible();
      await expect(main.locator('.cinder-skeleton-day-band')).toHaveCount(1);
      await expect(main.locator('.cinder-skeleton-row')).toHaveCount(5);
      await expect(filterBar(page)).toBeVisible();
      await expect(rows(page)).toHaveCount(0);

      await captureForDesignReview(page, { route: '/checks', state: 'loading', source: SOURCE });
      // The accessibility check waits on animation frames, which a paused clock never runs.
      await page.clock.resume();
      await checkA11y(`checks loading at ${width}px`);
      release();
      await expect(rows(page).nth(0)).toBeVisible();
      await expect(main.locator('.cinder-skeleton-row')).toHaveCount(0);
    });
  }

  test('says it is taking longer than usual after 10 s, and Cancel leaves Loading canceled with Try again', async ({
    page,
    checkA11y,
  }) => {
    const release = await openLoading(page, 1280);
    const main = page.locator('main');
    await page.clock.runFor(300);
    await expect(main.locator('.cinder-skeleton-list')).toBeVisible();
    await expect(main).not.toContainText('Still loading checks.');

    await page.clock.runFor(10_000);
    await expect(main).toContainText('Still loading checks. This is taking longer than usual.');
    await captureForDesignReview(page, {
      route: '/checks',
      state: 'still loading',
      source: SOURCE,
    });

    await main.getByRole('button', { name: 'Cancel' }).click();
    await expect(main.getByRole('heading', { level: 2, name: 'Loading canceled' })).toBeVisible();
    await expect(main).toContainText(
      'Checks didn’t finish loading. Nothing is missing; it just wasn’t fetched.',
    );
    // The header and the bar stay; nothing that had data is blanked.
    await expect(main.getByRole('heading', { level: 1, name: 'Checks' })).toBeVisible();
    await expect(filterBar(page)).toBeVisible();
    await expect(main.locator('.cinder-skeleton-row')).toHaveCount(0);
    await expect(primaries(page)).toHaveCount(1);
    await expect(primaries(page)).toHaveText('Try again');
    await captureForDesignReview(page, {
      route: '/checks',
      state: 'loading canceled',
      source: SOURCE,
    });
    await page.clock.resume();
    await checkA11y('checks loading canceled');

    release();
    await primaries(page).click();
    await expect(rows(page).nth(0)).toBeVisible();
  });
});

test('a server that stops answering over the list keeps it at full contrast, and Load more shows its failed footer (C2-24)', async ({
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
  await page.goto('/checks');
  await expect(rows(page).nth(0)).toBeVisible();
  const loaded = await rows(page).count();

  await page.route(HOST_REQUESTS, (route) => route.abort('connectionrefused'));
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));

  // The shell says it once, with the unreachable preset's words; the list stays on screen.
  const banner = page.getByRole('region', { name: 'Connection problem' });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('Can’t reach the Interborough server.');
  await expect(rows(page)).toHaveCount(loaded);
  await expect(rows(page).nth(0)).toHaveCSS('opacity', '1');
  await captureForDesignReview(page, { route: '/checks', state: 'offline', source: SOURCE });

  // A row still opens its goal or run, and Load more shows its failed footer, keeping every row.
  await page.locator('main').getByRole('button', { name: 'Load more' }).click();
  await expect(page.locator('main')).toContainText('Couldn’t load more checks.');
  await expect(rows(page)).toHaveCount(loaded);

  await page.unroute(HOST_REQUESTS);
  await expect(banner).toHaveCount(0);

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

test.describe('the rows (C2-08, C2-10, C2-12, C2-14)', () => {
  test('each is one link to its goal or its run, states its outcome once in its word, and shows no raw id', async ({
    page,
  }) => {
    await openChecks(page, 1280);
    const first = rows(page).nth(0);
    await expect(first.locator('a[href]')).toHaveCount(1);
    await expect(first.locator('button')).toHaveCount(0);
    const text = (await page.locator('main').textContent()) ?? '';
    for (const raw of [
      'goal.attempt.validated',
      'run.guardrail',
      'run.tripwire',
      'scorer.recorded',
      'session.tainted',
    ]) {
      expect(text, raw).not.toContain(raw);
    }
    const hrefs = await rows(page).evaluateAll((items) =>
      items.map((item) => item.querySelector('a')?.getAttribute('href') ?? ''),
    );
    for (const href of hrefs) expect(href).toMatch(/^\/(goals|runs)\//);
  });

  test('a plain click on a goal’s verdict opens the goal in place (C2-14)', async ({ page }) => {
    // Only goal checks, so the row opens a goal page the sample world serves in full.
    await openChecks(page, 1280, '/checks?kind=goal');
    const link = rows(page).nth(0).locator('a[href]');
    const target = (await link.getAttribute('href')) ?? '';
    expect(target).toMatch(/^\/goals\/[^/]+$/);

    await link.click();

    await expect(page).toHaveURL(new RegExp(`${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
  });

  test('the Time chip offers Last hour, Last 24 hours, Last 7 days and Last 30 days, and a choice reaches the address (C2-05, C2-06)', async ({
    page,
  }) => {
    await openChecks(page, 1280);
    await filterBar(page).getByRole('button', { name: 'Time', exact: true }).click();
    const options = page.locator('.cinder-filter-bar__options label');
    await expect(options).toHaveText(['Last hour', 'Last 24 hours', 'Last 7 days', 'Last 30 days']);
    await options.filter({ hasText: 'Last 30 days' }).click();
    await expect(page).toHaveURL(/[?&]time=month/);
    await page.reload();
    await expect(
      filterBar(page).getByRole('button', { name: 'Time: Last 30 days', exact: true }),
    ).toBeVisible();
  });
});
