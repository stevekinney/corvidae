/**
 * What the reviews specs share about the engine's workflow reviews. The inbox reads them from the
 * merged list (`bureau.reviews.list`), which holds the reviews of the Bureau's own engine. The main
 * end-to-end host runs the fixtures on an engine of its own (`e2e-server.ts`), so the Bureau's list
 * does not hold them; this adds them to the list the page reads, from the engine's own list, as the
 * Bureau does for an engine it composed. Deciding one still goes to the fixture engine.
 */
import type { APIRequestContext, Page } from '@playwright/test';

import { REVIEWS_COPY } from '../../src/app/copy/reviews.ts';
import { E2E_BASE_URL } from './e2e-constants.ts';
import { expect } from './fixtures.ts';

type EngineEntry = {
  status: 'pending' | 'completed';
  reviewId: string;
  workflowId: string;
  artifact: unknown;
  reviewType: string;
  reviewers: string[];
  allowPartial: boolean;
  createdAt: number;
  decision?: 'approved' | 'rejected' | 'needs-changes';
  reviewer?: string;
  feedback?: string;
  timestamp?: number;
};

/** One engine review as `bureau.reviews.list` shows it. */
function listedEngineReview(entry: EngineEntry): Record<string, unknown> {
  return {
    source: 'engine',
    kind: 'engine-review',
    id: entry.reviewId,
    runId: entry.workflowId,
    requestedAt: entry.createdAt,
    ageMilliseconds: 0,
    status: entry.status,
    reviewType: entry.reviewType,
    reviewers: entry.reviewers,
    allowPartial: entry.allowPartial,
    artifact: entry.artifact,
    ...(entry.status === 'completed' && entry.decision !== undefined
      ? {
          resolution: {
            decision: entry.decision,
            decidedBy: entry.reviewer ?? '',
            decidedAt: entry.timestamp ?? entry.createdAt,
            ...(entry.feedback === undefined ? {} : { reason: entry.feedback }),
          },
        }
      : {}),
  };
}

/** Adds the fixture engine's reviews to every `bureau.reviews.list` answer the page gets. */
export async function listEngineReviews(page: Page, request: APIRequestContext): Promise<void> {
  await page.route('**/bureau/jsonrpc', async (route) => {
    const body = (route.request().postDataJSON() ?? {}) as {
      method?: string;
      params?: { status?: string };
    };
    if (body.method !== 'bureau.reviews.list') {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const answer = (await response.json()) as {
      result?: { reviews: Record<string, unknown>[]; nextPageToken?: string | null };
    };
    if (answer.result === undefined) {
      await route.fulfill({ response, json: answer });
      return;
    }
    const status = body.params?.status === 'resolved' ? 'completed' : 'pending';
    const engine = await request.get(`${E2E_BASE_URL}/v1/reviews`, { params: { status } });
    const entries = ((await engine.json()) as { items: EngineEntry[] }).items;
    answer.result.reviews = [...answer.result.reviews, ...entries.map(listedEngineReview)];
    await route.fulfill({ response, json: answer });
  });
}

/**
 * Waits until Reviews has settled, then requires its address to say so. At a desktop width the list
 * opens its first row beside it and names it in the address (ListDetail's `openFirst`, a replace),
 * so a page with a waiting review settles on `/reviews?review=<key of the first row>`; a page with
 * none shows "Nothing waiting on you" and stays on the bare `/reviews`. The bare `/reviews` of a
 * page that has rows lasts only until the list has a width, so this waits for a row or the empty
 * state to show before it reads the address, and never accepts that passing moment.
 */
export async function expectReviewsSettled(page: Page): Promise<void> {
  const firstRow = page.locator('[data-review-row]').first();
  const emptyState = page.getByText(REVIEWS_COPY.allCaughtUp, { exact: true });
  await expect(firstRow.or(emptyState)).toBeVisible();
  if (await firstRow.isVisible()) {
    const first = await firstRow.getAttribute('data-review-row');
    expect(first).not.toBeNull();
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === '/reviews' &&
        url.searchParams.size === 1 &&
        url.searchParams.get('review') === first,
    );
    return;
  }
  await expect(page).toHaveURL((url) => url.pathname === '/reviews' && url.searchParams.size === 0);
}
