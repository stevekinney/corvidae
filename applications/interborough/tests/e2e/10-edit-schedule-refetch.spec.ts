/**
 * COR-15 schedule edit flow against the seeded real Weft server: create a
 * schedule, open its edit page (the form that makes a schedule, COR-2018), change the
 * overlap policy, the catch-up choice and the name, force a
 * background refetch of the page's schedule query BEFORE saving, confirm
 * the in-progress edits survived it, save, and confirm they persisted.
 *
 * The forced refetch is a real one: dispatching `visibilitychange` on a
 * visible document is what TanStack Query's focus manager listens for, and
 * with the console's default zero `staleTime` it refetches every active
 * query, including the drawer's schedule detail query. A payload identical
 * to the cached one structurally shares to the same reference, so the
 * changed-server-data variant (another operator editing mid-way) is covered
 * at component level in `schedule-edit.test.ts`; this spec proves the
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
  request,
  checkA11y,
}) => {
  // The schedule is made under a fixed id, active-at-fire, no jitter: the new schedule page mints
  // the identifier, so this spec makes it through the host's REST API, as `schedules.spec.ts` does.
  const created = await request.post('/v1/schedules', {
    data: {
      type: 'order-processing',
      id: SCHEDULE_ID,
      cronExpression: '0 9 * * *',
      timeZone: 'UTC',
      input: {},
    },
  });
  expect(created.status(), 'creating the schedule').toBe(201);
  await page.goto(`/schedules/${SCHEDULE_ID}`);
  await expect(page).toHaveURL(/\/schedules\/[^/?]+$/);

  await page.getByRole('button', { name: 'Edit' }).click();
  const editor = page.locator('[data-page="schedule-edit"]');
  await expect(editor.getByRole('heading', { level: 1, name: /^Edit / })).toBeVisible();

  // The workflow is fixed, and the name, the cadence and the two policies are editable.
  await expect(editor.getByRole('combobox', { name: /^Workflow/ })).toBeDisabled();
  const overlap = editor.getByLabel('If a run is still going');
  const catchUp = editor.getByLabel('If Interborough was off');
  await expect(overlap).toBeEnabled();
  await expect(catchUp).toBeEnabled();
  await checkA11y('schedules — edit page');

  await editor.getByLabel(/^Name/).fill('Edited by the e2e flow');
  await expect(catchUp).toHaveValue('off');
  await catchUp.selectOption('on');
  await overlap.selectOption('allow');

  // Background refetch before saving.
  const detailRefetched = page.waitForResponse((response) =>
    /\/schedules\/e2e-edit-refetch-schedule/.test(response.url()),
  );
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange', { bubbles: true })));
  await detailRefetched;

  await expect(overlap).toHaveValue('allow');
  await expect(catchUp).toHaveValue('on');
  await expect(editor.getByLabel(/^Name/)).toHaveValue('Edited by the e2e flow');

  await editor.getByRole('button', { name: 'Save changes' }).click();
  await expect(page).toHaveURL(new RegExp(`/schedules/${SCHEDULE_ID}$`));

  // Persisted: the detail page reflects the policy it shows.
  await expect(
    page.getByText('Starts a fire even if the previous run is still going'),
  ).toBeVisible();
  await checkA11y('schedule detail — edited options persisted');

  // The detail page renders neither the name nor the catch-up choice, so reopen the edit page
  // (built from the server's copy) to prove both reached the server.
  await page.reload();
  await page.getByRole('button', { name: 'Edit' }).click();
  const reopened = page.locator('[data-page="schedule-edit"]');
  await expect(
    reopened.getByRole('heading', { level: 1, name: 'Edit Edited by the e2e flow' }),
  ).toBeVisible();
  await expect(reopened.getByLabel(/^Name/)).toHaveValue('Edited by the e2e flow');
  await expect(reopened.getByLabel('If Interborough was off')).toHaveValue('on');
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
      await expect(drawer.getByRole('heading', { level: 1, name: /^Edit / })).toBeVisible();
      await expect(drawer.getByLabel(/^Name/)).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
  }
});
