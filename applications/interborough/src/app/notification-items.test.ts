/**
 * `buildNotificationEntries`: what the bell holds for a given state of the Bureau's reviews and
 * notifications (design row 02w): a sentence and a second line for each, waiting items first, one
 * item per chat, and never a run's identifier. A finished chat is not an item.
 */
import { formatTimeOfDay } from '@lostgradient/cinder';
import { describe, expect, test } from 'bun:test';

import type { BureauNotification } from '../lib/bureau-notifications.ts';
import type { BureauReview } from '../lib/bureau-reviews.ts';
import {
  buildNotificationEntries,
  RECENT_RUN_WINDOW_MS,
  type NotificationSources,
} from './notification-items.ts';
import type { MissedFireSource } from './notification-sources.ts';

const NOW = Date.parse('2026-10-23T12:00:00.000Z');

function minutesAgo(minutes: number): string {
  return new Date(NOW - minutes * 60_000).toISOString();
}

function approval(overrides: Partial<Extract<BureauReview, { kind: 'tool-approval' }>> = {}) {
  return {
    source: 'bureau',
    id: 'approval:run-1:call-1',
    runId: 'run-1-6c4d2f8e-0000-4000-8000-0000000009aa',
    agentName: 'tool-runner',
    requestedAt: NOW - 2 * 60_000,
    ageMilliseconds: 120_000,
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
    ...overrides,
  } satisfies BureauReview;
}

function question(overrides: Partial<Extract<BureauReview, { kind: 'human-wait' }>> = {}) {
  return {
    source: 'bureau',
    id: 'human-wait:run-2:environment:0',
    runId: 'run-2-6c4d2f8e-0000-4000-8000-0000000009bb',
    agentName: 'request-human-input',
    requestedAt: NOW - 60_000,
    ageMilliseconds: 60_000,
    status: 'pending',
    kind: 'human-wait',
    sessionId: 'session-release',
    signalName: 'environment',
    prompt: 'Which environment?',
    ...overrides,
  } satisfies BureauReview;
}

function notification(overrides: Partial<BureauNotification> = {}): BureauNotification {
  return {
    id: 'notification-1',
    kind: 'run.failed',
    title: 'echo failed',
    body: 'The model refused',
    link: null,
    subject: { runId: 'run-3', contextId: 'session-echo', agentName: 'echo' },
    createdAt: minutesAgo(3),
    readAt: null,
    dismissedAt: null,
    ...overrides,
  };
}

function sources(overrides: Partial<NotificationSources> = {}): NotificationSources {
  return {
    reviews: [],
    notifications: [],
    chats: new Map<string, string | null>([
      ['session-refund', 'Refund order 1234'],
      ['session-release', 'Ship the release'],
      ['session-echo', 'Hello echo, say this back'],
    ]),
    scheduleNames: new Map(),
    nowMs: NOW,
    ...overrides,
  };
}

