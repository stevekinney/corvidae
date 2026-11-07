/**
 * Persona flow (d): create-and-backfill-schedule (plan §11.4).
 *
 * schedules → New schedule → pick a workflow from the searchable picker → When: every day at 03:00
 * UTC → overlap policy → catch up → save → detail shows next fires and the engine's fields in its
 * details.
 *
 * Purely additive (creates one new schedule); safe anywhere in the run order relative to the other
 * flows.
 */
import { SCHEDULE_COPY } from '../../src/app/copy.ts';
import { expect, test } from './fixtures.ts';

test('operator creates a cron schedule with backfill and lands on its detail', async ({
  page,
  checkA11y,
}) => {
  await page.goto('/schedules');
  // See `01-debug-failed-workflow.spec.ts`'s module doc for why the first
  // axe check on every spec is gated behind real content, not the boot
  // skeleton `page.goto()`'s `load` event resolves under.
  await expect(page.getByRole('button', { name: 'New schedule' })).toBeVisible();
  await checkA11y('schedules list');

  await page.getByRole('button', { name: 'New schedule' }).click();
  await expect(page).toHaveURL(/\/schedules\/new$/);
  await expect(page.getByRole('heading', { level: 1, name: 'New schedule' })).toBeVisible();

  // The picker lists the built-in chat first and the workflows under All workflows; the workflow
  // chosen is named in words, and the schedule's name starts as that name.
  await page.getByRole('combobox', { name: /^Workflow/ }).click();
  await page.getByRole('option', { name: /Order processing/ }).click();
  await expect(page.getByLabel(/^Name/)).toHaveValue('Order processing');

  // ScheduleBuilder reads a schedule as Repeats, At and Time zone. "Every day" at 03:00
  // lowers to `0 3 * * *`; the zone is set explicitly so the cron the detail page shows
  // does not depend on the browser's zone.
  await page.getByLabel('Repeats', { exact: true }).selectOption('daily');
  await page.getByLabel('At', { exact: true }).fill('3:00 AM');
  await page.getByRole('combobox', { name: /^Time zone/ }).click();
  await page.getByPlaceholder('Search time zones').fill('UTC');
  await page.getByRole('option', { name: /^UTC/ }).first().click();
  await expect(page.getByText('Every day at 3:00 AM UTC').first()).toBeVisible();

  // The two policy selects: skip a run that is due while one is going, and catch up on what the
  // host missed while it was off.
  await page.getByLabel('If a run is still going').selectOption('skip');
  await page.getByLabel(SCHEDULE_COPY.create.catchUpLabel).selectOption('on');
  await checkA11y('schedules — new schedule page (workflow chosen)');

  await page.getByRole('button', { name: 'Create schedule' }).click();

  await expect(page).toHaveURL(/\/schedules\/[^/?]+$/);
  // The page is named by what it starts, not by the identifier the engine made.
  await expect(page.getByRole('heading', { level: 1, name: 'Order processing' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Runs' })).toBeVisible();
  await expect(page.getByText('No upcoming runs while the schedule is paused.')).toHaveCount(0);
  await expect(
    page.getByTestId('schedule-runs').locator('li[data-cinder-tone="pending"]'),
  ).toHaveCount(3);
  // The schedule's own fields are in the details beside the runs, with the cron it was made with.
  const details = page.getByTestId('schedule-details');
  await expect(details.getByTestId('schedule-revision')).toHaveText('Latest');
  await expect(details.getByTestId('schedule-catch-up')).toHaveText('Catch up on missed runs');
  await checkA11y('schedule detail — next fires populated');
});
