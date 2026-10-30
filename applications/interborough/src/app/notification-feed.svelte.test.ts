/**
 * The feed that connects the notification store to the Bureau: what is waiting and what finished
 * become the store's items, a decision made elsewhere removes its item at once, and opening a chat
 * reads what is about it.
 */
import { QueryClient } from '@tanstack/svelte-query';
import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { createQueryClient } from '../lib/query.ts';
import { invalidateReviewQueries } from '../lib/review-queries.ts';
import { bureau, landAt } from '../routes/chat/pages.test-support.ts';
import QueryPage from '../routes/chat/query-page.test-harness.svelte';
import FeedHarness from './notification-feed.test-harness.svelte';
import { memoryStore } from './notification-store.test-support.ts';

let restore: (() => void) | undefined;
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

const NOW = Date.now();

const APPROVAL = {
  id: 'approval:run-1:call-1',
  runId: 'run-1',
  agentName: 'tool-runner',
  requestedAt: NOW - 60_000,
  ageMilliseconds: 60_000,
  status: 'pending',
  kind: 'tool-approval',
  sessionId: 'session-refund',
  round: 0,
  approval: {
    callId: 'call-1',
    toolName: 'issue-refund',
    arguments: {},
    action: { type: 'approval', risk: 'high', operation: { kind: 'other' } },
  },
};

const ECHO_TASK = {
  id: 'run-2',
  contextId: 'session-echo',
  agentName: 'echo',
  owner: 'anonymous:local',
  actor: null,
  kind: 'chat',
  status: 'completed',
  finishReason: 'stop-condition',
  statusMessage: null,
  createdAt: new Date(NOW - 120_000).toISOString(),
  updatedAt: new Date(NOW - 120_000).toISOString(),
  cleanup: null,
  openWaits: [],
};

function context(id: string, title: string) {
  return {
    id,
    owner: 'anonymous:local',
    agentName: 'echo',
    title,
    lastMessagePreview: null,
    parentContextId: null,
    forkedFromMessageId: null,
    messageCount: 2,
    createdAt: new Date(NOW - 180_000).toISOString(),
    updatedAt: new Date(NOW - 120_000).toISOString(),
    activity: 'idle',
  };
}

const CONTEXTS = {
  contexts: [
    context('session-refund', 'Refund order 1234'),
    context('session-echo', 'Hello echo, say this back'),
  ],
  nextOffset: null,
};

/** The Bureau as a host with one pending approval and one answered chat. */
function served(overrides: Record<string, (params: Record<string, unknown>) => unknown> = {}) {
  let reviews: unknown[] = [APPROVAL];
  const bureauStub = bureau({
    'bureau.reviews.list': () => ({ reviews }),
    'bureau.tasks.list': () => ({ tasks: [ECHO_TASK], nextPageToken: null }),
    'bureau.contexts.list': () => CONTEXTS,
    'bureau.notifications.list': () => ({ notifications: [], nextPageToken: null }),
    'bureau.notifications.markread': (params) => ({
      updated: (params['ids'] as string[]).length,
    }),
    ...overrides,
  });
  restore = bureauStub.restore;
  return {
    ...bureauStub,
    decide: () => {
      reviews = [];
    },
  };
}

function callsTo(stub: { calls: readonly { method: string; params: unknown }[] }, method: string) {
  return stub.calls.filter((call) => call.method === method);
}

function mount(client: QueryClient = createQueryClient()) {
  const store = memoryStore();
  render(QueryPage, { props: { page: FeedHarness, pageProps: { store }, client } } as never);
  return { store, client };
}

