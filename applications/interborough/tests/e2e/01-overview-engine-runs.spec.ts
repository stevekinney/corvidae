/**
 * The Overview's Failed in 24 hours count is the engine's (`weft.workflows.aggregate`), and the
 * engine's own run list (`/health/runs`, `weft.workflows.list`) narrowed to the same filter holds
 * as many runs as the count said, in the engine's own word for each status. The failed workflows
 * are seeded by `fixtures/workflows.ts` (`payment-failing` and the failure-category set) when the
 * host starts; nothing here writes one.
 *
 * Read-only, so it can run anywhere in the order; `05-bulk-retry-confirm.spec.ts` retries every
 * failed workflow and must stay after it.
 */
import { expect, test } from './fixtures.ts';

const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 1280, height: 800 },
] as const;

/** The window "Failed in 24 hours" counts over, cut on a whole minute as the page cuts it. */
function failedListAddress(now: number): string {
  const since = Math.floor((now - 24 * 60 * 60 * 1000) / 60_000) * 60_000;
  return `/health/runs?status=failed&status=timed-out&updated_at_gte=${String(since)}`;
}

for (const viewport of VIEWPORTS) {
  test(`Overview Failed in 24 hours count matches the recently failed engine workflows at ${String(viewport.width)}px`, async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto('/health');

    const counts = page.getByRole('group', { name: 'Health counts' });
    const failed = counts.locator('[data-count="failed"]');
    await expect(failed).toContainText('Failed in 24 hours');
    await expect(failed.locator('.cinder-statistic__value')).toHaveText(/^[1-9]\d*$/);
    await checkA11y(`engine overview at ${String(viewport.width)}px`);
    const counted = Number(await failed.locator('.cinder-statistic__value').textContent());

    await page.goto(failedListAddress(Date.now()));
    await expect(page.getByRole('heading', { level: 1, name: 'Workflow runs' })).toBeVisible();
    // Across types: a count spans every workflow type the engine holds.
    await expect(page.getByRole('row', { name: /payment-failing/ }).first()).toBeVisible();
    // The list is the set the count named.
    await expect(page.getByText(new RegExp(`^Showing \\d+ of ${String(counted)}$`))).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await checkA11y(`engine runs, failed, at ${String(viewport.width)}px`);
  });
}

test('Overview shows its four counts, Needs attention, Recent activity and the metric cards, and Advanced stays collapsed', async ({
  page,
  checkA11y,
}) => {
  await page.goto('/health');

  await expect(page.getByRole('heading', { level: 1, name: 'Health' })).toBeVisible();
  const counts = page.getByRole('group', { name: 'Health counts' });
  for (const label of [
    'Running now',
    'Needs you',
    'Failed in 24 hours',
    'Missed schedule runs (7 days)',
  ]) {
    await expect(counts.locator('.cinder-statistic__label', { hasText: label })).toBeVisible();
  }
  await expect(page.getByTestId('needs-attention')).toBeVisible();
  const activity = page.getByRole('region', { name: /Recent activity/ });
  await expect(activity).toBeVisible();
  expect(await activity.locator('[data-activity]').count()).toBeLessThanOrEqual(9);
  await expect(page.getByTestId('metric-cards')).toBeVisible();
  await expect(
    page.getByTestId('advanced-diagnostics').locator('button[aria-expanded]'),
  ).toHaveAttribute('aria-expanded', 'false');

  await activity.getByRole('link', { name: /^Open audit log/ }).click();
  await expect(page).toHaveURL(/\/health\/audit$/);
  await checkA11y('engine overview');
});
