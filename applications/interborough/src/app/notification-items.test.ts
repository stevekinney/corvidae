/**
 * `buildNotificationEntries`: what the bell holds for a given state of the Bureau's reviews and
 * tasks. Four kinds, one item per chat, and never a run's identifier.
 */
import { describe, expect, test } from 'bun:test';

import type { BureauNotification } from '../lib/bureau-notifications.ts';
import type { BureauReview } from '../lib/bureau-reviews.ts';
import type { TaskView } from '../lib/bureau-tasks.ts';
import {
  buildNotificationEntries,
  RECENT_RUN_WINDOW_MS,
  type NotificationSources,
} from './notification-items.ts';

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

function task(overrides: Partial<TaskView> = {}): TaskView {
  return {
    id: 'run-3-6c4d2f8e-0000-4000-8000-0000000009cc',
    contextId: 'session-echo',
    agentName: 'echo',
    owner: 'anonymous:local',
    actor: null,
    kind: 'chat',
    status: 'completed',
    finishReason: 'stop-condition',
    statusMessage: null,
    createdAt: minutesAgo(3),
    updatedAt: minutesAgo(3),
    cleanup: null,
    openWaits: [],
    ...overrides,
  };
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
    tasks: [],
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

  test('an approval, a question and an answer are three items, each naming its chat', () => {
    const entries = buildNotificationEntries(
      sources({ reviews: [approval(), question()], tasks: [task()] }),
    );

    expect(entries.map(({ kind, title, detail }) => ({ kind, title, detail }))).toEqual([
      {
        kind: 'question',
        title: 'request-human-input asked a question',
        detail: 'Ship the release',
      },
      { kind: 'approval', title: 'tool-runner needs your approval', detail: 'Refund order 1234' },
      { kind: 'answered', title: 'echo answered', detail: 'Hello echo, say this back' },
    ]);
  });

  test('what needs the person comes before what only finished, newest first in each group', () => {
    const entries = buildNotificationEntries(
      sources({
        reviews: [approval(), question()],
        tasks: [task({ updatedAt: minutesAgo(0) })],
      }),
    );

    expect(entries.map((entry) => entry.kind)).toEqual(['question', 'approval', 'answered']);
  });

  test('the text of an item holds no run identifier', () => {
    const entries = buildNotificationEntries(
      sources({ reviews: [approval(), question()], tasks: [task()] }),
    );
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

  test('a chat with no title is called by the words for an untitled chat', () => {
    const [entry] = buildNotificationEntries(
      sources({ reviews: [approval()], chats: new Map([['session-refund', null]]) }),
    );

    expect(entry?.detail).toBe('New chat');
  });

  test('an agent the Bureau does not name is called an agent', () => {
    const [entry] = buildNotificationEntries(
      sources({ reviews: [approval({ agentName: undefined })] }),
    );

    expect(entry?.title).toBe('An agent needs your approval');
  });

  test('a review that is no longer pending is not an item', () => {
    expect(
      buildNotificationEntries(sources({ reviews: [approval({ status: 'approved' })] })),
    ).toEqual([]);
  });

  test('a run whose chat the Bureau does not list is not an item, finished or failed', () => {
    const entries = buildNotificationEntries(
      sources({
        tasks: [task({ id: 'catalog-run', contextId: 'context-with-no-chat' })],
        notifications: [
          notification({ subject: { runId: 'catalog-failure', contextId: 'another-context' } }),
        ],
      }),
    );

    expect(entries).toEqual([]);
  });

  test('a run in a chat with no title is an item, called by the words for an untitled chat', () => {
    const [entry] = buildNotificationEntries(
      sources({ tasks: [task()], chats: new Map([['session-echo', null]]) }),
    );

    expect(entry).toMatchObject({ kind: 'answered', detail: 'New chat' });
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

  test('an answer is an item whichever chat the person is in', () => {
    // The feed reads the items about the open chat on arrival; the items do not know which is open.
    const entries = buildNotificationEntries(sources({ tasks: [task()] }));

    expect(entries.map((entry) => entry.sessionId)).toEqual(['session-echo']);
  });

  test('the agent a title names is set in monospace, however plain its name', () => {
    const entries = buildNotificationEntries(
      sources({
        reviews: [
          approval(),
          approval({ id: 'a2', sessionId: 'session-release', agentName: undefined }),
        ],
        tasks: [task()],
      }),
    );

    expect(entries.map((entry) => entry.identifiers)).toEqual([['tool-runner'], [], ['echo']]);
  });

  test('a chat is one answer: its latest run stands for the earlier ones', () => {
    const entries = buildNotificationEntries(
      sources({
        tasks: [
          task({ id: 'run-old', updatedAt: minutesAgo(30) }),
          task({ id: 'run-new', updatedAt: minutesAgo(1) }),
        ],
      }),
    );

    expect(entries.map(({ kind, id }) => ({ kind, id }))).toEqual([
      { kind: 'answered', id: 'task:run-new' },
    ]);
  });

  test('a chat waiting on the person is not also listed as answered', () => {
    const entries = buildNotificationEntries(
      sources({
        reviews: [approval({ sessionId: 'session-echo' })],
        tasks: [task({ updatedAt: minutesAgo(5) })],
      }),
    );

    expect(entries.map((entry) => entry.kind)).toEqual(['approval']);
  });

  test('a run that is still going or was canceled is not news', () => {
    const entries = buildNotificationEntries(
      sources({
        tasks: [
          task({ id: 'a', contextId: 'one', status: 'working' }),
          task({ id: 'b', contextId: 'two', status: 'canceled' }),
          task({ id: 'c', contextId: 'three', status: 'input-required' }),
        ],
      }),
    );

    expect(entries).toEqual([]);
  });

  test('a run that finished before the window is history, not news', () => {
    const old = new Date(NOW - RECENT_RUN_WINDOW_MS - 1).toISOString();

    expect(buildNotificationEntries(sources({ tasks: [task({ updatedAt: old })] }))).toEqual([]);
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
      identifiers: ['echo'],
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
      identifiers: [],
      detail: 'Provider quota exceeded',
      joiner: ': ',
    });
  });

  test('a schedule named by its agent is an identifier, and one named by its description is prose', () => {
    const [byAgent] = buildNotificationEntries(
      sources({
        notifications: [
          notification({ subject: { contextId: 'session-echo', scheduleId: 's-1' } }),
        ],
        scheduleNames: new Map([['s-1', { name: 'assistant', identifier: true }]]),
      }),
    );

    expect(byAgent).toMatchObject({ title: 'assistant failed', identifiers: ['assistant'] });
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

  test('a run a parent run, a goal or an agent started is not an answer', () => {
    const entries = buildNotificationEntries(
      sources({
        tasks: [
          task({ id: 'a', contextId: 'one', origin: { kind: 'agent' } }),
          task({ id: 'b', contextId: 'two', origin: { kind: 'goal' } }),
          task({ id: 'c', contextId: 'three', origin: { kind: 'parent' } }),
          task({ id: 'd', contextId: 'four', origin: { kind: 'chat' } }),
        ],
        chats: new Map([
          ['one', null],
          ['two', null],
          ['three', null],
          ['four', null],
        ]),
      }),
    );

    expect(entries.map((entry) => entry.id)).toEqual(['task:d']);
  });

  test('a run that failed is no answer, and the notification is what tells of it', () => {
    const entries = buildNotificationEntries(sources({ tasks: [task({ status: 'failed' })] }));

    expect(entries).toEqual([]);
  });

  test('an answer is info, and approvals, questions and failures are not', () => {
    const entries = buildNotificationEntries(
      sources({
        reviews: [approval(), question()],
        chats: new Map([
          ['one', null],
          ['two', null],
        ]),
        tasks: [task({ id: 'a', contextId: 'one' })],
        notifications: [notification({ subject: { contextId: 'two', agentName: 'echo' } })],
      }),
    );

    expect(Object.fromEntries(entries.map((entry) => [entry.kind, entry.tier]))).toEqual({
      approval: 'warning',
      question: 'warning',
      failed: 'warning',
      answered: 'info',
    });
  });
});

describe('the fires a schedule missed', () => {
  const missed = (
    overrides: { recordedMinutesAgo?: number; reason?: 'late' | 'dst-gap' } = {},
  ) => ({
    scheduleId: 's-1',
    name: { name: 'Nightly digest', identifier: false },
    missed: {
      occurrence: NOW - 90 * 60_000,
      reason: overrides.reason ?? 'late',
      count: 1,
      recordedAt: NOW - (overrides.recordedMinutesAgo ?? 30) * 60_000,
    },
  });

  test('is an item that names the schedule, says why, and opens it', () => {
    const [entry] = buildNotificationEntries(sources({ missedFires: [missed()] }));

    expect(entry).toMatchObject({
      kind: 'missed',
      tier: 'warning',
      icon: 'calendar-x',
      title: 'Nightly digest missed a run',
      detail: 'The host was down or too slow to start it',
      href: '/schedules/s-1',
      identifiers: [],
    });
    expect(entry?.id).toBe(`schedule-missed:s-1:${String(NOW - 90 * 60_000)}`);
  });

  test('says when the time was skipped by a clock change, and sets an agent’s name in monospace', () => {
    const [entry] = buildNotificationEntries(
      sources({
        missedFires: [
          { ...missed({ reason: 'dst-gap' }), name: { name: 'assistant', identifier: true } },
        ],
      }),
    );

    expect(entry?.detail).toBe('Its time was skipped by a clock change');
    expect(entry?.identifiers).toEqual(['assistant']);
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
      sources({
        missedFires: [{ ...missed(), missed: { ...missed().missed, occurrence: NOW - 60_000 } }],
      }),
    )[0];

    expect(first?.id).not.toBe(later?.id);
  });

  test('counts as needing the person, ahead of an answer', () => {
    const entries = buildNotificationEntries(
      sources({
        chats: new Map([['one', null]]),
        tasks: [task({ id: 'a', contextId: 'one' })],
        missedFires: [missed()],
      }),
    );

    expect(entries.map((entry) => [entry.kind, entry.tier])).toEqual([
      ['missed', 'warning'],
      ['answered', 'info'],
    ]);
  });
});
