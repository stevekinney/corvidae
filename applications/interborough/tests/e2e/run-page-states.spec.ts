/**
 * The run page (`/runs/:run`) on the sample world (`fixtures/sample-world-seed.ts`, the showcase
 * host) at the browser's sample clock, Monday, Nov 2, 10:46 AM Central time (COR-2424, design rows
 * 54a to 55m and 06d): the runs the sample world holds in each state, captured for the design review
 * on a desktop and a phone. The failed Release notes run says where it failed ("at step 2 of 4"),
 * shows its failure on the step that failed and the version it ran as older than the current one;
 * the refund run waits on the person; a goal's canceled attempt has no Run again, because the goal
 * owns rerunning; and a finished chat run holds Run again, since no provider is connected, with a link
 * to connect one beneath it.
 *
 * The runs the design names by identifier (`run-8f3c2a` and the others) are the sample world's own
 * runs, whose identifiers the Bureau assigns; they are read from the host
 * (`readSampleWorldRecords`). A state the sample world does not hold, a live run and a run waiting
 * on a signal, is covered where the page is built from a table (`run-detail-engine.test.ts`).
 */
import type { Page } from '@playwright/test';

import { SAMPLE_NOW, SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import { readSampleWorldRecords } from '../../fixtures/sample-world-records.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

const SOURCE = 'run-page-states.spec.ts';
const WIDTHS = [1280, 375] as const;

/** Opens `path` at `width` and waits until the run's header says its status. */
async function openRun(page: Page, path: string, width: number): Promise<void> {
  await page.clock.setFixedTime(SAMPLE_NOW);
  await page.setViewportSize({ width, height: 900 });
  await page.goto(path);
  await expect(page.locator('[data-run-header] [data-status-word]')).toBeVisible();
}

for (const width of WIDTHS) {
  test.describe(`at ${String(width)} pixels`, () => {
    test('a failed instance says where it failed, shows the failure on its step, and the older version it ran (54y, 14t, 55b, 55d)', async ({
      page,
    }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      await openRun(page, `/runs/${encodeURIComponent(world.runs.failed)}`, width);

      const header = page.locator('[data-run-header]');
      await expect(header).toContainText(/Failed\s*, at step 2 of 4/);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Release notes');
      // The failure is told once, on the step, and no banner repeats it.
      await expect(page.getByTestId('run-step-failure')).toContainText('Step 2');
      await expect(page.getByTestId('run-step-failure')).toContainText('Why it failed');
      await expect(page.locator('.weft-overview-tab__failure')).toHaveCount(1);
      await expect(page.locator('[data-version-state="older"]')).toBeVisible();
      await captureForDesignReview(page, {
        route: '/runs/:run',
        state: 'failed instance',
        source: SOURCE,
      });
    });

    test('a run waiting on the person leads with what the person can do (06d)', async ({
      page,
    }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      await openRun(page, `/runs/${encodeURIComponent(world.runs.waiting)}`, width);

      await expect(page.locator('[data-run-header]')).toContainText('Waiting on you');
      await expect(page.locator('[data-section]').first()).toHaveAttribute(
        'data-section',
        'waiting',
      );
      await captureForDesignReview(page, {
        route: '/runs/:run',
        state: 'waiting on you',
        source: SOURCE,
      });
    });

    test('a finished chat run offers Open chat and Run again, and the Run inspector says nothing is left to do (54e, 54i)', async ({
      page,
    }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      await openRun(page, `/runs/${encodeURIComponent(world.runs.done)}`, width);

      await expect(page.locator('[data-run-header]')).toContainText('Done');
      await expect(page.getByRole('link', { name: 'Open chat' })).toBeVisible();
      // The sample world has no provider connected and Tool runner needs a model, so Run again is
      // held, with the link to Settings › Models beneath it that says why (54f).
      const again = page.getByRole('button', { name: 'Run again' });
      await expect(again).toHaveAttribute('aria-disabled', 'true');
      const connect = page.getByRole('link', { name: 'Connect a provider' });
      await expect(connect).toHaveAttribute('href', '/settings/models');
      await expect(again).toHaveAttribute(
        'aria-describedby',
        (await connect.getAttribute('id')) ?? '',
      );
      await page.getByRole('button', { name: /^How it ran/ }).click();
      // The Run inspector card is on How it ran's Inspector tab (row 54i).
      await page.getByRole('tab', { name: 'Inspector' }).click();
      await expect(page.locator('[data-section="run-inspector"]')).toContainText(
        'Finished; nothing left to do',
      );
      await captureForDesignReview(page, {
        route: '/runs/:run',
        state: 'finished chat run',
        source: SOURCE,
      });
    });

    test('a goal’s canceled attempt has Open goal and no Run again, since the goal owns rerunning (55f)', async ({
      page,
    }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      await openRun(page, `/runs/${encodeURIComponent(world.runs.canceled)}`, width);

      await expect(page.getByRole('link', { name: 'Open goal' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Run again' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Run again' })).toHaveCount(0);
      await captureForDesignReview(page, {
        route: '/runs/:run',
        state: 'canceled goal attempt',
        source: SOURCE,
      });
    });
  });
}
