/**
 * COR-1461, COR-1462, COR-1463: an operator opens a run and works its search attributes, its stream
 * and its updates, against the seeded real Weft server (`fixtures/engine-console.ts`); nothing is
 * mocked.
 *
 * - Attributes: edits one value of every type the console edits (string, number, boolean, date, list)
 *   and sees what a fresh read returns. The date edit is the one that only works because
 *   `weft.workflows.attributes.set` turns an ISO string into a `Date` for a `date-time` attribute.
 * - Streams: opens `progress` from the Timeline and reads its three stored chunks.
 * - Updates: reads a history that holds updates sent before the page loaded, then sends one that
 *   outlasts its one-second wait, sees the wait end with the update still listed, and sees its result
 *   arrive.
 *
 * Only this spec uses these three runs, so changing them is safe anywhere in the run order.
 */
import type { Locator, Page } from '@playwright/test';

import {
  ATTRIBUTE_SHOWCASE_RUN_ID,
  CHUNK_STREAMER_RUN_ID,
  UPDATE_DESK_RUN_ID,
} from '../../fixtures/engine-console-ids.ts';
import { expect, test } from './fixtures.ts';

function attributes(page: Page): Locator {
  return page.getByRole('region', { name: 'Search attributes' });
}

function row(page: Page, key: string): Locator {
  return attributes(page).locator(`[data-attribute-key="${key}"]`);
}

async function storedAttributes(page: Page): Promise<Record<string, unknown>> {
  const response = await page.request.get(
    `/api/v1/workflows/${ATTRIBUTE_SHOWCASE_RUN_ID}/attributes`,
  );
  expect(response.ok()).toBe(true);
  return (await response.json()) as Record<string, unknown>;
}

test('operator edits a run’s search attributes, one of every type, and reads back what the server holds', async ({
  page,
  checkA11y,
}) => {
  await page.goto(`/runs/${ATTRIBUTE_SHOWCASE_RUN_ID}`);
  await expect(attributes(page)).toBeVisible();
  await expect(attributes(page)).toHaveAttribute('data-state', 'ready');
  await expect(row(page, 'owner')).toContainText('ops-team');
  await expect(row(page, 'priority')).toContainText('2');
  await expect(row(page, 'urgent')).toContainText('false');
  await expect(row(page, 'reviewBy')).toContainText('2026-12-01T09:00:00.000Z');
  await expect(row(page, 'labels')).toContainText('finance');
  await checkA11y('workflow detail — search attributes');

  // A string.
  await row(page, 'owner').getByRole('button', { name: 'Edit owner' }).click();
  await checkA11y('workflow detail — editing a search attribute');
  await row(page, 'owner').getByLabel('owner', { exact: true }).fill('platform-team');
  await row(page, 'owner').getByRole('button', { name: 'Save owner' }).click();
  await expect(row(page, 'owner')).toContainText('platform-team');
  await expect(row(page, 'owner').getByRole('button', { name: 'Save owner' })).toHaveCount(0);

  // A number.
  await row(page, 'priority').getByRole('button', { name: 'Edit priority' }).click();
  await row(page, 'priority').getByRole('spinbutton', { name: 'priority' }).fill('5');
  await row(page, 'priority').getByRole('button', { name: 'Save priority' }).click();
  await expect(row(page, 'priority')).toContainText('5');

  // A boolean.
  await row(page, 'urgent').getByRole('button', { name: 'Edit urgent' }).click();
  await row(page, 'urgent').getByRole('switch', { name: 'urgent' }).click();
  await row(page, 'urgent').getByRole('button', { name: 'Save urgent' }).click();
  await expect(row(page, 'urgent')).toContainText('true');

  // A date: sent as an ISO string, which the server turns into a `Date` because the workflow
  // declares the attribute `date-time`.
  await row(page, 'reviewBy').getByRole('button', { name: 'Edit reviewBy' }).click();
  await row(page, 'reviewBy')
    .getByRole('textbox', { name: 'reviewBy' })
    .fill('2027-01-15T10:00:00Z');
  await row(page, 'reviewBy').getByRole('button', { name: 'Save reviewBy' }).click();
  await expect(row(page, 'reviewBy')).toContainText('2027-01-15T10:00:00.000Z');

  // A list of strings.
  await row(page, 'labels').getByRole('button', { name: 'Edit labels' }).click();
  const labels = row(page, 'labels').getByRole('textbox', { name: 'labels' });
  await labels.fill('priority');
  await labels.press('Enter');
  await row(page, 'labels').getByRole('button', { name: 'Save labels' }).click();
  await expect(row(page, 'labels')).toContainText('priority');

  expect(await storedAttributes(page)).toMatchObject({
    owner: 'platform-team',
    priority: 5,
    urgent: true,
    reviewBy: '2027-01-15T10:00:00.000Z',
    labels: ['quarterly', 'finance', 'priority'],
  });

  // The date was refused for what it is, not for its type: a bad one is refused before any request.
  await row(page, 'reviewBy').getByRole('button', { name: 'Edit reviewBy' }).click();
  await row(page, 'reviewBy').getByRole('textbox', { name: 'reviewBy' }).fill('next tuesday');
  await row(page, 'reviewBy').getByRole('button', { name: 'Save reviewBy' }).click();
  await expect(row(page, 'reviewBy')).toContainText('Enter a date and time');
  const unchanged = await storedAttributes(page);
  expect(unchanged['reviewBy']).toBe('2027-01-15T10:00:00.000Z');
});

