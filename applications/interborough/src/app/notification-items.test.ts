/**
 * `buildNotificationEntries`: what the bell holds for a given state of the Bureau's reviews and
 * tasks. Four kinds, one item per chat, and never a run's identifier.
 */
import { describe, expect, test } from 'bun:test';

import type { BureauReview } from '../lib/bureau-reviews.ts';
import type { TaskView } from '../lib/bureau-tasks.ts';
import {
  buildNotificationEntries,
  firstErrorLine,
  RECENT_RUN_WINDOW_MS,
  type NotificationSources,
} from './notification-items.ts';

const NOW = Date.parse('2026-10-23T12:00:00.000Z');

function minutesAgo(minutes: number): string {
  return new Date(NOW - minutes * 60_000).toISOString();
}

function approval(overrides: Partial<Extract<BureauReview, { kind: 'tool-approval' }>> = {}) {
  return {
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

function sources(overrides: Partial<NotificationSources> = {}): NotificationSources {
  return {
    reviews: [],
    tasks: [],
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

    expect(entry?.href).toBe('/chat/session-refund');
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
        tasks: [
          task({ id: 'catalog-run', contextId: 'context-with-no-chat' }),
          task({ id: 'catalog-failure', contextId: 'another-context', status: 'failed' }),
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

  test('a chat is one item: its latest run stands for the earlier ones', () => {
    const entries = buildNotificationEntries(
      sources({
        tasks: [
          task({
            id: 'run-old',
            status: 'failed',
            statusMessage: 'Boom',
            updatedAt: minutesAgo(30),
          }),
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

  test('a failed run names its agent and its chat, and needs the person', () => {
    const [entry] = buildNotificationEntries(
      sources({ tasks: [task({ status: 'failed', statusMessage: 'The model refused' })] }),
    );

    expect(entry).toMatchObject({
      kind: 'failed',
      tier: 'warning',
      title: 'echo failed',
      detail: 'Hello echo, say this back',
    });
  });

  test('a failed schedule fire names the schedule and gives the first line of its error', () => {
    const failed = task({
      status: 'failed',
      actor: 'service:scheduler',
      statusMessage: '\n  Provider quota exceeded\nat generate (provider.ts:12)',
    });
    const [entry] = buildNotificationEntries(
      sources({
        tasks: [failed],
        scheduleNames: new Map([[failed.id, { name: 'Daily summary', identifier: false }]]),
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
    const failed = task({ status: 'failed', actor: 'service:scheduler' });
    const [byAgent] = buildNotificationEntries(
      sources({
        tasks: [failed],
        scheduleNames: new Map([[failed.id, { name: 'assistant', identifier: true }]]),
      }),
    );

    expect(byAgent).toMatchObject({ title: 'assistant failed', identifiers: ['assistant'] });
  });

  test('a failed fire whose schedule is unknown is worded as a failed run of its agent', () => {
    const [entry] = buildNotificationEntries(
      sources({ tasks: [task({ status: 'failed', actor: 'service:scheduler' })] }),
    );

    expect(entry?.title).toBe('echo failed');
  });

  test('an answer is info, and approvals, questions and failures are not', () => {
    const entries = buildNotificationEntries(
      sources({
        reviews: [approval(), question()],
        chats: new Map([
          ['one', null],
          ['two', null],
        ]),
        tasks: [
          task({ id: 'a', contextId: 'one' }),
          task({ id: 'b', contextId: 'two', status: 'failed' }),
        ],
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

describe('firstErrorLine', () => {
  test('is the first line with text in it', () => {
    expect(firstErrorLine('\n\n  Boom  \nstack')).toBe('Boom');
  });

  test('is nothing for no message or a blank one', () => {
    expect(firstErrorLine(null)).toBeUndefined();
    expect(firstErrorLine('  \n ')).toBeUndefined();
  });

  test('cuts a long line to a readable length', () => {
    const line = firstErrorLine('x'.repeat(500)) ?? '';

    expect(line.length).toBe(120);
    expect(line.endsWith('…')).toBe(true);
  });
});