describe('connectNotificationFeed', () => {
  test('lists the pending approval and the finished chat, each by the chat’s title', async () => {
    served();
    landAt('/agents');

    const { store } = mount();

    await waitFor(() => expect(store.items).toHaveLength(2));
    expect(store.items.map(({ kind, title, detail }) => ({ kind, title, detail }))).toEqual([
      { kind: 'approval', title: 'tool-runner needs your approval', detail: 'Refund order 1234' },
      { kind: 'answered', title: 'echo answered', detail: 'Hello echo, say this back' },
    ]);
    expect(store.unreadCount).toBe(1);
  });

  test('an approval decided elsewhere leaves the list and the count at the next read', async () => {
    const bureauStub = served();
    landAt('/agents');
    const { store, client } = mount();
    await waitFor(() => expect(store.unreadCount).toBe(1));

    bureauStub.decide();
    await invalidateReviewQueries(client);

    await waitFor(() => expect(store.items.map((item) => item.kind)).toEqual(['answered']));
    expect(store.unreadCount).toBe(0);
  });

  test('opening a chat reads what is about it', async () => {
    served();
    landAt('/chat/session-refund');
    const first = mount();
    await waitFor(() => expect(first.store.items).toHaveLength(2));
    expect(first.store.items.find((item) => item.kind === 'approval')?.read).toBe(true);
    expect(first.store.unreadCount).toBe(0);
    cleanup();

    landAt('/chat/session-echo');
    const second = mount();

    await waitFor(() => expect(second.store.items).toHaveLength(2));
    expect(second.store.items.find((item) => item.kind === 'approval')?.read).toBe(false);
    expect(second.store.unreadCount).toBe(1);
  });

  test('an answer that lands while its chat is open is read on arrival, so it is not new on leaving', async () => {
    served();
    landAt('/chat/session-echo');
    const { store } = mount();

    await waitFor(() => expect(store.items).toHaveLength(2));
    expect(store.items.find((item) => item.kind === 'answered')?.read).toBe(true);
    // The same store, the person now elsewhere: the answer is still read.
    landAt('/agents');
    expect(store.items.find((item) => item.kind === 'answered')?.read).toBe(true);
  });

  test('a finished run whose context is not a chat the Bureau lists is not an item', async () => {
    served({
      'bureau.reviews.list': () => ({ reviews: [] }),
      'bureau.tasks.list': () => ({
        tasks: [{ ...ECHO_TASK, id: 'run-4', contextId: 'catalog-context' }],
        nextPageToken: null,
      }),
    });
    landAt('/agents');

    const { store, client } = mount();

    // Every read has been answered, and the one run in them has no chat to open.
    await waitFor(() => {
      expect(client.isFetching()).toBe(0);
      expect(client.getQueryData(['bureau-tasks', 'recent'])).toBeDefined();
      expect(client.getQueryData(['contexts', 'titles'])).toBeDefined();
    });
    expect(store.items).toEqual([]);
  });

  test('a chat that is only about to start is not an open chat', async () => {
    served();
    landAt('/chat/new');

    const { store } = mount();

    await waitFor(() => expect(store.items).toHaveLength(2));
    expect(store.unreadCount).toBe(1);
  });

  function failure(overrides: Record<string, unknown> = {}) {
    return {
      id: 'notification-1',
      kind: 'run.failed',
      title: 'assistant failed',
      body: 'Provider quota exceeded',
      link: null,
      subject: { runId: 'run-3', contextId: 'session-fire', agentName: 'assistant' },
      createdAt: new Date(NOW - 30_000).toISOString(),
      readAt: null,
      dismissedAt: null,
      ...overrides,
    };
  }

  const FIRE_CONTEXTS = {
    contexts: [context('session-fire', 'Nightly digest')],
    nextOffset: null,
  };

  test('a failed run is the Bureau’s notification, named by its agent and its chat', async () => {
    served({
      'bureau.reviews.list': () => ({ reviews: [] }),
      'bureau.tasks.list': () => ({ tasks: [], nextPageToken: null }),
      'bureau.contexts.list': () => FIRE_CONTEXTS,
      'bureau.notifications.list': () => ({ notifications: [failure()], nextPageToken: null }),
    });
    landAt('/agents');

    const { store } = mount();

    await waitFor(() => expect(store.items).toHaveLength(1));
    expect(store.items[0]).toMatchObject({
      kind: 'failed',
      title: 'assistant failed',
      detail: 'Nightly digest',
      read: false,
    });
    expect(store.unreadCount).toBe(1);
  });

  test('a notification the Bureau holds as read is read, and a run over its budget says so', async () => {
    served({
      'bureau.reviews.list': () => ({ reviews: [] }),
      'bureau.tasks.list': () => ({ tasks: [], nextPageToken: null }),
      'bureau.contexts.list': () => FIRE_CONTEXTS,
      'bureau.notifications.list': () => ({
        notifications: [
          failure({ kind: 'run.budget-exceeded', readAt: new Date(NOW - 1_000).toISOString() }),
        ],
        nextPageToken: null,
      }),
    });
    landAt('/agents');

    const { store } = mount();

    await waitFor(() => expect(store.items).toHaveLength(1));
    expect(store.items[0]).toMatchObject({
      kind: 'budget',
      title: 'assistant exceeded its budget',
      read: true,
    });
    expect(store.unreadCount).toBe(0);
  });

  test('reading a notification in the bell reads it in the Bureau, and asks for the list again', async () => {
    const bureauStub = served({
      'bureau.reviews.list': () => ({ reviews: [] }),
      'bureau.tasks.list': () => ({ tasks: [], nextPageToken: null }),
      'bureau.contexts.list': () => FIRE_CONTEXTS,
      'bureau.notifications.list': () => ({ notifications: [failure()], nextPageToken: null }),
    });
    landAt('/agents');
    const { store } = mount();
    await waitFor(() => expect(store.unreadCount).toBe(1));
    const listed = callsTo(bureauStub, 'bureau.notifications.list').length;

    store.markRead('notification:notification-1');

    await waitFor(() => {
      expect(callsTo(bureauStub, 'bureau.notifications.markread')[0]?.params).toEqual({
        ids: ['notification-1'],
      });
      expect(callsTo(bureauStub, 'bureau.notifications.list').length).toBeGreaterThan(listed);
    });
    expect(store.unreadCount).toBe(0);
  });

  test('opening the chat of a failure reads it in the Bureau', async () => {
    const bureauStub = served({
      'bureau.reviews.list': () => ({ reviews: [] }),
      'bureau.tasks.list': () => ({ tasks: [], nextPageToken: null }),
      'bureau.contexts.list': () => FIRE_CONTEXTS,
      'bureau.notifications.list': () => ({ notifications: [failure()], nextPageToken: null }),
    });
    landAt('/chat/session-fire');

    const { store } = mount();

    await waitFor(() => expect(store.items[0]?.read).toBe(true));
    await waitFor(() =>
      expect(callsTo(bureauStub, 'bureau.notifications.markread')[0]?.params).toEqual({
        ids: ['notification-1'],
      }),
    );
  });

  test('a failed schedule fire is named by its schedule, with the Bureau’s first line of its error', async () => {
    served({
      'bureau.reviews.list': () => ({ reviews: [] }),
      'bureau.tasks.list': () => ({ tasks: [], nextPageToken: null }),
      'bureau.contexts.list': () => FIRE_CONTEXTS,
      'bureau.notifications.list': () => ({
        notifications: [
          failure({
            subject: {
              runId: 'run-3',
              contextId: 'session-fire',
              agentName: 'assistant',
              scheduleId: 's-1',
            },
          }),
        ],
        nextPageToken: null,
      }),
      'bureau.schedules.list': () => ({
        schedules: [
          {
            id: 's-1',
            owner: 'anonymous:local',
            agentName: 'assistant',
            inputPreview: null,
            workflowType: 'agentRun',
            description: 'Daily summary',
            cronExpression: '0 9 * * *',
            intervalMs: null,
            status: 'active',
            overlap: 'skip',
            revision: 1,
            nextFireAt: null,
            lastFireAt: null,
            missedFireCount: 0,
            skippedCount: 0,
            createdAt: '2026-10-19T08:00:00.000Z',
            updatedAt: '2026-10-19T08:00:00.000Z',
          },
        ],
        nextOffset: null,
      }),
    });
    landAt('/agents');

    const { store } = mount();

    await waitFor(() => expect(store.items[0]?.title).toBe('Daily summary failed'));
    expect(store.items[0]?.detail).toBe('Provider quota exceeded');
    expect(store.unreadCount).toBe(1);
  });

  test('a Bureau that answers nothing leaves the bell empty', async () => {
    const bureauStub = served({
      'bureau.reviews.list': () => ({ reviews: [] }),
      'bureau.tasks.list': () => ({ tasks: [], nextPageToken: null }),
    });
    landAt('/agents');

    const { store } = mount();

    // Every read has been answered, and nothing in the answers is about the person.
    await waitFor(() => {
      const asked = new Set(bureauStub.calls.map((call) => call.method));
      expect(asked).toEqual(
        new Set([
          'bureau.reviews.list',
          'bureau.tasks.list',
          'bureau.contexts.list',
          'bureau.notifications.list',
        ]),
      );
    });
    expect(store.items).toEqual([]);
    expect(store.unreadCount).toBe(0);
  });
});
