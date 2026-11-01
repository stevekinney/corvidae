/**
 * COR-15 schedule edit flow against the seeded real Weft server: create a
 * schedule, open its edit page, change `revisionPolicy` (plus the
 * newly-editable overlap policy, jitter, backfill, and description), force a
 * background refetch of the page's schedule query BEFORE saving, confirm
 * the in-progress edits survived it, save, and confirm they persisted.
 *
 * The forced refetch is a real one: dispatching `visibilitychange` on a
 * visible document is what TanStack Query's focus manager listens for, and
 * with the console's default zero `staleTime` it refetches every active
 * query, including the drawer's schedule detail query. A payload identical
 * to the cached one structurally shares to the same reference, so the
 * changed-server-data variant (another operator editing mid-way) is covered
 * at component level in `schedule-form-drawer.test.ts`; this spec proves the
 * whole flow in a real browser.
 *
 * The second test reuses the schedule the first one creates (the suite runs
 * with one worker, in file order).
 *
 * Purely additive (creates one new schedule with a fixed id); safe anywhere
 * in the run order relative to the other flows.
 */
import { expect, test } from './fixtures.ts';

const SCHEDULE_ID = 'e2e-edit-refetch-schedule';

test('operator edits a schedule across a background refetch and the unsaved changes persist on save', async ({
  page,
  checkA11y,
}) => {
  await page.goto('/schedules');
  await expect(page.getByRole('button', { name: 'New schedule' })).toBeVisible();

  // Create the schedule under a fixed id, active-at-fire, no jitter. A code-defined workflow is
  // under "Advanced", because a new schedule runs an agent.
  await page.getByRole('button', { name: 'New schedule' }).click();
  const createDrawer = page.getByRole('dialog', { name: 'Create schedule' });
  await expect(createDrawer).toBeVisible();
  await createDrawer
    .getByRole('button', { name: 'Advanced: start a code-defined workflow' })
    .click();
  await createDrawer.getByLabel('Schedule ID').fill(SCHEDULE_ID);
  await createDrawer
    .getByRole('combobox', { name: 'Workflow type' })
    .selectOption('order-processing');
  await createDrawer.getByRole('button', { name: 'Create schedule' }).click();
  await expect(createDrawer).not.toBeVisible();
  await expect(page).toHaveURL(/\/schedules\/[^/?]+$/);

  await page.getByRole('button', { name: 'Edit' }).click();
  const drawer = page.locator('[data-page="schedule-edit"]');
  await expect(drawer.getByRole('heading', { level: 1, name: 'Edit schedule' })).toBeVisible();

  // The formerly create-only options are editable now.
  const overlap = drawer.getByRole('group', {
    name: 'If a run is still going when the next fire is due',
  });
  await expect(overlap.getByRole('radio', { name: /Queue/i })).toBeEnabled();
  await expect(drawer.getByLabel('Jitter')).toBeEnabled();
  await expect(drawer.getByRole('switch', { name: 'Backfill missed occurrences' })).toBeEnabled();
  await checkA11y('schedules — edit slide-over (all options editable)');

  await drawer.getByLabel('Description').fill('Edited by the e2e flow');
  const backfill = drawer.getByRole('switch', { name: 'Backfill missed occurrences' });
  await expect(backfill).not.toBeChecked();
  await backfill.click();
  await overlap.getByRole('radio', { name: /Queue/i }).click();
  await drawer.getByLabel('Jitter').fill('30s');
  await drawer
    .getByRole('group', { name: 'Which revision future occurrences resolve against' })
    .getByRole('radio', { name: 'Pinned' })
    .click();

  // Background refetch before saving.
  const detailRefetched = page.waitForResponse((response) =>
    /\/schedules\/e2e-edit-refetch-schedule/.test(response.url()),
  );
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange', { bubbles: true })));
  await detailRefetched;

  await expect(
    drawer
      .getByRole('group', { name: 'Which revision future occurrences resolve against' })
      .getByRole('radio', { name: 'Pinned' }),
  ).toBeChecked();
  await expect(overlap.getByRole('radio', { name: /Queue/i })).toBeChecked();
  await expect(drawer.getByLabel('Jitter')).toHaveValue('30s');
  await expect(drawer.getByLabel('Description')).toHaveValue('Edited by the e2e flow');
  await expect(backfill).toBeChecked();

  await drawer.getByRole('button', { name: 'Save changes' }).click();
  await expect(page).toHaveURL(new RegExp(`/schedules/${SCHEDULE_ID}$`));

  // Persisted: the detail page reflects every saved change in its details.
  await expect(page.getByText('Queues a fire if the previous run is still going')).toBeVisible();
  await expect(page.getByText(/^Pinned \(/)).toBeVisible();
  await expect(page.getByText('±30000ms')).toBeVisible();
  await expect(page.getByText('Runs the fires it missed')).toBeVisible();
  await checkA11y('schedule detail — edited options persisted');

  // The detail page renders neither description nor backfill, so reopen the
  // drawer (rebuilt from the server's copy) to prove both reached the server.
  await page.reload();
  await page.getByRole('button', { name: 'Edit' }).click();
  const reopened = page.locator('[data-page="schedule-edit"]');
  await expect(reopened.getByRole('heading', { level: 1, name: 'Edit schedule' })).toBeVisible();
  await expect(reopened.getByLabel('Description')).toHaveValue('Edited by the e2e flow');
  await expect(reopened.getByRole('switch', { name: 'Backfill missed occurrences' })).toBeChecked();
  await expect(reopened.getByLabel('Jitter')).toHaveValue('30000ms');
});

test('the schedule edit page is usable across supported widths and themes', async ({ page }) => {
  for (const theme of ['light', 'dark'] as const) {
    for (const viewport of [
      { width: 375, height: 812 },
      { width: 768, height: 1024 },
      { width: 1280, height: 800 },
    ]) {
      await page.setViewportSize(viewport);
      await page.addInitScript((selectedTheme) => {
        localStorage.setItem('weft-ui-theme', selectedTheme);
      }, theme);
      await page.goto(`/schedules/${SCHEDULE_ID}/edit`);

      const drawer = page.locator('[data-page="schedule-edit"]');
      await expect(drawer.getByRole('heading', { level: 1, name: 'Edit schedule' })).toBeVisible();
      await expect(drawer.getByLabel('Description')).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
  }
});
