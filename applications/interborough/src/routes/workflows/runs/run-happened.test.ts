/**
 * What happened in a run, in order (`run-happened.ts`): the start with what set it going, each tool
 * call with its offset and how long it ran, the question or approval the run waits on, and what is
 * still to come (rows 55s, 06b and 06f).
 */
import { describe, expect, test } from 'bun:test';

import { happenedOfRun } from './run-happened.ts';

const ZONE = 'America/Chicago';
const STARTED = Date.parse('2026-11-02T10:42:11-06:00');

/** The thread of the sample world's refund run: a message, then a lookup that ran 0.4 s. */
const THREAD_WITH_LOOKUP: readonly unknown[] = [
  {
    id: 'user-1',
    role: 'user',
    content: 'Please refund order 4471.',
    createdAt: '2026-11-02T10:41:00-06:00',
  },
  {
    id: 'run-1:step:0',
    role: 'assistant',
    createdAt: '2026-11-02T10:42:14-06:00',
    toolCalls: [
      { id: 'call-1', function: { name: 'lookup-order', arguments: '{"order":"4471"}' } },
    ],
  },
  {
    id: 'run-1:step:0:result:call-1',
    role: 'tool',
    toolCallId: 'call-1',
    createdAt: '2026-11-02T10:42:15-06:00',
    metadata: {
      'conversationalist:toolResult': { outcome: 'success', content: 'Order 4471' },
      toolTiming: {
        startedAt: '2026-11-02T10:42:14.000-06:00',
        endedAt: '2026-11-02T10:42:14.400-06:00',
      },
    },
  },
];

const APPROVAL_CALL: readonly unknown[] = [
  {
    id: 'run-1:step:1',
    role: 'assistant',
    createdAt: '2026-11-02T10:42:20-06:00',
    toolCalls: [{ id: 'call-2', function: { name: 'issue-refund', arguments: '{}' } }],
  },
  {
    id: 'run-1:step:1:result:call-2',
    role: 'tool',
    toolCallId: 'call-2',
    metadata: { 'conversationalist:toolResult': { outcome: 'action_required' } },
  },
];

describe('happenedOfRun', () => {
  test('a run waiting on an approval: the start, the lookup, the ask, and what comes next (55s)', () => {
    const entries = happenedOfRun({
      runId: 'run-1',
      messages: [...THREAD_WITH_LOOKUP, ...APPROVAL_CALL],
      startedAt: STARTED,
      waiting: 'approval',
      over: false,
      zone: ZONE,
    });

    expect(entries.map((entry) => entry.title)).toEqual([
      'Started 10:42:11 AM',
      'Lookup order 4471',
      'Asked for approval',
      'Next steps',
    ]);
    expect(entries[0]?.detail).toBe('You sent a message in the chat at 10:41 AM');
    expect(entries[1]).toMatchObject({
      offsetMilliseconds: 3_000,
      detail: 'Lookup order, ran in 0.4s',
      state: 'done',
    });
    expect(entries[2]).toMatchObject({
      offsetMilliseconds: 9_000,
      detail: 'Waiting for your approval',
      state: 'current',
    });
    expect(entries[3]).toMatchObject({
      detail: 'Continue once you’ve approved or denied',
      state: 'pending',
    });
  });

  test('a run live with no reply yet ends on a Replied entry that is not run yet (06b)', () => {
    const entries = happenedOfRun({
      runId: 'run-1',
      messages: THREAD_WITH_LOOKUP,
      startedAt: STARTED,
      waiting: null,
      over: false,
      zone: ZONE,
    });

    expect(entries.map((entry) => entry.title)).toEqual([
      'Started 10:42:11 AM',
      'Lookup order 4471',
      'Replied',
    ]);
    expect(entries.at(-1)).toMatchObject({ detail: 'Not run yet', state: 'pending' });
  });

  test('a run that is over has nothing still to come', () => {
    const entries = happenedOfRun({
      runId: 'run-1',
      messages: THREAD_WITH_LOOKUP,
      startedAt: STARTED,
      waiting: null,
      over: true,
      zone: ZONE,
    });

    expect(entries.map((entry) => entry.title)).toEqual([
      'Started 10:42:11 AM',
      'Lookup order 4471',
    ]);
  });

  test('a question the thread does not hold is asked all the same, and says what answering does', () => {
    const entries = happenedOfRun({
      runId: 'run-1',
      messages: [],
      startedAt: STARTED,
      waiting: 'answer',
      over: false,
      zone: ZONE,
    });

    expect(entries.map((entry) => entry.title)).toEqual([
      'Started 10:42:11 AM',
      'Asked a question',
      'Next steps',
    ]);
    expect(entries[0]?.detail).toBeUndefined();
    expect(entries[1]?.detail).toBe('Waiting for your answer');
    expect(entries[2]?.detail).toBe('Continue once you’ve answered');
  });

  test('an approval whose call is not in the thread is still asked, once', () => {
    const entries = happenedOfRun({
      runId: 'run-1',
      messages: [],
      startedAt: STARTED,
      waiting: 'approval',
      over: false,
      zone: ZONE,
    });

    expect(entries.filter((entry) => entry.title === 'Asked for approval')).toHaveLength(1);
  });

  test('rows of another run are not this run’s calls, and a time before the start has no offset', () => {
    const entries = happenedOfRun({
      runId: 'run-2',
      messages: THREAD_WITH_LOOKUP,
      startedAt: STARTED,
      waiting: null,
      over: true,
      zone: ZONE,
    });
    expect(entries.map((entry) => entry.title)).toEqual(['Started 10:42:11 AM']);

    const early = happenedOfRun({
      runId: 'run-1',
      messages: THREAD_WITH_LOOKUP,
      startedAt: Date.parse('2026-11-02T10:43:00-06:00'),
      waiting: null,
      over: true,
      zone: ZONE,
    });
    expect(early[1]?.offsetMilliseconds).toBeUndefined();
  });

  test('a run that is over ends on how it ended and when, so a canceled run does not stop at Started', () => {
    const base = {
      runId: 'run-1',
      messages: [],
      startedAt: STARTED,
      waiting: null,
      over: true,
      zone: ZONE,
    } as const;
    const canceled = happenedOfRun({
      ...base,
      ended: { outcome: 'canceled', at: STARTED + 72_000 },
    });
    expect(canceled.map((entry) => entry.title)).toEqual([
      'Started 10:42:11 AM',
      'Canceled 10:43:23 AM',
    ]);
    expect(canceled.at(-1)).toMatchObject({ offsetMilliseconds: 72_000, state: 'done' });
    expect(
      happenedOfRun({ ...base, ended: { outcome: 'done', at: STARTED + 1_000 } }).at(-1)?.title,
    ).toBe('Done 10:42:12 AM');
    expect(
      happenedOfRun({ ...base, ended: { outcome: 'failed', at: STARTED + 1_000 } }).at(-1)?.title,
    ).toBe('Failed 10:42:12 AM');
    // A run still going has no end to show.
    expect(
      happenedOfRun({ ...base, over: false, ended: { outcome: 'done', at: STARTED } }).map(
        (entry) => entry.key,
      ),
    ).not.toContain('ended');
  });
});