describe('buildNotificationEntries', () => {
  test('a host with nothing pending and nothing finished has no items', () => {
    expect(buildNotificationEntries(sources())).toEqual([]);
  });

  test('an approval and a question are two items, a review naming what it asks and whose it is', () => {
    const entries = buildNotificationEntries(sources({ reviews: [approval(), question()] }));

    expect(entries.map(({ kind, title, detail }) => ({ kind, title, detail }))).toEqual([
      {
        kind: 'question',
        title: 'Which environment?',
        detail: 'Waiting for your answer, request-human-input',
      },
      {
        kind: 'approval',
        title: 'Run issue-refund?',
        detail: 'Waiting for your approval, tool-runner',
      },
    ]);
  });

  test('the text of an item holds no run identifier', () => {
    const entries = buildNotificationEntries(sources({ reviews: [approval(), question()] }));
    const text = entries.map((entry) => `${entry.title} ${entry.detail}`).join('\n');

    expect(text).not.toMatch(/run-\d/);
    expect(text).not.toContain('6c4d2f8e');
  });

  test('an item links to its chat, and carries the session so opening the chat can read it', () => {
    const [entry] = buildNotificationEntries(sources({ reviews: [approval()] }));

    expect(entry?.href).toBe('/chats/session-refund');
    expect(entry?.sessionId).toBe('session-refund');
  });

  test('a wait with no session links to the reviews list', () => {
    const { sessionId: _omitted, ...withoutSession } = question();
    const [entry] = buildNotificationEntries(sources({ reviews: [withoutSession] }));

    expect(entry?.href).toBe('/reviews');
    expect(entry?.sessionId).toBeUndefined();
  });

  test('a review keeps the title of its chat, or the words for an untitled one, for a search to find it by', () => {
    const [titled] = buildNotificationEntries(sources({ reviews: [approval()] }));
    const [untitled] = buildNotificationEntries(
      sources({ reviews: [approval()], chats: new Map([['session-refund', null]]) }),
    );

    expect(titled?.chat).toBe('Refund order 1234');
    expect(untitled?.chat).toBe('New chat');
  });

  test('an agent the Bureau does not name is called an agent', () => {
    const [entry] = buildNotificationEntries(
      sources({ reviews: [approval({ agentName: undefined })] }),
    );

    expect(entry?.detail).toBe('Waiting for your approval, An agent');
  });

  test('a review names its agent as the catalog does, and by its identifier where it has no name', () => {
    const names: Record<string, string> = { 'tool-runner': 'Tool runner' };
    const entries = buildNotificationEntries(
      sources({
        reviews: [approval(), question()],
        agentName: (identifier) => names[identifier] ?? identifier,
      }),
    );

    expect(entries.map((entry) => entry.detail)).toEqual([
      'Waiting for your answer, request-human-input',
      'Waiting for your approval, Tool runner',
    ]);
  });

  test('a review’s sentence is what it asks, the way the Reviews page words it', () => {
    const entries = buildNotificationEntries(
      sources({
        reviews: [
          approval({
            approval: {
              callId: 'call-1',
              toolName: 'issue-refund',
              arguments: {},
              action: {
                type: 'approval',
                risk: 'high',
                message: 'Refund order 4471 for $42.00',
                operation: { kind: 'other' },
              },
            },
          }),
          question({ prompt: 'Which environment should the release go to?' }),
        ],
      }),
    );

    expect(entries.map((entry) => entry.title)).toEqual([
      'Which environment should the release go to?',
      'Refund order 4471 for $42.00?',
    ]);
  });

  test('a review that is no longer pending is not an item', () => {
    expect(
      buildNotificationEntries(sources({ reviews: [approval({ status: 'approved' })] })),
    ).toEqual([]);
  });

  test('a failure of a run whose chat the Bureau does not list is not an item', () => {
    const entries = buildNotificationEntries(
      sources({
        notifications: [
          notification({ subject: { runId: 'catalog-failure', contextId: 'another-context' } }),
        ],
      }),
    );

    expect(entries).toEqual([]);
  });

  test('an approval is a different item in the next round the Bureau asks it', () => {
    const [first] = buildNotificationEntries(sources({ reviews: [approval({ round: 0 })] }));
    const [second] = buildNotificationEntries(sources({ reviews: [approval({ round: 1 })] }));

    expect(first?.id).not.toBe(second?.id);
    expect(first?.id).toBe('review:approval:run-1:call-1:0');
    expect(second?.id).toBe('review:approval:run-1:call-1:1');
  });

  test('a question has no round, so its item is its review id', () => {
    const [entry] = buildNotificationEntries(sources({ reviews: [question()] }));

    expect(entry?.id).toBe('review:human-wait:run-2:environment:0');
  });

  test('a chat with several reviews waiting is one item: the one waiting longest', () => {
    const entries = buildNotificationEntries(
      sources({
        reviews: [
          approval({ id: 'approval:run-1:call-2', requestedAt: NOW - 60_000 }),
          approval({ id: 'approval:run-1:call-1', requestedAt: NOW - 120_000 }),
          approval({ id: 'approval:run-1:call-3', requestedAt: NOW - 30_000 }),
        ],
      }),
    );

    expect(entries.map((entry) => entry.id)).toEqual(['review:approval:run-1:call-1:0']);
  });

  test('of a question and an approval asked together in one chat, the approval stands for it', () => {
    const entries = buildNotificationEntries(
      sources({
        reviews: [
          question({ sessionId: 'session-refund', requestedAt: NOW - 60_000 }),
          approval({ requestedAt: NOW - 60_000 }),
        ],
      }),
    );

    expect(entries.map((entry) => entry.kind)).toEqual(['approval']);
  });

  test('reviews in different chats, and reviews with no chat, each stay an item', () => {
    const { sessionId: _omitted, ...withoutSession } = question();
    const entries = buildNotificationEntries(
      sources({
        reviews: [
          approval(),
          question(),
          withoutSession,
          { ...withoutSession, id: 'human-wait:run-9:other:0' },
        ],
      }),
    );

    expect(entries).toHaveLength(4);
  });

  test('a failed run names its agent and its chat, needs the person, and is the Bureau’s record', () => {
    const [entry] = buildNotificationEntries(sources({ notifications: [notification()] }));

    expect(entry).toMatchObject({
      id: 'notification:notification-1',
      notificationId: 'notification-1',
      serverRead: false,
      kind: 'failed',
      tier: 'warning',
      title: 'echo failed',
      detail: 'Hello echo, say this back',
      href: '/chats/session-echo',
      sessionId: 'session-echo',
    });
  });

  test('a run that exceeded its budget is its own kind, worded as such', () => {
    const [entry] = buildNotificationEntries(
      sources({ notifications: [notification({ kind: 'run.budget-exceeded' })] }),
    );

    expect(entry).toMatchObject({
      kind: 'budget',
      tier: 'warning',
      title: 'echo exceeded its budget',
    });
  });

  test('a notification the Bureau holds as read is read here too', () => {
    const [entry] = buildNotificationEntries(
      sources({ notifications: [notification({ readAt: minutesAgo(1) })] }),
    );

    expect(entry?.serverRead).toBe(true);
  });

  test('a read notification older than the window is history, an unread one is not', () => {
    const old = new Date(NOW - RECENT_RUN_WINDOW_MS - 1).toISOString();
    const entries = buildNotificationEntries(
      sources({
        notifications: [
          notification({ id: 'read-old', readAt: old, createdAt: old }),
          notification({ id: 'unread-old', createdAt: old }),
        ],
      }),
    );

    expect(entries.map((entry) => entry.notificationId)).toEqual(['unread-old']);
  });

  test('the Bureau’s review.waiting notification is not listed: the pending review is the item', () => {
    const entries = buildNotificationEntries(
      sources({
        reviews: [approval()],
        notifications: [
          notification({
            kind: 'review.waiting',
            subject: { reviewId: 'approval:run-1:call-1', contextId: 'session-refund' },
          }),
        ],
      }),
    );

    expect(entries.map((entry) => entry.kind)).toEqual(['approval']);
  });

  test('a failure in a chat that is waiting on the person is not also listed', () => {
    const entries = buildNotificationEntries(
      sources({
        reviews: [approval({ sessionId: 'session-echo' })],
        notifications: [notification()],
      }),
    );

    expect(entries.map((entry) => entry.kind)).toEqual(['approval']);
  });

  test('a notification of a kind the Bureau does not write is a notice, with its link and text', () => {
    const [entry] = buildNotificationEntries(
      sources({
        notifications: [
          notification({
            kind: 'hook.note',
            title: 'The backup finished',
            body: '3 files',
            link: '/runs',
            subject: null,
          }),
        ],
      }),
    );

    expect(entry).toMatchObject({
      kind: 'notice',
      tier: 'warning',
      title: 'The backup finished',
      detail: '3 files',
      href: '/runs',
    });
  });

  test('a notice never links off the app', () => {
    const [entry] = buildNotificationEntries(
      sources({
        notifications: [
          notification({ kind: 'hook.note', link: 'https://example.com/x', subject: null }),
        ],
      }),
    );

    expect(entry?.href).toBe('/');
  });

  test('a failed schedule fire names the schedule and gives the Bureau’s first line of its error', () => {
    const [entry] = buildNotificationEntries(
      sources({
        notifications: [
          notification({
            body: 'Provider quota exceeded',
            subject: { runId: 'run-3', contextId: 'session-echo', scheduleId: 's-1' },
          }),
        ],
        scheduleNames: new Map([['s-1', { name: 'Daily summary', identifier: false }]]),
      }),
    );

    expect(entry).toMatchObject({
      kind: 'failed',
      title: 'Daily summary failed',
      detail: 'Provider quota exceeded',
    });
  });

  test('a schedule named by its agent goes by the agent’s display name, and one named by its description is prose', () => {
    const [byAgent] = buildNotificationEntries(
      sources({
        notifications: [
          notification({ subject: { contextId: 'session-echo', scheduleId: 's-1' } }),
        ],
        scheduleNames: new Map([['s-1', { name: 'assistant', identifier: true }]]),
        agentName: (identifier) => (identifier === 'assistant' ? 'Assistant' : identifier),
      }),
    );

    expect(byAgent).toMatchObject({ title: 'Assistant failed' });
  });

  test('a failed fire whose schedule is unknown is worded as a failed run of its agent', () => {
    const [entry] = buildNotificationEntries(
      sources({
        notifications: [
          notification({
            subject: { contextId: 'session-echo', agentName: 'echo', scheduleId: 's-gone' },
          }),
        ],
      }),
    );

    expect(entry?.title).toBe('echo failed');
  });

  test('approvals, questions and failures are warnings', () => {
    const entries = buildNotificationEntries(
      sources({
        reviews: [approval(), question()],
        chats: new Map([['two', null]]),
        notifications: [notification({ subject: { contextId: 'two', agentName: 'echo' } })],
      }),
    );

    expect(Object.fromEntries(entries.map((entry) => [entry.kind, entry.tier]))).toEqual({
      approval: 'warning',
      question: 'warning',
      failed: 'warning',
    });
  });
});

