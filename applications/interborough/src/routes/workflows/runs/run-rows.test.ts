import { describe, expect, test } from 'bun:test';

import { taskFixture } from '../../../lib/bureau-fixtures.test-support.ts';
import { SCHEDULER_ACTOR } from '../../../lib/bureau-tasks.ts';
import { buildRunRows, filterRunRows, parseRunFilter, serializeRunFilter } from './run-rows.ts';

const chat = {
  id: 'chat-1',
  owner: 'o',
  agentName: 'tool-runner',
  title: 'Refund order 1234',
  lastMessagePreview: 'Refund order 1234',
  parentContextId: null,
  forkedFromMessageId: null,
  origin: 'chat',
  messageCount: 2,
  createdAt: '2026-10-23T00:00:00.000Z',
  updatedAt: '2026-10-23T00:00:00.000Z',
  activity: 'idle',
} as const;

const goal = {
  goalRunId: 'seeded-goal',
  agentName: 'assistant',
  attempts: [
    {
      attemptId: 'a',
      attemptIndex: 0,
      runId: 'goal-seeded-goal-a0',
      sessionId: 'goal-seeded-goal-s0',
      status: 'passed',
      startedAt: '2026-10-23T00:00:00.000Z',
      completedAt: '2026-10-23T00:00:01.000Z',
      finishReason: 'stop-condition',
      usage: { steps: 1, tokens: 0, costUsd: null },
    },
  ],
} as never;

describe('buildRunRows', () => {
  const rows = buildRunRows({
    tasks: [
      taskFixture({
        id: 'run-1',
        contextId: 'chat-1',
        agentName: 'tool-runner',
        status: 'input-required',
        openWaits: [{ kind: 'tool-approval', reviewId: 'r', callId: 'c' }],
        createdAt: '2026-10-23T00:01:00.000Z',
        updatedAt: '2026-10-23T00:01:05.000Z',
      }),
    ],
    goals: [goal],
    chats: [chat],
  });

  test('joins tasks and goal attempts, the most recently changed first', () => {
    expect(rows.map((row) => row.id)).toEqual(['run-1', 'goal-seeded-goal-a0']);
  });

  test('names what started a run and how it stands, in a task’s words', () => {
    expect(rows[0]).toMatchObject({
      status: 'input-required',
      origin: { kind: 'chat', title: 'Refund order 1234', href: '/chat/chat-1' },
      summary: 'Waiting for your approval',
      durationMs: null,
    });
    expect(rows[1]).toMatchObject({
      status: 'completed',
      origin: { kind: 'goal', name: 'seeded-goal', href: '/goals' },
      durationMs: 1000,
    });
  });
});

