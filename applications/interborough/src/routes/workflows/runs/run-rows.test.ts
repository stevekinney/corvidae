import { describe, expect, test } from 'bun:test';

import { taskFixture } from '../../../lib/bureau-fixtures.test-support.ts';
import { buildRunRows, filterRunRows, parseRunFilter, serializeRunFilter } from './run-rows.ts';

const chat = {
  id: 'chat-1',
  owner: 'o',
  agentName: 'tool-runner',
  title: 'Refund order 1234',
  lastMessagePreview: 'Refund order 1234',
  parentContextId: null,
  forkedFromMessageId: null,
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