describe('the fires a schedule missed', () => {
  /** The `time` clock reading of `milliseconds` in the zone the test runs in, as the item words it. */
  const clock = (milliseconds: number): string => formatTimeOfDay(milliseconds);
  const day = (milliseconds: number): string =>
    new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(milliseconds);

  const fire = (
    occurrence: number,
    overrides: { count?: number; reason?: 'late' | 'dst-gap'; recordedMinutesAgo?: number } = {},
  ) => ({
    occurrence,
    reason: overrides.reason ?? ('late' as const),
    count: overrides.count ?? 1,
    recordedAt: NOW - (overrides.recordedMinutesAgo ?? 30) * 60_000,
  });

  const missed = (
    overrides: { recordedMinutesAgo?: number; reason?: 'late' | 'dst-gap' } = {},
  ): MissedFireSource => ({
    scheduleId: 's-1',
    name: { name: 'Nightly digest', identifier: false },
    agentName: 'assistant',
    fires: [fire(NOW - 90 * 60_000, overrides)],
  });

  test('is an item that names the schedule and its due time, says how many, and opens it', () => {
    const [entry] = buildNotificationEntries(sources({ missedFires: [missed()] }));

    expect(entry).toMatchObject({
      kind: 'missed',
      tier: 'warning',
      icon: 'calendar-x',
      title: `Nightly digest missed its ${clock(NOW - 90 * 60_000)} run`,
      detail: `1 missed since ${day(NOW - 90 * 60_000)}, assistant`,
      href: '/schedules/s-1',
      emittedAtMs: NOW - 90 * 60_000,
    });
    expect(entry?.id).toBe(`schedule-missed:s-1:${String(NOW - 90 * 60_000)}`);
  });

  test('is one item for all the fires a schedule missed: how many, since the oldest, at the newest’s time', () => {
    const oldest = NOW - 4 * 24 * 3_600_000;
    const newest = NOW - 7 * 3_600_000;
    const [entry, ...rest] = buildNotificationEntries(
      sources({
        missedFires: [
          {
            ...missed(),
            fires: [
              fire(newest),
              fire(NOW - 24 * 3_600_000),
              fire(NOW - 2 * 24 * 3_600_000, { count: 2 }),
              fire(oldest, { count: 1 }),
            ],
          },
        ],
      }),
    );

    expect(rest).toEqual([]);
    expect(entry?.title).toBe(`Nightly digest missed its ${clock(newest)} run`);
    expect(entry?.detail).toBe(`5 missed since ${day(oldest)}, assistant`);
    expect(entry?.emittedAtMs).toBe(newest);
  });

  test('names the schedule and the agent as the catalog does when the schedule has no description', () => {
    const [entry] = buildNotificationEntries(
      sources({
        missedFires: [{ ...missed(), name: { name: 'assistant', identifier: true } }],
        agentName: (identifier) => (identifier === 'assistant' ? 'Assistant' : identifier),
      }),
    );

    expect(entry?.title).toMatch(/^Assistant missed its /);
    expect(entry?.detail).toMatch(/, Assistant$/);
  });

  test('says when the one fire missed was skipped by a clock change', () => {
    const [entry] = buildNotificationEntries(
      sources({ missedFires: [missed({ reason: 'dst-gap' })] }),
    );

    expect(entry?.detail).toBe('Its time was skipped by a clock change, assistant');
  });

  test('is news for a day, and history after', () => {
    const recent = missed({ recordedMinutesAgo: 60 * 23 });
    const old = { ...missed({ recordedMinutesAgo: 60 * 25 }), scheduleId: 's-2' };

    const entries = buildNotificationEntries(sources({ missedFires: [recent, old] }));

    expect(entries.map((entry) => entry.href)).toEqual(['/schedules/s-1']);
  });

  test('a later miss of the same schedule is a new item, so it is unread again', () => {
    const first = buildNotificationEntries(sources({ missedFires: [missed()] }))[0];
    const later = buildNotificationEntries(
      sources({ missedFires: [{ ...missed(), fires: [fire(NOW - 60_000)] }] }),
    )[0];

    expect(first?.id).not.toBe(later?.id);
  });

  test('counts as needing the person, ahead of a standing item', () => {
    const entries = buildNotificationEntries(
      sources({
        alerts: [{ metric: 'storage.size', at: NOW - 60_000, currentValue: 1024 ** 3 }],
        missedFires: [missed()],
      }),
    );

    expect(entries.map((entry) => [entry.kind, entry.tier])).toEqual([
      ['missed', 'warning'],
      ['alert', 'info'],
    ]);
  });
});

