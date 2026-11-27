/// <reference lib="dom" />
import type { ReviewsOperationTypes } from '@lostgradient/bureau-sdk/reviews';
import { render, waitFor } from '@testing-library/svelte';
import { expect, it } from 'bun:test';
import { viewReview } from './model.ts';
import Panel from './panel.svelte';
import { createReviewsView } from './view.svelte.ts';

it('uses the scoped generated list binding and shared approval action', async () => {
  const review = {
    source: 'bureau',
    kind: 'tool-approval',
    id: 'review-1',
    runId: 'run-1',
    sessionId: 'session-1',
    requestedAt: 1,
    ageMilliseconds: 0,
    status: 'pending',
    round: 4,
    approval: { callId: 'call-1', toolName: 'send', arguments: {}, action: { type: 'input' } },
  } as const;
  const calls: string[] = [];
  let sent: unknown;
  let outcome: string | undefined;
  const view = createReviewsView();
  let refresh!: () => Promise<void>;
  const { getByRole } = render(Panel, {
    props: {
      view,
      handlers: { onOpenReject() {}, onCancelReject() {}, onDraft() {} },
      authorized: () => true,
      onOutcome: (_seen: unknown, result: string) => {
        outcome = result;
      },
      onReady: (next: () => Promise<void>) => {
        refresh = next;
      },
      onData: (page: ReviewsOperationTypes['bureau.reviews.list']['output']) => {
        const first = page.reviews[0];
        if (first?.kind === 'tool-approval')
          view.views = [{ ...viewReview(first, 1), actionableReview: first }];
      },
      transport: async (name: string, input: unknown) => {
        calls.push(name);
        if (name === 'bureau.reviews.list')
          return { reviews: [review], total: 1, nextPageToken: null };
        if (name === 'bureau.reviews.get') return review;
        sent = input;
        return { id: review.id, kind: 'tool-approval', decision: 'approve', receipt: 'applied' };
      },
    },
  });
  await waitFor(() => expect(refresh).toBeDefined());
  await refresh();
  getByRole('button', { name: 'Approve' }).click();
  await waitFor(() => expect(outcome).toBe('applied'));
  expect(calls).toEqual(['bureau.reviews.list', 'bureau.reviews.get', 'bureau.reviews.resolve']);
  expect(sent).toEqual({ id: review.id, round: 4, decision: 'approve' });
});

it('stops generated pagination after ten pages and reports truncation', async () => {
  const view = createReviewsView();
  let refresh!: () => Promise<void>;
  let calls = 0;
  let truncated = false;
  render(Panel, {
    props: {
      view,
      handlers: { onOpenReject() {}, onCancelReject() {}, onDraft() {} },
      authorized: () => true,
      onOutcome() {},
      onReady: (next: () => Promise<void>) => {
        refresh = next;
      },
      onData: (_page: unknown, value: boolean) => {
        truncated = value;
      },
      transport: async () => {
        calls++;
        return { reviews: [], total: 1000, nextPageToken: String(calls) };
      },
    },
  });
  await waitFor(() => expect(refresh).toBeDefined());
  await refresh();
  expect(calls).toBe(10);
  expect(truncated).toBe(true);
});

it('aborts an in-flight read when the panel is destroyed', async () => {
  const view = createReviewsView();
  let refresh!: () => Promise<void>;
  let signal: AbortSignal | undefined;
  const { unmount } = render(Panel, {
    props: {
      view,
      handlers: { onOpenReject() {}, onCancelReject() {}, onDraft() {} },
      authorized: () => true,
      onOutcome() {},
      onReady: (next: () => Promise<void>) => {
        refresh = next;
      },
      onData() {
        throw new Error('disposed reads must not publish');
      },
      transport: async (
        _name: string,
        _input: unknown,
        options?: { signal?: AbortSignal | undefined },
      ) => {
        signal = options?.signal;
        return new Promise((resolve) => {
          signal?.addEventListener('abort', () =>
            resolve({ reviews: [], total: 0, nextPageToken: null }),
          );
        });
      },
    },
  });
  await waitFor(() => expect(refresh).toBeDefined());
  const pending = refresh().catch(() => undefined);
  await waitFor(() => expect(signal).toBeDefined());
  unmount();
  await pending;
  expect(signal?.aborted).toBe(true);
});

it('keeps a review read-only when the host has not established authority', async () => {
  const review = {
    source: 'bureau',
    kind: 'tool-approval',
    id: 'refund-1',
    runId: 'run-1',
    sessionId: 'session-1',
    requestedAt: 1,
    ageMilliseconds: 0,
    status: 'pending',
    round: 2,
    approval: { callId: 'call-1', toolName: 'refund', arguments: {}, action: { type: 'input' } },
    effect: {
      kind: 'refund',
      refundId: 'refund-1',
      orderId: 'order-1',
      cents: 4200,
      currency: 'USD',
      status: 'admitted',
    },
  } as const;
  const view = createReviewsView();
  let refresh!: () => Promise<void>;
  const calls: string[] = [];
  const { getByRole } = render(Panel, {
    props: {
      view,
      handlers: { onOpenReject() {}, onCancelReject() {}, onDraft() {} },
      authorized: () => false,
      onOutcome() {},
      onReady: (next: () => Promise<void>) => {
        refresh = next;
      },
      onData: (page: ReviewsOperationTypes['bureau.reviews.list']['output']) => {
        const first = page.reviews[0];
        if (first?.kind === 'tool-approval')
          view.views = [{ ...viewReview(first, 1), actionableReview: first }];
      },
      transport: async (name: string) => {
        calls.push(name);
        return { reviews: [review], total: 1, nextPageToken: null };
      },
    },
  });
  await waitFor(() => expect(refresh).toBeDefined());
  await refresh();
  expect((getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
  expect(calls).toEqual(['bureau.reviews.list']);
});
