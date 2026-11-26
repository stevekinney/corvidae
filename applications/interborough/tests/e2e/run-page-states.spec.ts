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
import { readBoxes } from './read-boxes.ts';
import { openHowItRan, openTab } from './workflow-support.ts';

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

test('/runs/:run desktop content width keeps the failed alert and Details together', async ({
  page,
}) => {
  const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
  await openRun(page, `/runs/${encodeURIComponent(world.runs.failed)}`, 1920);
  const layout = page.locator('.ib-run__layout');
  const alert = page.getByTestId('run-step-failure');
  const rail = page.getByRole('complementary', { name: 'Details' });
  await expect(alert.locator('[data-explanation="summary"]')).toBeVisible();
  const { layoutBox, alertBox, railBox } = await readBoxes(page, {
    layoutBox: layout,
    alertBox: alert,
    railBox: rail,
  });
  const contentWidth = await layout.evaluate((element) =>
    parseFloat(getComputedStyle(element).maxInlineSize),
  );
  expect(layoutBox.width).toBeLessThanOrEqual(contentWidth + 1);
  expect(alertBox.x + alertBox.width).toBeLessThanOrEqual(railBox.x);
  expect(railBox.width).toBeCloseTo(320, 0);
  expect(railBox.x + railBox.width).toBeLessThanOrEqual(layoutBox.x + layoutBox.width + 1);
  const disclosure = alert.getByRole('button', { name: 'Show the error details' });
  await disclosure.click();
  await expect(alert.locator('[data-explanation="stack"]')).toBeVisible();
});

for (const width of WIDTHS) {
  // The route leads the title, so a design review's route filter (`--grep '/runs/:run'`) runs these.
  test.describe(`/runs/:run at ${String(width)} pixels`, () => {
    test('a failed instance says where it failed, shows the failure on its step, and the older version it ran (54y, 14t, 55b, 55d)', async ({
      page,
    }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      await openRun(page, `/runs/${encodeURIComponent(world.runs.failed)}`, width);

      const header = page.locator('[data-run-header]');
      await expect(header).toContainText(/Failed\s*, at step 2 of 4/);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Release notes');
      // The failure is told once, on the step, and no banner repeats it.
      // The step is named by its title on the version the run ran (14t), never by its message.
      await expect(page.getByTestId('run-step-failure')).toContainText(
        'Step 2, Collect merged changes, failed',
      );
      // Why it failed is the Bureau's explanation (COR-2533): its sentence leads, and what to do
      // next follows. The page words neither.
      await expect(
        page.getByTestId('run-step-failure').locator('[data-explanation="summary"]'),
      ).toContainText(/failed (because|for) /);
      await expect(page.getByTestId('run-step-failure')).toContainText('What to do next');
      // The words on which version each button runs on are the header's caption, under the
      // buttons, and the title keeps its line (54z).
      const beside = page.locator('[data-run-beside]');
      await expect(beside).toBeVisible();
      const { title, caption, retry } = await readBoxes(page, {
        title: page.getByRole('heading', { level: 1 }),
        caption: beside,
        retry: page.getByRole('button', { name: 'Retry from this step' }),
      });
      expect(caption.y).toBeGreaterThanOrEqual(retry.y + retry.height - 1);
      expect(caption.y).toBeGreaterThan(title.y);
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
      // The page as it opens: How it ran closed (54a, 54e), the rail's facts (54j).
      await expect(page.getByRole('button', { name: /^How it ran/ })).toHaveAttribute(
        'aria-expanded',
        'false',
      );
      await captureForDesignReview(page, {
        route: '/runs/:run',
        state: 'finished chat run',
        source: SOURCE,
      });
      const howItRan = await openHowItRan(page);
      // The Run inspector card is on How it ran's Inspector tab (row 54i), which a phone chooses
      // from the select the tab bar folds into.
      await openTab(howItRan, 'Inspector');
      await expect(page.locator('[data-section="run-inspector"]')).toContainText(
        'Finished; nothing left to do',
      );
      await captureForDesignReview(page, {
        route: '/runs/:run',
        state: 'finished chat run inspector',
        source: SOURCE,
      });
      // A Bureau run's Raw payloads (28e): its input and output cards, internals in JSON only.
      await openTab(howItRan, 'Raw payloads');
      await expect(page.locator('[data-section="raw-payloads"]')).toBeVisible();
      await captureForDesignReview(page, {
        route: '/runs/:run',
        state: 'raw payloads',
        source: SOURCE,
      });
    });

    test('a schedule’s run says its schedule and when it runs, offers Open schedule and Run again, and has no Tags row (55i, 55j, 55m)', async ({
      page,
      request,
    }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      const listed = await request.post(`${E2E_SHOWCASE_URL}/bureau/jsonrpc`, {
        data: {
          jsonrpc: '2.0',
          id: 'tasks',
          method: 'bureau.tasks.list',
          params: { origin: 'schedule', limit: 100 },
        },
      });
      const { result } = (await listed.json()) as {
        result: { tasks: Array<{ id: string; origin?: { scheduleId?: string } }> };
      };
      const fire = result.tasks.find(
        (task) => task.origin?.scheduleId === world.schedules.dailySummary,
      );
      expect(fire, 'the sample world holds a Daily summary run').toBeDefined();
      await openRun(page, `/runs/${encodeURIComponent(fire!.id)}`, width);

      await expect(page.getByRole('link', { name: 'Open schedule' })).toBeVisible();
      const lineage = page.getByTestId('run-lineage');
      await expect(lineage).toContainText('Daily summary');
      await expect(lineage).toContainText('every day at');
      const rail = page.getByRole('complementary', { name: 'Details' });
      await expect(rail.getByText('Tags', { exact: true })).toHaveCount(0);
      await captureForDesignReview(page, {
        route: '/runs/:run',
        state: 'schedule run',
        source: SOURCE,
      });
    });

    test('a goal’s canceled attempt has Open goal and no Run again, since the goal owns rerunning (55f)', async ({
      page,
    }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      await openRun(page, `/runs/${encodeURIComponent(world.runs.canceled)}`, width);

      await expect(page.getByRole('link', { name: 'Open goal' })).toBeVisible();
      // The header has Open goal and the menu only (55f); the attempt's session, which no Chats
      // list holds, is opened from the Details rail's Session row.
      const header = page.locator('[data-run-header]');
      await expect(header.getByRole('link', { name: 'Open the session' })).toHaveCount(0);
      const rail = page.getByRole('complementary', { name: 'Details' });
      await expect(rail.getByRole('link', { name: 'Open the session' })).toBeVisible();
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
