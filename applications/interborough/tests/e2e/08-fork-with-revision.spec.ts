/**
 * Primary WFT-117 operator flow against the seeded real Weft server:
 *
 * workflows list (filtered to `order-processing`, the eagerly-registered
 * seed type) → detail header shows the persisted revision AND its "matches
 * active" comparison → Checkpoints tab → select a checkpoint → Fork panel
 * shows "Retains rev X" → open the "Fork a different revision" picker →
 * pick the fixture's deliberately-never-eagerly-registered candidate
 * (`fixtures/workflow-revisions.ts`'s `ORDER_PROCESSING_CANDIDATE_REVISION`)
 * → the dialog's dry run (COR-2538) is REALLY refused with a
 * `WorkflowRevisionUnavailableError` Conflict, which renders the picker's own
 * framing and leaves Create fork disabled (mirrors `07-activate-workflow-revision.
 * spec.ts`'s real-refusal pattern, not a mocked one). A separate schedule
 * made on the new schedule page (which has no revision policy of its own, so it follows the
 * active revision) opens on its own detail page.
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
import { expect, test } from './fixtures.ts';
import { openHowItRan } from './workflow-support.ts';

test('operator inspects revision bindings, attempts a rejected explicit-revision fork, and pins a schedule', async ({
  page,
  checkA11y,
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
  // "cell")/Type (with its tags)/Revision/Updated, so among plain `<td>` cells
  // (role "cell") Revision is index 2 (Status=0, Type=1).
  const revisionCell = orderRow.getByRole('cell').nth(2);
  await expect(revisionCell).not.toBeEmpty();
  await checkA11y('workflow list — filtered to order-processing, Revision column visible');

  await orderRow.getByRole('link').click();
  // The run's type heads its page in words (row S68).
  await expect(page.getByRole('heading', { level: 1, name: 'Order processing' })).toBeVisible();

  // The Details rail's Revision row, with the active comparison beside it (WFT-117). The seeded
  // server never activates the candidate fixture, so the original,
  // eagerly-registered revision stays active — this run's own persisted
  // revision matches it. (The run page has no header badge since it became one page.)
  await expect(
    page.getByRole('complementary', { name: 'Details' }).getByText(/ — active$/),
  ).toBeVisible();
  await checkA11y('run — Details rail (revision + active comparison)');

  // Checkpoints are in How it ran's Events and logs tab (COR-2424).
  await openHowItRan(page);
  await page.getByRole('tab', { name: 'Events and logs' }).click();
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

  // The fork dialog asks the server what the fork would do before Create fork can be pressed
  // (COR-2538), so the real rejected fork — `WorkflowRevisionUnavailableError` — is the dry run's
  // refusal, never a mocked one, and the button stays disabled. The dry run is a JSON-RPC call,
  // which answers 200 with the fault in its body, so the browser logs no failed response for it. `07-activate-workflow-revision.spec.ts`
  // establishes the same real-refusal pattern for the System route's Activate flow.
  const conflictBanner = page.getByRole('alert').filter({ hasText: 'Revision unavailable' });
  await expect(conflictBanner).toBeVisible();
  await expect(conflictBanner.getByText(/Pick a different revision/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create fork' })).toBeDisabled();
  await checkA11y('workflow detail — checkpoints, Fork panel (rejected revision conflict)');

  // Second half: a schedule made on the new schedule page follows the active revision (its form
  // has no revision policy of its own), and its detail page opens.
  await page.goto('/schedules/new');
  await page.getByRole('combobox', { name: /^Workflow/ }).click();
  await page.getByRole('option', { name: /Order processing/ }).click();
  // Create waits for the workflow's input fields, which the page draws before it asks.
  await expect(page.getByTestId('new-schedule-input')).toBeVisible();
  // Another flow of this run made a schedule named for the workflow, and a name is one schedule's.
  await page.getByLabel(/^Name/).fill('Order processing for the revision flow');
  await page.getByRole('button', { name: 'Create schedule' }).click();

  await expect(page).toHaveURL(/\/schedules\/[^/?]+$/);
  // The new schedule page has no revision policy of its own, so the schedule follows the active revision.
  await expect(page.getByTestId('schedule-details')).toBeVisible();
  await checkA11y('schedule detail — a schedule made on the new schedule page');
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