describe('the session a run ran in', () => {
  const fire = { ...chat, id: 'fire-1', title: 'Check in', origin: 'schedule' } as const;
  const goalSession = {
    ...chat,
    id: 'goal-seeded-goal-s0',
    title: 'Say hello.',
    origin: 'goal',
  } as const;

  test('is linked from a goal’s row while the Bureau still has it, which Chat does not list', () => {
    const [row] = buildRunRows({ tasks: [], goals: [goal], chats: [goalSession] });

    expect(row?.origin).toEqual({
      kind: 'goal',
      name: 'seeded-goal',
      href: '/goals',
      session: { title: 'Say hello.', href: '/chat/goal-seeded-goal-s0' },
    });
  });

  test('is linked from a goal’s row by the attempt’s own session, even when the caller lists none', () => {
    // A principal with operator reach sees every owner's goals, and lists only its own sessions.
    const [row] = buildRunRows({ tasks: [], goals: [goal], chats: [] });

    expect(row?.origin).toEqual({
      kind: 'goal',
      name: 'seeded-goal',
      href: '/goals',
      session: { title: '', href: '/chat/goal-seeded-goal-s0' },
    });
  });

  test('is linked from a schedule fire’s row, which a chat did not start', () => {
    const [row] = buildRunRows({
      tasks: [
        taskFixture({
          id: 'run-fire',
          contextId: 'fire-1',
          agentName: 'assistant',
          actor: SCHEDULER_ACTOR,
        }),
      ],
      goals: [],
      chats: [fire],
    });

    expect(row?.origin).toEqual({ kind: 'schedule', title: 'Check in', href: '/chat/fire-1' });
  });

  test('is a schedule’s even when the fire continued a chat session, which keeps its chat origin', () => {
    const rows = buildRunRows({
      tasks: [
        taskFixture({ id: 'run-fire', contextId: 'chat-1', actor: SCHEDULER_ACTOR }),
        taskFixture({ id: 'run-person', contextId: 'chat-1' }),
      ],
      goals: [],
      chats: [chat],
    });

    expect(rows.find((row) => row.id === 'run-fire')?.origin).toEqual({
      kind: 'schedule',
      title: 'Refund order 1234',
      href: '/chat/chat-1',
    });
    expect(rows.find((row) => row.id === 'run-person')?.origin).toMatchObject({ kind: 'chat' });
    expect(filterRunRows(rows, { startedBy: 'schedule' }, Date.now()).map((row) => row.id)).toEqual(
      ['run-fire'],
    );
    expect(filterRunRows(rows, { startedBy: 'chat' }, Date.now()).map((row) => row.id)).toEqual([
      'run-person',
    ]);
  });

  test('is not a schedule’s because the session says so: the task decides', () => {
    const [row] = buildRunRows({
      tasks: [taskFixture({ id: 'run-person', contextId: 'fire-1' })],
      goals: [],
      chats: [fire],
    });

    expect(row?.origin).toMatchObject({ kind: 'chat' });
  });

  test('is a schedule’s with no link when the fire’s session is gone', () => {
    const [row] = buildRunRows({
      tasks: [taskFixture({ id: 'run-fire', contextId: 'gone', actor: SCHEDULER_ACTOR })],
      goals: [],
      chats: [],
    });

    expect(row?.origin).toEqual({ kind: 'schedule', title: '', href: null });
  });

  test('lets the list be narrowed to the runs a schedule started', () => {
    const rows = buildRunRows({
      tasks: [
        taskFixture({ id: 'run-fire', contextId: 'fire-1', actor: SCHEDULER_ACTOR }),
        taskFixture({ id: 'run-chat', contextId: 'chat-1' }),
      ],
      goals: [goal],
      chats: [fire, chat],
    });

    expect(filterRunRows(rows, { startedBy: 'schedule' }, Date.now()).map((row) => row.id)).toEqual(
      ['run-fire'],
    );
    expect(parseRunFilter(new URLSearchParams('startedBy=schedule'))).toEqual({
      startedBy: 'schedule',
    });
  });
});

describe('a run’s summary', () => {
  const summaryOf = (task: Parameters<typeof taskFixture>[0]): string | undefined =>
    buildRunRows({
      tasks: [taskFixture({ id: 'run-9', contextId: 'chat-1', ...task })],
      goals: [],
      chats: [chat],
    })[0]?.summary;

  test('is never the chat’s last message, which the run did not write', () => {
    expect(summaryOf({ status: 'completed' })).toBe('');
    expect(summaryOf({ status: 'working' })).toBe('');
  });

  test('is why a run failed or was canceled, in its own words', () => {
    expect(summaryOf({ status: 'failed', statusMessage: 'The tool broke.' })).toBe(
      'The tool broke.',
    );
    expect(summaryOf({ status: 'canceled', finishReason: 'canceled' })).toBe('canceled');
  });
});

describe('filterRunRows', () => {
  const rows = buildRunRows({
    tasks: [taskFixture({ id: 'run-1', contextId: 'chat-1', status: 'submitted' })],
    goals: [goal],
    chats: [chat],
  });

  test('narrows by status, agent, and what started the run', () => {
    const now = Date.now();
    expect(filterRunRows(rows, { status: 'working' }, now).map((row) => row.id)).toEqual(['run-1']);
    expect(filterRunRows(rows, { startedBy: 'goal' }, now).map((row) => row.id)).toEqual([
      'goal-seeded-goal-a0',
    ]);
    expect(filterRunRows(rows, { agent: 'nobody' }, now)).toEqual([]);
  });
});

describe('the filter in the address', () => {
  test('round-trips, and ignores what it does not know', () => {
    const filter = { status: 'failed', agent: 'echo', startedBy: 'chat', since: '24h' } as const;
    expect(parseRunFilter(new URLSearchParams(serializeRunFilter(filter)))).toEqual(filter);
    expect(parseRunFilter(new URLSearchParams('status=bogus&since=1y&startedBy=x'))).toEqual({});
  });
});