test('operator opens a stream from the timeline and reads its chunks in order', async ({
  page,
  checkA11y,
}) => {
  await page.goto(`/runs/${CHUNK_STREAMER_RUN_ID}?tab=timeline`);
  await page.getByRole('button', { name: 'View chunks of progress' }).click();

  const chunks = page.locator('[data-chunk-sequence]');
  await expect(chunks).toHaveCount(3);
  await expect(chunks.nth(0)).toContainText('queued');
  await expect(chunks.nth(1)).toContainText('running');
  await expect(chunks.nth(2)).toContainText('verifying');
  await expect(page.locator('[data-stream-key]')).toHaveText('progress');
  await checkA11y('workflow detail — stream chunks');

  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(chunks).toHaveCount(0);
});

test('operator reads a run’s update history, then sends an update that outlasts its wait and sees its result arrive', async ({
  page,
  checkA11y,
}) => {
  await page.goto(`/runs/${UPDATE_DESK_RUN_ID}?tab=updates`);

  // Both were sent when the fixture was seeded, before this page loaded.
  const greeted = page.locator('[data-update-id]', { hasText: 'greet' });
  await expect(greeted).toBeVisible();
  await expect(greeted).toContainText('hello ada');
  const exploded = page.locator('[data-update-id]', { hasText: 'explode' });
  await expect(exploded).toBeVisible();
  await expect(exploded).toContainText('the desk refused this update');
  await checkA11y('workflow detail — update history');

  const form = page.locator('.weft-send-tab__form');
  await form.getByLabel('Update name').fill('slow');
  await form.getByLabel('Payload').fill('"x"');
  await form.getByLabel('Timeout (s)').fill('1');
  await form.getByRole('button', { name: 'Send update' }).click();

  // The wait ends with the update still queued: a notice, not a fault, and the update stays listed.
  await expect(page.getByRole('status').filter({ hasText: 'had not answered' })).toBeVisible();
  const slow = page.locator('[data-update-id]', { hasText: 'slow' });
  await expect(slow).toBeVisible();
  await expect(slow).toContainText('awaiting result');
  await expect(page.locator('.weft-workflow-detail__fault')).toHaveCount(0);

  // The handler finishes on its own; the history asks again and the result shows.
  await expect(slow).toContainText('slow-done:x', { timeout: 15_000 });
  await expect(slow).not.toContainText('awaiting result');

  // One send is one update. Over REST the timed-out send answers `408`, which a browser replays, so
  // the form sends over JSON-RPC (`updates/updates-data.ts`); a replay would show here as more rows.
  await expect(page.locator('[data-update-id]', { hasText: 'slow' })).toHaveCount(1);
});
