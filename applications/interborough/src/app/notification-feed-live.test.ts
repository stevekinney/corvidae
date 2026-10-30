/**
 * The notification feed follows `bureau.events` (COR-1725): the recent tasks are read again on a
 * timer only while the Bureau’s feed is not live, and once for a run event; the chats’ titles
 * likewise for a session event, and the notifications for a `notification.created`. The feed is the real source over a stubbed stream, and TanStack
 * Query’s refetch interval is the timer, so the clock is faked and moved by hand.
 */
import { cleanup, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';

import { until } from '../lib/fake-timers.test-support.ts';
import { createLiveFeeds, type LiveFeeds } from '../lib/live-source/live-feeds.test-support.ts';
import { createQueryClient } from '../lib/query.ts';
import { bureau, landAt } from '../routes/chat/pages.test-support.ts';
import QueryPage from '../routes/chat/query-page.test-harness.svelte';
import { REVIEW_POLL_MILLISECONDS } from '../routes/reviews/reviews-data.ts';
import FeedHarness from './notification-feed.test-harness.svelte';
import { memoryStore } from './notification-store.test-support.ts';

let feeds: LiveFeeds | undefined;
let restore: (() => void) | undefined;
let stub: ReturnType<typeof bureau> | undefined;

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  cleanup();
  feeds?.close();
  feeds = undefined;
  restore?.();
  restore = undefined;
  jest.useRealTimers();
});

function open(): void {
  stub = bureau({
    'bureau.reviews.list': () => ({ reviews: [] }),
    'bureau.tasks.list': () => ({ tasks: [], nextPageToken: null }),
    'bureau.contexts.list': () => ({ contexts: [], nextOffset: null }),
    'bureau.notifications.list': () => ({ notifications: [], nextPageToken: null }),
    'bureau.deployment.get': () => ({ id: 'bureau-1' }),
  });
  restore = stub.restore;
  feeds = createLiveFeeds();
  landAt('/agents');
  render(QueryPage, {
    props: {
      page: FeedHarness,
      pageProps: { store: memoryStore() },
      client: createQueryClient(),
      bureauEvents: feeds.bureauEvents,
    },
  } as never);
}

const SITES = [
  { site: 'the recent tasks', operation: 'bureau.tasks.list', event: 'run.settled' },
  { site: 'the chats’ titles', operation: 'bureau.contexts.list', event: 'session.created' },
  {
    site: 'the notifications',
    operation: 'bureau.notifications.list',
    event: 'notification.created',
  },
] as const;

const reads = (operation: string): number =>
  stub?.calls.filter((call) => call.method === operation).length ?? 0;

describe.each(SITES)('the notification feed, reading $site', ({ operation, event }) => {
  test('asks on a timer while the Bureau’s feed is not live', async () => {
    open();
    await until(() => expect(reads(operation)).toBe(1));

    await feeds?.passPolls(3, REVIEW_POLL_MILLISECONDS);

    expect(reads(operation)).toBeGreaterThanOrEqual(3);
  });

  test('asks on no timer while it is live, and once for each event it reports', async () => {
    open();
    await until(() => expect(reads(operation)).toBe(1));
    await feeds?.bureauGoesLive();
    const others = SITES.filter((other) => other.operation !== operation);
    const othersBefore = others.map((other) => reads(other.operation));
    const before = reads(operation);

    await feeds?.passPolls(6, REVIEW_POLL_MILLISECONDS);
    expect(reads(operation)).toBe(before);

    await feeds?.bureauEvent(event);
    await until(() => expect(reads(operation)).toBe(before + 1));
    await feeds?.passPolls(2, REVIEW_POLL_MILLISECONDS);
    expect(reads(operation)).toBe(before + 1);
    expect(others.map((other) => reads(other.operation))).toEqual(othersBefore);
  });

  test('goes back to the timer when the feed is lost', async () => {
    open();
    await until(() => expect(reads(operation)).toBe(1));
    await feeds?.bureauGoesLive();
    feeds?.hub.end('bureau');
    await until(() => expect(feeds?.bureauEvents.status).toBe('reconnecting'));
    const before = reads(operation);

    await feeds?.passPolls(3, REVIEW_POLL_MILLISECONDS);

    expect(reads(operation)).toBeGreaterThan(before);
  });
});
