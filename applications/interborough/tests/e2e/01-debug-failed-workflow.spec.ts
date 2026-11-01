/**
 * Persona flow (a): debug-a-failed-workflow (plan §11.4).
 *
 * list → filter failed → detail → read failure-category explanation →
 * timeline step expansion → events export menu.
 *
 * Read-only apart from clicking the (idempotent, purely client-side)
 * timeline step-selection toggle and triggering a download — this spec
 * must run before `05-bulk-retry-confirm.spec.ts`, which retries every
 * `status:failed` workflow and would remove the `payment-failing` fixture
 * this spec locates by name (see `playwright.config.ts`'s module doc).
 */
import { expect, test } from './fixtures.ts';

test('operator finds, reads, and exports a failed workflow', async ({ page, checkA11y }) => {
  await page.goto('/workflows/payment-failing/runs');
  // Gate the first axe check behind the real screen, not the lazy-route
  // boot skeleton `page.goto()`'s `load` event resolves under — an
  // ungated check here audits whatever DOM happens to be present the
  // instant `load` fires, which in this SPA is `route-outlet.svelte`'s
  // placeholder, not the list.
  await expect(page.getByRole('table', { name: 'Workflows' })).toBeVisible();
  await checkA11y('workflow list');

  await page
    .getByRole('group', { name: 'Filter by status' })
    .getByRole('button', { name: 'Failed' })
    .click();

  const failedRow = page.getByRole('row', { name: /payment-failing/ });
  await expect(failedRow).toBeVisible();
  await failedRow.getByRole('link').click();

  // A run only the engine knows has the workflow's type as its page's one level-1 heading, and
  // its sections are on the page: there are no tabs to open.
  await expect(page.getByRole('heading', { level: 1, name: 'payment-failing' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByRole('tab')).toHaveCount(0);
  await expect(
    page.getByText(
      'The workflow or an activity threw an error that did not match a timeout, cancellation, resource, or system failure.',
    ),
  ).toBeVisible();
  await checkA11y('workflow detail — overview (failure explanation)');

  await expect(page.getByRole('heading', { level: 3, name: 'Steps' })).toBeVisible();
  // The first step's row is a button; opening it marks the row current and shows the step beside
  // the list. The test reads nothing of the fixture's step names.
  const stepButton = page.locator('[data-step-row]').first();
  await expect(stepButton).toBeVisible();
  await expect(stepButton).not.toHaveAttribute('aria-current', 'true');
  await stepButton.click();
  await expect(stepButton).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('article[data-step]')).toBeVisible();
  await checkA11y('workflow detail — timeline (step selected)');

  await page.getByRole('button', { name: 'Events' }).click();
  await expect(page.getByText('step: ')).toBeVisible();
  await page.getByRole('button', { name: 'Download' }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await checkA11y('workflow detail — events (download menu open)');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name: 'Event history · JSON' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/-events-.*\.json$/);
});
