/**
 * COR-2538: the owner forks a run, and compares the fork with its source on any day.
 *
 * The run is the seeded `fork-comparison` run (`fixtures/fork-comparison.ts`) on the real Weft
 * server; nothing is mocked. Its last step, `issueTicket`, hands out the next ticket number of the
 * server process, so a fork from the last checkpoint answers a different ticket than the source did,
 * and the comparison has a payload difference to read.
 *
 * - The fork dialog says what the fork keeps and runs again, from the server's dry run, before Create
 *   fork is enabled.
 * - After the page is loaded again on the fork, its Lineage panel's Compare with source action opens the
 *   comparison: the steps before the fork point collapsed as shared, the step the fork ran again marked
 *   changed, and its output difference in the diff viewer.
 */
import type { Page } from '@playwright/test';

import { FORK_COMPARISON_RUN_ID } from '../../fixtures/fork-comparison-ids.ts';
import { expect, test } from './fixtures.ts';
import { openHowItRan } from './workflow-support.ts';

/** Forks the seeded run from its last checkpoint through the run page, and answers the fork's id. */
async function forkFromTheLastCheckpoint(page: Page): Promise<string> {
  await page.goto(`/runs/${encodeURIComponent(FORK_COMPARISON_RUN_ID)}`);
  await openHowItRan(page);
  await page.getByRole('tab', { name: 'Events and logs' }).click();
  await page.getByRole('button', { name: 'Checkpoints' }).click();
  const checkpointList = page.locator('.weft-checkpoints-tab__list');
  await expect(checkpointList).toBeVisible();
  await checkpointList.locator('.weft-checkpoints-tab__row').first().click();
  await page.getByRole('radio', { name: 'Fork' }).click();

  // The dialog says what the fork will do, from the server's dry run, before it can be confirmed.
  const create = page.getByRole('button', { name: 'Create fork' });
  const preview = page.locator('[data-fork-preview]');
  await expect(preview.getByText('Kept, not run again (1)')).toBeVisible();
  await expect(preview.getByText('Run again (1)')).toBeVisible();
  await expect(preview.locator('[data-fork-preview-kept] li')).toHaveText(['Step 1, reserveStock']);
  await expect(preview.locator('[data-fork-preview-rerun] li')).toHaveText(['Step 2, issueTicket']);
  await expect(create).toBeEnabled();

  await create.click();
  const forkId = page.locator('.weft-fork-dialog__success code');
  await expect(forkId).toBeVisible();
  return (await forkId.textContent()) ?? '';
}

test('a fork is compared with its source after the page is loaded again, down to a changed payload', async ({
  page,
  request,
  checkA11y,
}) => {
  const forkId = await forkFromTheLastCheckpoint(page);
  expect(forkId).not.toBe('');

  // The comparison is of what the fork has run, so the spec waits for the fork to finish.
  await expect
    .poll(async () => {
      const response = await request.get(`/v1/workflows/${encodeURIComponent(forkId)}`);
      return ((await response.json()) as { status?: string }).status;
    })
    .toBe('completed');

  // The comparison needs nothing from the session that made the fork: a fresh load of the fork's page.
  await page.goto(`/runs/${encodeURIComponent(forkId)}`);
  await page.reload();
  await openHowItRan(page);
  await page.getByRole('tab', { name: 'Versioning' }).click();

  const lineage = page.locator('[data-section="lineage"]');
  await expect(lineage.getByText('Forked from')).toBeVisible();
  await lineage.getByRole('button', { name: 'Compare with source' }).click();

  const comparison = page.locator('[data-section="fork-comparison"]');
  await expect(comparison).toBeVisible();

  // The step before the fork point is shared, and collapsed.
  const shared = comparison.getByRole('button', { name: '1 step shared with the source' });
  await expect(shared).toHaveAttribute('aria-expanded', 'false');
  await expect(comparison.locator('[data-shared-step]')).toHaveCount(0);

  // The step the fork ran again differs; open it and read the changed ticket.
  const rerun = comparison.locator('[data-compared-step="1"]');
  await expect(rerun).toHaveAttribute('data-kind', 'changed');
  await rerun.click();
  const output = comparison.getByRole('group', { name: 'Output differences, step 2' });
  await expect(output).toBeVisible();
  const ticket = output.locator('[data-cinder-diff-kind="changed"]').filter({ hasText: 'ticket' });
  await expect(ticket).toHaveCount(1);
  const [, before, after] = /(\d+) → (\d+)/.exec((await ticket.textContent()) ?? '') ?? [];
  expect(before).toBeDefined();
  expect(after).toBeDefined();
  expect(before).not.toBe(after);
  // The input is the same in both runs.
  await expect(comparison.getByText('The input is the same in both runs.')).toBeVisible();

  await checkA11y('run — Versioning tab, a fork compared with its source');
});
