/**
 * The Overview's status counts open the engine's own run list. A count is the engine's
 * (`weft.workflows.aggregate`), so its link goes to the engine's list (`weft.workflows.list`)
 * narrowed to that status, in the engine's own word, and the list holds as many runs as the count
 * said. The failed workflows are seeded by `fixtures/workflows.ts` (`payment-failing` and the
 * failure-category set) when the host starts; nothing here writes one.
 *
 * Read-only, so it can run anywhere in the order; `05-bulk-retry-confirm.spec.ts` retries every
 * failed workflow and must stay after it.
 */
import { expect, test } from './fixtures.ts';

const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 1280, height: 800 },
] as const;

for (const viewport of VIEWPORTS) {
  test(`Overview Failed in 24h count opens the recently failed engine workflows at ${String(viewport.width)}px`, async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto('/health');

    const failedCount = page.getByRole('link', { name: /^Failed in 24h\s+\d+$/ });
    await expect(failedCount).toBeVisible();
    await checkA11y(`engine overview at ${String(viewport.width)}px`);
    const countText = (await failedCount.textContent()) ?? '';
    const counted = Number(/(\d+)\s*$/.exec(countText)?.[1]);
    expect(counted).toBeGreaterThan(0);

    await failedCount.click();

    await expect(page).toHaveURL(
      /\/health\/runs\?status=failed&status=timed-out&updated_at_gte=\d+$/,
    );
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

test('Overview shows the health line, four counts, and a window of at most six activity lines', async ({
  page,
  checkA11y,
}) => {
  await page.goto('/health');

  await expect(page.getByRole('heading', { level: 1, name: 'Health' })).toBeVisible();
  const counts = page.getByRole('navigation', { name: 'Health counts' });
  await expect(counts.getByRole('link')).toHaveCount(4);
  for (const label of ['Working now', 'Needs you', 'Failed in 24h', 'Schedules']) {
    await expect(
      counts.getByRole('link', { name: new RegExp(`^${label}\\s+(\\d+|—)$`) }),
    ).toBeVisible();
  }

  // A fixed window: the seeded engine has far more events than six, and the window never grows.
  const activity = page.getByRole('region', { name: 'Recent activity' });
  await expect(activity).toBeVisible();
  expect(await activity.locator('.weft-activity-feed__row').count()).toBeLessThanOrEqual(6);

  await activity.getByRole('link', { name: 'Open the audit log' }).click();
  await expect(page).toHaveURL(/\/health\/audit$/);
  await checkA11y('engine overview');
});
