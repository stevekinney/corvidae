/**
 * Persona flow (d): create-and-backfill-schedule (plan §11.4).
 *
 * schedules → create slide-over → "Advanced: start a code-defined workflow" → ScheduleBuilder
 * every day at 03:00 UTC → overlap policy → backfill warning → save → detail shows next fires,
 * and keeps the engine's fields behind its Advanced disclosure.
 *
 * Purely additive (creates one new schedule); safe anywhere in the run
 * order relative to the other flows.
 */
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
  const drawer = page.getByRole('dialog', { name: 'Create schedule' });
  await expect(drawer).toBeVisible();
  // A new schedule runs an agent, so a code-defined workflow is under "Advanced".
  await expect(drawer.getByRole('combobox', { name: 'Workflow type' })).toHaveCount(0);
  await drawer.getByRole('button', { name: 'Advanced: start a code-defined workflow' }).click();

  // The "Workflow type" field starts as a free-text `Input` and swaps to a
  // registry-backed `Select` once `weft.system.registry` resolves
  // (`schedule-form-fields.svelte`'s `workflowTypeOptions !== undefined`
  // branch) — wait for the real combobox rather than racing that swap.
  const workflowTypeField = drawer.getByRole('combobox', { name: 'Workflow type' });
  await expect(workflowTypeField).toBeVisible();
  await workflowTypeField.selectOption('order-processing');

  // ScheduleBuilder reads a schedule as Repeats, At and Time zone. "Every day" at 03:00
  // lowers to `0 3 * * *`; the zone is set explicitly so the cron the detail page shows
  // does not depend on the browser's zone.
  await drawer.getByLabel('Repeats', { exact: true }).selectOption('daily');
  await drawer.getByLabel('At', { exact: true }).fill('03:00');
  const timeZoneField = drawer.getByRole('combobox', { name: 'Time zone' });
  await timeZoneField.fill('UTC');
  await page.getByRole('option', { name: 'UTC', exact: true }).click();
  await expect(drawer.getByText('Every day at 3:00 AM UTC')).toBeVisible();

  // `RadioGroup` renders a native `<fieldset>` (implicit `role="group"`,
  // legend as the accessible name) — distinct from `SegmentedControl`'s
  // `role="radiogroup"` used for the overall/section review decisions in
  // `02-approve-review-partial.spec.ts`.
  await drawer
    .getByRole('group', { name: 'If a run is still going when the next fire is due' })
    .getByRole('radio', { name: /Skip/i })
    .click();

  const backfillToggle = drawer.getByRole('switch', { name: 'Backfill missed occurrences' });
  await backfillToggle.click();
  await expect(
    drawer.getByText(
      'If the schedule falls behind (for example, the engine was down), missed occurrences fire immediately in a bounded catch-up window instead of being skipped.',
    ),
  ).toBeVisible();
  await checkA11y('schedules — create slide-over (backfill warning shown)');

  await drawer.getByRole('button', { name: 'Create schedule' }).click();
  await expect(drawer).not.toBeVisible();

  await expect(page).toHaveURL(/\/schedules\/[^/?]+$/);
  // The page is named by what it starts, not by the identifier the engine made.
  await expect(
    page.getByRole('heading', { level: 1, name: 'Schedule for order-processing' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Next fires' })).toBeVisible();
  await expect(page.getByText('Not scheduled')).toHaveCount(0);
  await expect(page.getByTestId('schedule-next-fires').locator('li')).toHaveCount(5);
  // The engine's own fields are there only once the disclosure opens.
  await expect(page.getByText('Revision policy', { exact: true })).toHaveCount(0);
  await page.getByRole('main').getByRole('button', { name: 'Advanced' }).click();
  await expect(page.getByText('Revision policy', { exact: true })).toBeVisible();
  await expect(page.getByText('0 3 * * *')).toBeVisible();
  await checkA11y('schedule detail — next fires populated');
});
