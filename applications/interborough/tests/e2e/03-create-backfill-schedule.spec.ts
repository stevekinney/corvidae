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

  // The picker lists the built-in chat first and the workflows code defines under All workflows;
  // a search narrows it, and the workflow chosen is named in words with its description.
  await page.getByRole('combobox', { name: /^Workflow/ }).fill('order');
  await page.getByRole('option', { name: /Order Processing/ }).click();
  await expect(page.getByTestId('new-schedule-workflow-description')).toBeVisible();

  // ScheduleBuilder reads a schedule as Repeats, At and Time zone. "Every day" at 03:00
  // lowers to `0 3 * * *`; the zone is set explicitly so the cron the detail page shows
  // does not depend on the browser's zone.
  await page.getByLabel('Repeats', { exact: true }).selectOption('daily');
  await page.getByLabel('At', { exact: true }).fill('03:00');
  const timeZoneField = page.getByRole('combobox', { name: 'Time zone' });
  await timeZoneField.fill('UTC');
  await page.getByRole('option', { name: 'UTC', exact: true }).click();
  await expect(page.getByText('Every day at 3:00 AM UTC').first()).toBeVisible();

  // `RadioGroup` renders a native `<fieldset>` (implicit `role="group"`,
  // legend as the accessible name) — distinct from `SegmentedControl`'s
  // `role="radiogroup"` used for the overall/section review decisions in
  // `02-approve-review-partial.spec.ts`.
  await page
    .getByRole('group', { name: 'If a run is still going when the next one is due' })
    .getByRole('radio', { name: /Skip/i })
    .click();

  await page.getByRole('switch', { name: SCHEDULE_COPY.create.catchUpLabel }).click();
  await checkA11y('schedules — new schedule page (workflow chosen)');

  await page.getByRole('button', { name: 'Create schedule' }).click();

  await expect(page).toHaveURL(/\/schedules\/[^/?]+$/);
  // The page is named by what it starts, not by the identifier the engine made.
  await expect(
    page.getByRole('heading', { level: 1, name: 'Schedule for order-processing' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Next runs' })).toBeVisible();
  await expect(page.getByText('Nothing is coming up')).toHaveCount(0);
  await expect(page.getByTestId('schedule-next-fires').locator('li')).toHaveCount(5);
  // The schedule's own fields are in the details beside the runs, with the cron it was made with.
  const rail = page.getByTestId('schedule-rail');
  await expect(rail.getByText('Workflow version', { exact: true })).toBeVisible();
  await expect(rail.getByText('Runs the fires it missed')).toBeVisible();
  await checkA11y('schedule detail — next fires populated');
});
