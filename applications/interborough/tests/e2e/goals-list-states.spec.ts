/**
 * The Goals list (`/goals`) while the goals are read (COR-2425, row 68k), captured for the design
 * review on a desktop and a phone: the sample world's own list with `bureau.goals.list` held, so
 * the page's header is real, the filter bar shows the "Status: All" select and the Agent chip
 * without counts, and skeleton rows in the real layout follow, each with a placeholder for its
 * attempts bar. Nothing is drawn for the first 300 ms, so the capture waits for the skeleton, and
 * re-proves it after the capture's own resize to 320 pixels.
 *
 * Not run on this host (the browser suites run on GitHub, `main.yml`).
 */
import type { Page, Route } from '@playwright/test';

import { SAMPLE_NOW, SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import { GOALS_COPY } from '../../src/app/copy/goals.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

const SOURCE = 'goals-list-states.spec.ts';
const WIDTHS = [1280, 375] as const;

/** Holds every `bureau.goals.list` call until the returned function is called. */
async function holdGoalsList(page: Page): Promise<() => void> {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/bureau/jsonrpc', async (route: Route) => {
    if ((route.request().postData() ?? '').includes('"bureau.goals.list"')) await held;
    await route.fallback();
  });
  return release;
}

/** The placeholders are drawn: three skeleton rows, each with its attempts bar (row 68k). */
async function skeletonDrawn(page: Page): Promise<void> {
  const main = page.locator('main');
  await expect(main.getByTestId('goal-loading-row')).toHaveCount(3);
  await expect(main.getByTestId('goal-loading-attempts').first()).toBeVisible();
}

for (const width of WIDTHS) {
  // The route leads the title, so a design review's route filter (`--grep '/goals'`) runs these.
  test.describe(`/goals at ${String(width)} pixels`, () => {
    test('while the goals are read, the header is real and skeleton rows hold the real layout (68k)', async ({
      page,
    }) => {
      await page.clock.setFixedTime(SAMPLE_NOW);
      await page.setViewportSize({ width, height: 900 });
      const release = await holdGoalsList(page);
      await page.goto('/goals');
      const main = page.locator('main');

      await expect(main.getByRole('heading', { level: 1, name: 'Goals' })).toBeVisible();
      await expect(main).toContainText(GOALS_COPY.subtitle);
      // Nothing is drawn for the first 300 ms: the capture waits for the skeleton itself.
      await skeletonDrawn(page);
      await expect(main.locator('[data-goal]')).toHaveCount(0);

      await captureForDesignReview(page, {
        route: '/goals',
        state: 'loading',
        source: SOURCE,
        ready: skeletonDrawn,
      });

      release();
      await expect(main.getByTestId('goal-loading-row')).toHaveCount(0);
    });
  });
}