describe('a rule of the host’s that is firing', () => {
  const GIGABYTE = 1024 ** 3;
  const storage = { metric: 'storage.size', at: NOW - 100 * 60_000, currentValue: 1.6 * GIGABYTE };

  test('storage over its warning level is an item that says how much is used, and links to Health', () => {
    const [entry] = buildNotificationEntries(sources({ alerts: [storage] }));

    expect(entry).toMatchObject({
      kind: 'alert',
      title: 'Storage passed its warning level',
      detail: '1.6 GB used',
      href: '/health',
      emittedAtMs: storage.at,
    });
  });

  test('is a standing condition: read, and never needing the person', () => {
    const [entry] = buildNotificationEntries(sources({ alerts: [storage] }));

    expect(entry).toMatchObject({ tier: 'info', standing: true });
  });

  test('a rule the bell does not word is Health’s alone', () => {
    const entries = buildNotificationEntries(
      sources({ alerts: [{ metric: 'runs.failed', at: NOW, currentValue: 3 }] }),
    );

    expect(entries).toEqual([]);
  });

  test('comes after what waits on the person and after the failures and missed schedules', () => {
    const entries = buildNotificationEntries(
      sources({
        reviews: [approval()],
        notifications: [notification()],
        alerts: [storage],
      }),
    );

    expect(entries.map((entry) => entry.kind)).toEqual(['approval', 'failed', 'alert']);
  });

  test('lists what waits on the person first, then failures and missed schedules, whatever their times', () => {
    const entries = buildNotificationEntries(
      sources({
        reviews: [approval({ requestedAt: NOW - 6 * 3_600_000 })],
        notifications: [notification({ createdAt: minutesAgo(1) })],
        missedFires: [
          {
            scheduleId: 's-1',
            name: { name: 'Nightly digest', identifier: false },
            agentName: 'assistant',
            fires: [
              { occurrence: NOW - 3_600_000, reason: 'late', count: 1, recordedAt: NOW - 60_000 },
            ],
          },
        ],
      }),
    );

    expect(entries.map((entry) => entry.kind)).toEqual(['approval', 'failed', 'missed']);
  });
});
