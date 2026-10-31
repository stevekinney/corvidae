/**
 * What the reviews specs share about the engine's workflow reviews. The inbox reads them from the
 * merged list (`bureau.reviews.list`), which holds the reviews of the Bureau's own engine. The main
 * end-to-end host runs the fixtures on an engine of its own (`e2e-server.ts`), so the Bureau's list
 * does not hold them; this adds them to the list the page reads, from the engine's own list, as the
 * Bureau does for an engine it composed. Deciding one still goes to the fixture engine.
 */
import type { APIRequestContext, Page } from '@playwright/test';

import { E2E_BASE_URL } from './e2e-constants.ts';

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
 * Answers every `bureau.reviews.list` for what was decided (`status: 'resolved'`) with the reviews
 * named, each read with `bureau.reviews.get`. The Bureau keeps the record of a decision that rode a
 * session commit once the commit's outbox entry is replayed (`recordResolvedReview`), and this host
 * has not listed one as resolved within seconds of the decision, so the Done tab is read here from
 * the records the Bureau does hold, which `get` returns decided.
 */
export async function listResolvedReviews(page: Page, ids: readonly string[]): Promise<void> {
  await page.route('**/bureau/jsonrpc', async (route) => {
    const body = (route.request().postDataJSON() ?? {}) as {
      id?: unknown;
      method?: string;
      params?: { status?: string };
    };
    if (body.method !== 'bureau.reviews.list' || body.params?.status !== 'resolved') {
      await route.fallback();
      return;
    }
    const reviews: unknown[] = [];
    for (const id of ids) {
      const response = await page.request.post(`${E2E_BASE_URL}/bureau/jsonrpc`, {
        data: { jsonrpc: '2.0', id: 'get', method: 'bureau.reviews.get', params: { id } },
      });
      const answer = (await response.json()) as { result?: unknown };
      if (answer.result !== undefined) reviews.push(answer.result);
    }
    await route.fulfill({
      json: { jsonrpc: '2.0', id: body.id, result: { reviews, nextPageToken: null } },
    });
  });
}
