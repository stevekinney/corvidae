/**
 * Primary WFT-117 operator flow against the seeded real Weft server:
 *
 * workflows list (filtered to `order-processing`, the eagerly-registered
 * seed type) → detail header shows the persisted revision AND its "matches
 * active" comparison → Checkpoints tab → select a checkpoint → Fork panel
 * shows "Retains rev X" → open the "Fork a different revision" picker →
 * pick the fixture's deliberately-never-eagerly-registered candidate
 * (`fixtures/workflow-revisions.ts`'s `ORDER_PROCESSING_CANDIDATE_REVISION`)
 * → submit → a REAL rejected `WorkflowRevisionUnavailableError` Conflict
 * renders the picker's own framing (mirrors `07-activate-workflow-revision.
 * spec.ts`'s real-refusal pattern, not a mocked one). A separate schedule
 * created via the wizard with `revisionPolicy: 'pinned'` shows "Pinned
 * (rev X)" on its own detail page.
 *
 * Explicitly does NOT attempt: a successful (non-Conflict) explicit-
 * revision fork, or a live "persisted revision differs from active" detail
 * state — both are structurally unreachable against this seeded server (the
 * candidate fixture is never eagerly registered in-process, and activating
 * a genuinely different revision is refused under the default
 * `requireExactRevision` policy) — see `checkpoints/fork-dialog.test.ts`
 * and `header.test.ts` for the component-level coverage of those states
 * instead.
 *
 * Purely additive apart from the fork attempt itself (which the server
 * refuses, so no new workflow or catalog mutation survives it) and one new
 * schedule — safe anywhere in the run order relative to the other flows.
 */
import { SCHEDULE_COPY } from '../../src/app/copy.ts';
import { expect, loggedFailedResponse, test } from './fixtures.ts';

test('operator inspects revision bindings, attempts a rejected explicit-revision fork, and pins a schedule', async ({
  page,
  checkA11y,
  pageErrors,
}) => {
  await page.goto('/workflows/order-processing/runs');
  // See `01-debug-failed-workflow.spec.ts`'s module doc for why the first
  // axe check on every spec is gated behind real content.
  await expect(page.getByRole('table', { name: 'Workflows' })).toBeVisible();

  await expect(page.getByRole('columnheader', { name: 'Revision' })).toBeVisible();
  const orderRow = page.getByRole('row', { name: /order-processing/ }).first();
  await expect(orderRow).toBeVisible();
  // The list's own Revision column (WFT-117) — a truncated `rev …` id or an
  // explicit "Unpinned" badge, never a blank cell. `Table.HeaderCell` order
  // is Status/Workflow ID (a `<th scope="row">` — role "rowheader", not
  // "cell")/Type/Revision/Tags/Created/Updated, so among plain `<td>` cells
  // (role "cell") Revision is index 2 (Status=0, Type=1).
  const revisionCell = orderRow.getByRole('cell').nth(2);
  await expect(revisionCell).not.toBeEmpty();
  await checkA11y('workflow list — filtered to order-processing, Revision column visible');

  await orderRow.getByRole('link').click();
  await expect(page.getByRole('heading', { level: 1, name: 'order-processing' })).toBeVisible();

  // The Details rail's Revision row, with the active comparison beside it (WFT-117). The seeded
  // server never activates the candidate fixture, so the original,
  // eagerly-registered revision stays active — this run's own persisted
  // revision matches it. (The run page has no header badge since it became one page.)
  await expect(
    page.getByRole('complementary', { name: 'Details' }).getByText(/ — active$/),
  ).toBeVisible();
  await checkA11y('run — Details rail (revision + active comparison)');

  await page.getByRole('button', { name: 'Checkpoints' }).click();
  const checkpointList = page.locator('.weft-checkpoints-tab__list');
  await expect(checkpointList).toBeVisible();
  await checkpointList.locator('.weft-checkpoints-tab__row').first().click();

  await page.getByRole('radio', { name: 'Fork' }).click();
  await expect(page.getByText(/^Retains rev /)).toBeVisible();
  await checkA11y('workflow detail — checkpoints, Fork panel (default retention line)');

  await page.getByRole('button', { name: 'Fork a different revision' }).click();
  const revisionSelect = page.getByRole('combobox', { name: 'Revision' });
  await expect(revisionSelect).toBeVisible();
  await revisionSelect.selectOption('order-processing-candidate-2');

  // The refusal is a 409, which Chromium logs as a console error; the test causes it on purpose.
  pageErrors.expect({
    pattern: loggedFailedResponse(409, /\/v1\/workflows\/[^/]+\/fork/),
    reason: 'the test forks a revision the server refuses, and the server answers 409',
  });
  await page.getByRole('button', { name: 'Create fork' }).click();

  // A real rejected fork — `WorkflowRevisionUnavailableError` — never a
  // mocked one. `07-activate-workflow-revision.spec.ts` establishes the
  // same real-refusal pattern for the System route's Activate flow.
  const conflictBanner = page.getByRole('alert').filter({ hasText: 'Revision unavailable' });
  await expect(conflictBanner).toBeVisible();
  await expect(conflictBanner.getByText(/Pick a different revision/)).toBeVisible();
  await checkA11y('workflow detail — checkpoints, Fork panel (rejected revision conflict)');

  // Second half: a pinned schedule shows "Pinned (rev X)" on its own detail
  // page (WFT-117's schedule create/edit surface).
  await page.goto('/schedules/new');
  await page.getByRole('combobox', { name: /^Workflow/ }).fill('order');
  await page.getByRole('option', { name: /Order Processing/ }).click();

  await page
    .getByRole('group', { name: SCHEDULE_COPY.create.revisionLabel })
    .getByRole('radio', { name: 'Pinned' })
    .click();

  await page.getByRole('button', { name: 'Create schedule' }).click();

  await expect(page).toHaveURL(/\/schedules\/[^/?]+$/);
  // The revision the schedule resolves against is in its details, beside its other settings.
  await expect(page.getByTestId('schedule-rail').getByText(/^Pinned \(/)).toBeVisible();
  await checkA11y('schedule detail — pinned revision policy shown');
});

test('the revision surfaces are usable across supported widths and themes', async ({ page }) => {
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
      await page.goto('/workflows/order-processing/runs');

      const orderRow = page.getByRole('row', { name: /order-processing/ }).first();
      await expect(orderRow).toBeVisible();
      await orderRow.getByRole('link').click();

      await expect(page.getByText(/ — active$/).first()).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
  }
});
