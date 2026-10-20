/**
 * Component tests for `ReviewsInbox`'s query-fault handling (plan §10.4).
 * `reviews-page.test.ts` covers the merged list and the decisions over a stubbed Bureau;
 * `reviews.integration.test.ts` covers the engine's data flow against a real engine. This file
 * targets the gap those leave: a non-403 query error (401, 500, network) on the active tab's
 * query must render the same six-treatment fault banner every other route surfaces, not the
 * misleading "all caught up" / "no decisions yet" empty state a failed fetch would otherwise fall
 * through to via `?? []`, and one source failing must not hide the other's reviews.
 */
import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';

import {
  HttpClient,
  HttpClientError,
  type PendingReviewEntry,
  type ReviewListEntry,
} from '@lostgradient/weft';

import { toolApprovalFixture } from '../../lib/bureau-fixtures.test-support.ts';
import type { ReviewQuery } from './review-domain.ts';
import ReviewsInboxTestHarness from './reviews-inbox-test-harness.test-harness.svelte';

interface FakeQueryState<T> {
  data?: T;
  isPending: boolean;
  isError?: boolean;
  error?: unknown;
  refetch?: () => void;
}

function fakeQuery(state: FakeQueryState<ReviewListEntry[]>): ReviewQuery<ReviewListEntry[]> {
  return {
    data: state.data,
    isPending: state.isPending,
    isError: state.isError ?? false,
    error: state.error,
    refetch: state.refetch ?? (() => {}),
  };
}

function fakeClient(): HttpClient {
  return new HttpClient({ baseUrl: 'http://localhost' });
}

function pendingEntry(overrides: Partial<PendingReviewEntry> = {}): PendingReviewEntry {
  return {
    status: 'pending',
    reviewId: 'review-1',
    workflowId: 'wf_4a9f8c31e7b2d05a6f912c10',
    artifact: {},
    reviewType: 'Contract approval',
    reviewers: ['ops@example.com'],
    allowPartial: false,
    createdAt: Date.now() - 60_000,
    timeout: 600_000,
    ...overrides,
  };
}

describe('ReviewsInbox', () => {
  test('shows a fault banner instead of "All caught up" when the pending query errors', async () => {
    const { getByText, queryByText } = render(ReviewsInboxTestHarness, {
      props: {
        client: fakeClient(),
        pendingQuery: fakeQuery({
          isPending: false,
          isError: true,
          error: new HttpClientError(401, 'authentication required'),
        }),
        completedQuery: fakeQuery({ data: [], isPending: false }),
      },
    });

    expect(getByText('Not authorized')).not.toBeNull();
    expect(getByText('authentication required')).not.toBeNull();
    expect(queryByText('All caught up')).toBeNull();
  });

  test("Retry on the fault banner calls the failed query's refetch", async () => {
    let refetched = false;
    const { getByRole } = render(ReviewsInboxTestHarness, {
      props: {
        client: fakeClient(),
        pendingQuery: fakeQuery({
          isPending: false,
          isError: true,
          error: new HttpClientError(500, 'boom'),
          refetch: () => {
            refetched = true;
          },
        }),
        completedQuery: fakeQuery({ data: [], isPending: false }),
      },
    });

    await fireEvent.click(getByRole('button', { name: 'Retry' }));
    expect(refetched).toBe(true);
  });

  test('renders the ordinary empty state when the pending query succeeds with no data', async () => {
    const { getByText } = render(ReviewsInboxTestHarness, {
      props: {
        client: fakeClient(),
        pendingQuery: fakeQuery({ data: [], isPending: false }),
        completedQuery: fakeQuery({ data: [], isPending: false }),
      },
    });

    expect(getByText('All caught up')).not.toBeNull();
  });

  test("switching to Decided surfaces the completed query's error, not the pending query's", async () => {
    const { getByRole, getByText, queryByText } = render(ReviewsInboxTestHarness, {
      props: {
        client: fakeClient(),
        pendingQuery: fakeQuery({ data: [], isPending: false }),
        completedQuery: fakeQuery({
          isPending: false,
          isError: true,
          error: new HttpClientError(500, 'boom'),
        }),
      },
    });

    // 'pending' tab is active by default — the completed query's error must
    // not leak into the initially-visible tab.
    expect(getByText('All caught up')).not.toBeNull();
    expect(queryByText('Something went wrong')).toBeNull();

    await fireEvent.click(getByRole('radio', { name: 'Decided' }));

    expect(getByText('Something went wrong')).not.toBeNull();
    expect(queryByText('No decisions yet')).toBeNull();
  });

  test('a pending review is auto-selected, rendering its decision form in the detail pane', async () => {
    const { getByText, queryByText } = render(ReviewsInboxTestHarness, {
      props: {
        client: fakeClient(),
        pendingQuery: fakeQuery({ data: [pendingEntry()], isPending: false }),
        completedQuery: fakeQuery({ data: [], isPending: false }),
      },
    });

    expect(queryByText('No review selected')).toBeNull();
    expect(getByText('Approve')).not.toBeNull();
    expect(getByText('Reject')).not.toBeNull();
  });

  test('shows the Bureau’s reviews beside a fault of the engine’s, and the engine’s beside the Bureau’s', async () => {
    const approval = toolApprovalFixture();
    const { getByText, getAllByText, queryByText } = render(ReviewsInboxTestHarness, {
      props: {
        client: fakeClient(),
        bureauQuery: {
          data: [approval],
          isPending: false,
          isError: false,
          error: undefined,
          refetch: () => {},
        },
        pendingQuery: fakeQuery({
          isPending: false,
          isError: true,
          error: new HttpClientError(500, 'the engine broke'),
        }),
        completedQuery: fakeQuery({ data: [], isPending: false }),
      },
    });

    expect(getByText('the engine broke')).not.toBeNull();
    expect(getAllByText('issue-refund').length).toBeGreaterThan(0);
    expect(queryByText('All caught up')).toBeNull();
  });

  test('shows the engine’s reviews beside a fault of the Bureau’s', async () => {
    const { getByText, getAllByText } = render(ReviewsInboxTestHarness, {
      props: {
        client: fakeClient(),
        bureauQuery: {
          data: undefined,
          isPending: false,
          isError: true,
          error: new HttpClientError(500, 'the Bureau broke'),
          refetch: () => {},
        },
        pendingQuery: fakeQuery({ data: [pendingEntry()], isPending: false }),
        completedQuery: fakeQuery({ data: [], isPending: false }),
      },
    });

    expect(getByText('the Bureau broke')).not.toBeNull();
    expect(getAllByText('Contract approval').length).toBeGreaterThan(0);
  });

  test('reads nothing of the engine’s while it is not enabled, and is not left loading by it', async () => {
    const { getByText, queryByText } = render(ReviewsInboxTestHarness, {
      props: {
        client: fakeClient(),
        weftEnabled: false,
        // A disabled query is pending for ever, and has data from an earlier principal.
        pendingQuery: fakeQuery({ data: [pendingEntry()], isPending: true }),
        completedQuery: fakeQuery({ data: [], isPending: true }),
      },
    });

    expect(getByText('All caught up')).not.toBeNull();
    expect(queryByText('Contract approval')).toBeNull();
    expect(queryByText('Loading reviews')).toBeNull();
  });
});
