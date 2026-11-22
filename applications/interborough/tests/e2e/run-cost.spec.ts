/**
 * What a run cost, on the Run page and in the Runs list (COR-2525), against the sample world. The
 * showcase host's stub provider makes no real model call, so what its runs cost is not the test's
 * to assume; the test gives one finished run a `usage` as the Bureau would report it, by rewriting the answers of
 * `bureau.tasks.get` and `bureau.tasks.list` for that run alone, and reads the cost where a person
 * does: the Cost fact of the run's rail, and the Cost column of its row. A run with no cost says
 * nothing of one, on either page, and no page says `$0.00`.
 */
import type { Page, Route } from '@playwright/test';

import { SAMPLE_NOW, SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import { readSampleWorldRecords } from '../../fixtures/sample-world-records.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

/** What the Bureau reports of a run it priced: 1,500 tokens, and $0.1234 in US dollars. */
const PRICED_USAGE = {
  promptTokens: 1200,
  completionTokens: 300,
  totalTokens: 1500,
  costUsd: 0.1234,
} as const;

type TaskAnswer = { id?: string; usage?: unknown };

/** Gives the task `runId` the usage `usage` in every answer of `bureau.tasks.get` and `bureau.tasks.list`. */
async function reportUsage(page: Page, runId: string, usage: unknown): Promise<void> {
  await page.route('**/jsonrpc', async (route: Route) => {
    const request = route.request().postDataJSON() as { method?: string } | null;
    if (request?.method !== 'bureau.tasks.get' && request?.method !== 'bureau.tasks.list') {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const body = (await response.json()) as { result?: TaskAnswer & { tasks?: TaskAnswer[] } };
    const result = body.result;
    if (result !== undefined) {
      if (result.id === runId) result.usage = usage;
      for (const task of result.tasks ?? []) if (task.id === runId) task.usage = usage;
    }
    await route.fulfill({ response, json: body });
  });
}

/** Opens `/runs` and brings the run's row into view, loading more pages while it is not on this one. */
async function findRow(page: Page, runId: string) {
  await page.goto('/runs');
  const row = page.locator(`[data-run="${runId}"]`);
  const loadMore = page.getByRole('button', { name: 'Load more' });
  for (let pages = 0; pages < 20; pages += 1) {
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    if ((await row.count()) > 0) break;
    if ((await loadMore.count()) === 0) break;
    await loadMore.click();
  }
  await expect(row).toBeVisible();
  return row;
}

test('a finished run shows its cost on its page and in the Runs list', async ({ page }) => {
  const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
  await page.clock.setFixedTime(SAMPLE_NOW);
  await reportUsage(page, world.runs.done, PRICED_USAGE);

  await page.goto(`/runs/${encodeURIComponent(world.runs.done)}`);
  await expect(page.locator('[data-run-header] [data-status-word]')).toBeVisible();
  const rail = page.getByRole('complementary');
  await expect(rail.locator('dt', { hasText: /^Tokens$/ })).toBeVisible();
  await expect(
    rail.locator('dt', { hasText: /^Tokens$/ }).locator('xpath=following-sibling::dd[1]'),
  ).toHaveText('1,500');
  await expect(
    rail.locator('dt', { hasText: /^Cost$/ }).locator('xpath=following-sibling::dd[1]'),
  ).toHaveText('$0.12');

  const row = await findRow(page, world.runs.done);
  await expect(row.getByTestId('run-cost')).toHaveText('$0.12');
});

test('a finished run with no cost says none on its page or in the Runs list, and no page says $0.00', async ({
  page,
}) => {
  const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
  await page.clock.setFixedTime(SAMPLE_NOW);
  await reportUsage(page, world.runs.done, {
    promptTokens: 1200,
    completionTokens: 300,
    totalTokens: 1500,
    costUsd: null,
  });

  await page.goto(`/runs/${encodeURIComponent(world.runs.done)}`);
  await expect(page.locator('[data-run-header] [data-status-word]')).toBeVisible();
  const rail = page.getByRole('complementary');
  await expect(rail.locator('dt', { hasText: /^Tokens$/ })).toBeVisible();
  await expect(rail.locator('dt', { hasText: /^Cost$/ })).toHaveCount(0);
  await expect(page.getByText('$0.00')).toHaveCount(0);

  const row = await findRow(page, world.runs.done);
  await expect(row.getByTestId('run-cost')).toHaveCount(0);
  await expect(page.getByText('$0.00')).toHaveCount(0);
});
