/**
 * The feed that connects the notification store to the Bureau: what is waiting on the person
 * become the store's items, a decision made elsewhere removes its item at once, and opening a chat
 * reads what is about it. A chat that finished is not an item: nothing is waiting on the person.
 */
import { formatTimeOfDay } from '@lostgradient/cinder';
import { quietFor } from '@lostgradient/testing/wait-until';
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

const AGENT = {
  name: 'echo',
  displayName: 'Echo',
  description: null,
  definitionRevision: 1,
  kind: 'code',
  a2a: false,
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

function schedule(overrides: Record<string, unknown> = {}) {
  return {
    id: 's-1',
    owner: 'anonymous:local',
    agentName: 'assistant',
    inputPreview: null,
    workflowType: 'agentRun',
    description: null,
    cronExpression: '0 9 * * *',
    intervalMs: null,
    status: 'active',
    overlap: 'skip',
    revision: 1,
    timeZone: 'UTC',
    nextFireAt: null,
    skipUntil: null,
    lastFireAt: null,
    missedFireCount: 0,
    skippedCount: 0,
    createdAt: '2026-10-19T08:00:00.000Z',
    updatedAt: '2026-10-19T08:00:00.000Z',
    ...overrides,
  };
}

const CONTEXTS = {
  contexts: [
    context('session-refund', 'Refund order 1234'),
    context('session-echo', 'Hello echo, say this back'),
  ],
  nextOffset: null,
};

/**
 * The Bureau as a host with one pending approval and one chat that finished, which the bell does
 * not list. Its tasks are served all the same, so a feed that read them would show the chat.
 */
function served(overrides: Record<string, (params: Record<string, unknown>) => unknown> = {}) {
  let reviews: unknown[] = [APPROVAL];
  const bureauStub = bureau({
    'bureau.reviews.list': () => ({ reviews }),
    'bureau.tasks.list': () => ({ tasks: [ECHO_TASK], nextPageToken: null }),
    'bureau.contexts.list': () => CONTEXTS,
    'bureau.notifications.list': () => ({ notifications: [], nextPageToken: null }),
    'bureau.schedules.list': () => ({ schedules: [], nextOffset: null }),
    'bureau.health.attention': () => ({ items: [], count: 0, checks: [] }),
    'bureau.agents.list': () => ({ agents: [] }),
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

function mount(client: QueryClient = createQueryClient(), canReadSchedules = true) {
  const store = memoryStore();
  render(QueryPage, {
    props: { page: FeedHarness, pageProps: { store, canReadSchedules }, client },
  } as never);
  return { store, client };
}

describe('connectNotificationFeed', () => {
  test('lists the pending approval and not the chat that finished, which nothing waits on', async () => {
    const bureauStub = served();
    landAt('/agents');

    const { store } = mount();

    await waitFor(() => expect(store.items).toHaveLength(1));
    expect(store.items.map(({ kind, title, detail }) => ({ kind, title, detail }))).toEqual([
      {
        kind: 'approval',
        title: 'Run issue-refund?',
        detail: 'Waiting for your approval · Tool runner',
      },
    ]);
    expect(store.unreadCount).toBe(1);
    // The finished chat is not read at all: the recent tasks feed no item.
    expect(callsTo(bureauStub, 'bureau.tasks.list')).toHaveLength(0);
  });

  test('names an agent by the catalog’s display name once the catalog arrives', async () => {
    served({
      'bureau.agents.list': () => ({
        agents: [{ ...AGENT, name: 'tool-runner', displayName: 'Refund desk' }],
      }),
    });
    landAt('/agents');

    const { store } = mount();

    await waitFor(() =>
      expect(store.items.find((item) => item.kind === 'approval')?.detail).toBe(
        'Waiting for your approval · Refund desk',
      ),
    );
  });

  test('a display name that is only an identifier reads in words', async () => {
    served({
      'bureau.agents.list': () => ({
        agents: [{ ...AGENT, name: 'demo:tool-runner', displayName: 'tool-runner' }],
      }),
      'bureau.reviews.list': () => ({ reviews: [{ ...APPROVAL, agentName: 'demo:tool-runner' }] }),
    });
    landAt('/agents');

    const { store } = mount();

    await waitFor(() =>
      expect(store.items.find((item) => item.kind === 'approval')?.detail).toBe(
        'Waiting for your approval · Tool runner',
      ),
    );
  });

  test('lists the storage rule that is firing, read, and does not count', async () => {
    const bureauStub = served({
      'bureau.reviews.list': () => ({ reviews: [] }),
      'bureau.health.attention': () => ({
        items: [
          {
            kind: 'alert',
            area: 'storage',
            at: NOW - 3_600_000,
            metric: 'storage.size',
            currentValue: 1.6 * 1024 ** 3,
            threshold: 1024 ** 3,
          },
          { kind: 'no-provider', area: 'providers', at: null, provider: null },
        ],
        count: 2,
        checks: [],
      }),
    });
    landAt('/agents');

    const { store } = mount();

    await waitFor(() => expect(store.items.map((item) => item.kind)).toEqual(['alert']));
    expect(store.items[0]).toMatchObject({
      title: 'Storage passed its warning level',
      detail: '1.6 GB used',
      read: true,
    });
    expect(store.unreadCount).toBe(0);
    expect(callsTo(bureauStub, 'bureau.health.attention')).not.toHaveLength(0);
  });

  test('a caller the Bureau refuses the attention list gets no such item, and the bell is not failed', async () => {
    served({
      'bureau.health.attention': () => {
        throw new Error('refused');
      },
    });
    landAt('/agents');

    const { store } = mount();

    await waitFor(() => expect(store.items.map((item) => item.kind)).toContain('approval'));
    expect(store.items.map((item) => item.kind)).not.toContain('alert');
    expect(store.loadFailed).toBe(false);
  });

  test('an approval decided elsewhere leaves the list and the count at the next read', async () => {
    const bureauStub = served();
    landAt('/agents');
    const { store, client } = mount();
    await waitFor(() => expect(store.unreadCount).toBe(1));

    bureauStub.decide();
    await invalidateReviewQueries(client);

    await waitFor(() => expect(store.items).toEqual([]));
    expect(store.unreadCount).toBe(0);
  });

  test('opening a chat reads what is about it', async () => {
    served();
    landAt('/chats/session-refund');
    const first = mount();
    await waitFor(() => expect(first.store.items).toHaveLength(1));
    expect(first.store.items.find((item) => item.kind === 'approval')?.read).toBe(true);
    expect(first.store.unreadCount).toBe(0);
    cleanup();

    landAt('/chats/session-echo');
    const second = mount();

    await waitFor(() => expect(second.store.items).toHaveLength(1));
    expect(second.store.items.find((item) => item.kind === 'approval')?.read).toBe(false);
    expect(second.store.unreadCount).toBe(1);
  });

  test('a chat that is only about to start is not an open chat', async () => {
    served();
    landAt('/chats/new');

    const { store } = mount();

    await waitFor(() => expect(store.items).toHaveLength(1));
    expect(store.unreadCount).toBe(1);
  });

  function failure(overrides: Record<string, unknown> = {}) {
    return {
      id: 'notification-1',
      kind: 'run.failed',
      title: 'Assistant failed',
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
      'bureau.contexts.list': () => FIRE_CONTEXTS,
      'bureau.notifications.list': () => ({ notifications: [failure()], nextPageToken: null }),
    });
    landAt('/agents');

    const { store } = mount();

    await waitFor(() => expect(store.items).toHaveLength(1));
    expect(store.items[0]).toMatchObject({
      kind: 'failed',
      title: 'Assistant failed',
      detail: 'Nightly digest',
      read: false,
    });
    expect(store.unreadCount).toBe(1);
  });

  test('a notification the Bureau holds as read is read, and a run over its budget says so', async () => {
    served({
      'bureau.reviews.list': () => ({ reviews: [] }),
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
      title: 'Assistant exceeded its budget',
      read: true,
    });
    expect(store.unreadCount).toBe(0);
  });

  test('reading a notification in the bell reads it in the Bureau, and asks for the list again', async () => {
    const bureauStub = served({
      'bureau.reviews.list': () => ({ reviews: [] }),
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
      'bureau.contexts.list': () => FIRE_CONTEXTS,
      'bureau.notifications.list': () => ({ notifications: [failure()], nextPageToken: null }),
    });
    landAt('/chats/session-fire');

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
            timeZone: 'UTC',
            nextFireAt: null,
            skipUntil: null,
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
    });
    landAt('/agents');

    const { store } = mount();

    // Every read has been answered, and nothing in the answers is about the person.
    await waitFor(() => {
      const asked = new Set(bureauStub.calls.map((call) => call.method));
      expect(asked).toEqual(
        new Set([
          'bureau.reviews.list',
          'bureau.contexts.list',
          'bureau.notifications.list',
          'bureau.schedules.list',
          'bureau.health.attention',
          'bureau.agents.list',
        ]),
      );
    });
    expect(store.items).toEqual([]);
    expect(store.unreadCount).toBe(0);
    expect(store.loadFailed).toBe(false);
  });

  test('a Bureau that cannot be read is not an empty one: the store says the list failed', async () => {
    served({
      'bureau.reviews.list': () => {
        throw new Error('the Bureau did not answer');
      },
    });
    landAt('/agents');

    const { store } = mount();

    await waitFor(() => expect(store.loadFailed).toBe(true));
    expect(store.items.map((item) => item.kind)).not.toContain('approval');
  });

  test('reloading reads the Bureau again, and a list that then loads is no longer failed', async () => {
    let answering = false;
    const bureauStub = served({
      'bureau.reviews.list': () => {
        if (!answering) throw new Error('the Bureau did not answer');
        return { reviews: [APPROVAL] };
      },
    });
    landAt('/agents');
    const { store } = mount();
    await waitFor(() => expect(store.loadFailed).toBe(true));
    const before = callsTo(bureauStub, 'bureau.reviews.list').length;

    answering = true;
    store.reload();

    await waitFor(() => expect(store.loadFailed).toBe(false));
    expect(callsTo(bureauStub, 'bureau.reviews.list').length).toBeGreaterThan(before);
    expect(store.items.map((item) => item.kind)).toContain('approval');
  });

  test('reloading does not ask for schedules a principal may not read', async () => {
    let answering = false;
    const bureauStub = served({
      'bureau.reviews.list': () => {
        if (!answering) throw new Error('the Bureau did not answer');
        return { reviews: [APPROVAL] };
      },
    });
    landAt('/agents');
    const { store } = mount(createQueryClient(), false);
    await waitFor(() => expect(store.loadFailed).toBe(true));

    answering = true;
    store.reload();

    await waitFor(() => expect(store.loadFailed).toBe(false));
    expect(callsTo(bureauStub, 'bureau.schedules.list')).toHaveLength(0);
  });

  test('a schedule that missed a fire is an item that opens the schedule', async () => {
    const bureauStub = served({
      'bureau.reviews.list': () => ({ reviews: [] }),
      'bureau.schedules.list': () => ({
        schedules: [
          schedule({ id: 's-quiet', missedFireCount: 0 }),
          schedule({ id: 's-late', description: 'Nightly digest', missedFireCount: 2 }),
        ],
        nextOffset: null,
      }),
      'bureau.schedules.missed': () => ({
        missed: [
          {
            occurrence: new Date(NOW - 3_600_000).toISOString(),
            reason: 'late',
            count: 1,
            recordedAt: new Date(NOW - 3_000_000).toISOString(),
          },
        ],
      }),
    });
    landAt('/agents');

    const { store } = mount();

    await waitFor(() => expect(store.items.map((item) => item.kind)).toContain('missed'));
    const missed = store.items.find((item) => item.kind === 'missed');
    expect(missed?.title).toBe(`Nightly digest missed its ${formatTimeOfDay(NOW - 3_600_000)} run`);
    expect(missed?.detail).toMatch(/^1 missed since [A-Z][a-z]{2} \d{1,2} · Assistant$/);
    expect(missed?.href).toBe('/schedules/s-late');
    expect(store.unreadCount).toBe(1);
    // Only the schedule that missed a fire is asked about.
    expect(callsTo(bureauStub, 'bureau.schedules.missed').map((call) => call.params)).toEqual([
      { scheduleId: 's-late' },
    ]);
  });

  test('a miss older than a day is history, not news', async () => {
    served({
      'bureau.reviews.list': () => ({ reviews: [] }),
      'bureau.schedules.list': () => ({
        schedules: [schedule({ id: 's-old', missedFireCount: 1 })],
        nextOffset: null,
      }),
      'bureau.schedules.missed': () => ({
        missed: [
          {
            occurrence: new Date(NOW - 3 * 86_400_000).toISOString(),
            reason: 'dst-gap',
            count: 1,
            recordedAt: new Date(NOW - 3 * 86_400_000).toISOString(),
          },
        ],
      }),
    });
    landAt('/agents');

    const { store } = mount();

    await waitFor(() => expect(store.loadFailed).toBe(false));
    await waitFor(() => expect(store.items).toEqual([]));
  });

  test('"mark all read" asks the Bureau to read every notification, not only the newest it listed', async () => {
    const many = Array.from({ length: 230 }, (_, index) =>
      failure({ id: `notification-${String(index)}` }),
    );
    const bureauStub = served({
      'bureau.reviews.list': () => ({ reviews: [] }),
      'bureau.contexts.list': () => FIRE_CONTEXTS,
      'bureau.notifications.list': () => ({ notifications: many, nextPageToken: null }),
    });
    landAt('/agents');
    const { store } = mount();
    await waitFor(() => expect(store.items).toHaveLength(230));

    store.markAllRead();

    await waitFor(() =>
      expect(callsTo(bureauStub, 'bureau.notifications.markread')).toHaveLength(1),
    );
    expect(callsTo(bureauStub, 'bureau.notifications.markread')[0]?.params).toEqual({ all: true });
  });

  test('an open chat whose read the Bureau refuses is asked once, and says so', async () => {
    const bureauStub = served({
      'bureau.reviews.list': () => ({ reviews: [] }),
      'bureau.contexts.list': () => FIRE_CONTEXTS,
      'bureau.notifications.list': () => ({ notifications: [failure()], nextPageToken: null }),
      'bureau.notifications.markread': () => {
        throw new Error('the Bureau did not answer');
      },
    });
    landAt('/chats/session-fire');

    const { store } = mount();

    await waitFor(() => expect(store.readFailed).toBe(true));
    await quietFor(50);
    expect(callsTo(bureauStub, 'bureau.notifications.markread')).toHaveLength(1);
    expect(store.items[0]?.read).toBe(false);
  });

  test('a mark-as-read the Bureau refuses leaves the items unread, and says so', async () => {
    served({
      'bureau.reviews.list': () => ({ reviews: [] }),
      'bureau.contexts.list': () => FIRE_CONTEXTS,
      'bureau.notifications.list': () => ({ notifications: [failure()], nextPageToken: null }),
      'bureau.notifications.markread': () => {
        throw new Error('the Bureau did not answer');
      },
    });
    landAt('/agents');
    const { store } = mount();
    await waitFor(() => expect(store.unreadCount).toBe(1));

    store.markAllRead();

    await waitFor(() => expect(store.readFailed).toBe(true));
    expect(store.unreadCount).toBe(1);
    expect(store.items[0]?.read).toBe(false);
  });
});
