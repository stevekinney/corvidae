import type { TaskOrigin, TaskOriginKind } from '@lostgradient/bureau';
import { describe, expect, test } from 'bun:test';

import { taskFixture } from '../../../lib/bureau-fixtures.test-support.ts';
import { SCHEDULER_ACTOR } from '../../../lib/bureau-tasks.ts';
import {
  buildRunRows,
  FILTER_LABEL_LIMIT,
  filterLabelOf,
  filterRunRows,
  parseRunFilter,
  serializeRunFilter,
} from './run-rows.ts';
import { STARTED_BY_LABELS } from './started-by.ts';

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
      origin: { kind: 'chat', title: 'Refund order 1234', href: '/chats/chat-1' },
      summary: 'Waiting for your approval',
      durationMs: null,
    });
    expect(rows[1]).toMatchObject({
      status: 'completed',
      origin: { kind: 'goal', name: 'seeded-goal', href: '/goals/seeded-goal' },
      durationMs: 1000,
    });
  });
});

describe('a goal’s attempt, which the Bureau also lists as a task', () => {
  test('takes the task’s account of the run and keeps the goal and the session it names', () => {
    const [row] = buildRunRows({
      tasks: [
        taskFixture({
          id: 'goal-seeded-goal-a0',
          contextId: 'goal-seeded-goal-a0',
          kind: 'catalog',
          status: 'failed',
          statusMessage: 'The task’s own message',
          createdAt: '2026-10-23T00:00:00.000Z',
          updatedAt: '2026-10-23T00:00:03.000Z',
        }),
      ],
      goals: [goal],
      chats: [],
    });

    expect(row).toMatchObject({
      status: 'failed',
      summary: 'The task’s own message',
      durationMs: 3000,
      origin: {
        kind: 'goal',
        name: 'seeded-goal',
        href: '/goals/seeded-goal',
        session: { title: '', href: '/chats/goal-seeded-goal-s0' },
      },
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
      href: '/goals/seeded-goal',
      session: { title: 'Say hello.', href: '/chats/goal-seeded-goal-s0' },
    });
  });

  test('is linked from a goal’s row by the attempt’s own session, even when the caller lists none', () => {
    // A principal with operator reach sees every owner's goals, and lists only its own sessions.
    const [row] = buildRunRows({ tasks: [], goals: [goal], chats: [] });

    expect(row?.origin).toEqual({
      kind: 'goal',
      name: 'seeded-goal',
      href: '/goals/seeded-goal',
      session: { title: '', href: '/chats/goal-seeded-goal-s0' },
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

    expect(row?.origin).toMatchObject({
      kind: 'schedule',
      title: 'Check in',
      href: '/chats/fire-1',
    });
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

    expect(rows.find((row) => row.id === 'run-fire')?.origin).toMatchObject({
      kind: 'schedule',
      title: 'Refund order 1234',
      href: '/chats/chat-1',
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

  test('is linked from a schedule fire’s row by the task’s own session, even when the caller lists none', () => {
    // An operator sees every owner's fires and lists only their own sessions.
    const [row] = buildRunRows({
      tasks: [
        taskFixture({ id: 'run-fire', contextId: 'other-owner-fire', actor: SCHEDULER_ACTOR }),
      ],
      goals: [],
      chats: [chat],
    });

    expect(row?.origin).toMatchObject({
      kind: 'schedule',
      title: '',
      href: '/chats/other-owner-fire',
    });
  });

  test('links another owner’s chat from the task’s own session, which the caller does not list', () => {
    // An operator sees every owner's tasks and lists only their own sessions. The task says its
    // `contextId` is a chat session, so the link comes from the task and `bureau.contexts.get`
    // decides whether it opens.
    const [row] = buildRunRows({
      tasks: [taskFixture({ id: 'run-other', contextId: 'other-owner-chat', kind: 'chat' })],
      goals: [],
      chats: [chat],
    });

    expect(row?.origin).toEqual({ kind: 'chat', title: '', href: '/chats/other-owner-chat' });
  });

  test('names the caller’s own chat by its title, whichever kind the task says it is', () => {
    const [row] = buildRunRows({
      tasks: [taskFixture({ id: 'run-own', contextId: 'chat-1', kind: 'chat' })],
      goals: [],
      chats: [chat],
    });

    expect(row?.origin).toEqual({
      kind: 'chat',
      title: 'Refund order 1234',
      href: '/chats/chat-1',
    });
  });

  test('links no session from a catalog run, whose `contextId` is a handle no chat has', () => {
    const [row] = buildRunRows({
      tasks: [taskFixture({ id: 'run-catalog', contextId: 'agent-run-9', kind: 'catalog' })],
      goals: [],
      chats: [chat],
    });

    expect(row?.origin).toEqual({ kind: 'none' });
  });

  test('keeps a schedule fire a schedule’s and a goal attempt a goal’s, whatever other owner they have', () => {
    const rows = buildRunRows({
      tasks: [
        taskFixture({
          id: 'run-fire',
          contextId: 'other-owner-fire',
          actor: SCHEDULER_ACTOR,
          kind: 'schedule-fire',
        }),
      ],
      goals: [goal],
      chats: [],
    });

    expect(rows.find((row) => row.id === 'run-fire')?.origin).toMatchObject({
      kind: 'schedule',
      title: '',
      href: '/chats/other-owner-fire',
    });
    expect(rows.find((row) => row.id === 'goal-seeded-goal-a0')?.origin).toMatchObject({
      kind: 'goal',
      session: { href: '/chats/goal-seeded-goal-s0' },
    });
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

describe('Started by, read from the origin the Bureau recorded', () => {
  // Typed against the Bureau's own kinds: a kind added there fails to compile here until a fixture
  // and a label exist for it, so the column cannot silently skip one.
  const ORIGINS = {
    chat: { kind: 'chat', contextId: 'chat-1', agentName: 'tool-runner', principal: 'me' },
    person: { kind: 'person', principal: 'me', surface: 'palette' },
    schedule: { kind: 'schedule', scheduleId: 'nightly', fireId: 'fire-1', manual: true },
    api: { kind: 'api' },
    agent: { kind: 'agent', parentRunId: 'run-parent', agentName: 'planner', toolCallId: 'call-1' },
    goal: { kind: 'goal', goalRunId: 'seeded-goal', attemptId: 'a' },
    parent: { kind: 'parent', parentRunId: 'wf-instance' },
  } as const satisfies { readonly [Kind in TaskOriginKind]: Extract<TaskOrigin, { kind: Kind }> };

  const rowOf = (origin: unknown) =>
    buildRunRows({
      tasks: [taskFixture({ id: 'run-x', contextId: 'handle', kind: 'catalog', origin } as never)],
      goals: [],
      chats: [chat],
    })[0]?.origin;

  test('has a label for each kind the Bureau records, and the filter takes exactly those', () => {
    expect(Object.keys(STARTED_BY_LABELS).toSorted()).toEqual(Object.keys(ORIGINS).toSorted());
    for (const kind of Object.keys(ORIGINS)) {
      expect(parseRunFilter(new URLSearchParams({ startedBy: kind }))).toEqual({
        startedBy: kind as TaskOriginKind,
      });
    }
    expect(parseRunFilter(new URLSearchParams({ startedBy: 'someone' }))).toEqual({});
  });

  test('names each kind, with the thing that started the run where it has a page', () => {
    expect(rowOf(ORIGINS.chat)).toEqual({
      kind: 'chat',
      title: 'Refund order 1234',
      href: '/chats/chat-1',
    });
    expect(rowOf(ORIGINS.person)).toEqual({ kind: 'person', surface: 'palette' });
    expect(rowOf(ORIGINS.schedule)).toMatchObject({
      kind: 'schedule',
      scheduleId: 'nightly',
      schedulePath: '/schedules/nightly',
      href: '/chats/handle',
      manual: true,
    });
    expect(rowOf(ORIGINS.api)).toEqual({ kind: 'api' });
    expect(rowOf(ORIGINS.agent)).toEqual({
      kind: 'agent',
      agentName: 'planner',
      parentRunId: 'run-parent',
      href: '/runs/run-parent',
    });
    expect(rowOf(ORIGINS.goal)).toEqual({
      kind: 'goal',
      name: 'seeded-goal',
      href: '/goals/seeded-goal',
      session: null,
    });
    expect(rowOf(ORIGINS.parent)).toEqual({
      kind: 'parent',
      parentRunId: 'wf-instance',
      href: '/runs/wf-instance',
    });
  });

  test('is the recorded origin, not what the task’s chats and goals suggest', () => {
    // A task that looks like a chat's by its kind and session, but whose origin says a person
    // started it from the API, is a person's.
    const [row] = buildRunRows({
      tasks: [
        taskFixture({
          id: 'run-y',
          contextId: 'chat-1',
          kind: 'chat',
          origin: { kind: 'person', principal: 'me', surface: 'api' },
        }),
      ],
      goals: [],
      chats: [chat],
    });
    expect(row?.origin).toEqual({ kind: 'person', surface: 'api' });
  });

  test('keeps a goal’s session from the goal list when the task’s origin names the goal', () => {
    const [row] = buildRunRows({
      tasks: [
        taskFixture({
          id: 'goal-seeded-goal-a0',
          contextId: 'goal-seeded-goal-a0',
          kind: 'catalog',
          origin: ORIGINS.goal,
        }),
      ],
      goals: [goal],
      chats: [],
    });
    expect(row?.origin).toMatchObject({
      kind: 'goal',
      session: { href: '/chats/goal-seeded-goal-s0' },
    });
  });

  test('reads an origin it cannot use as none, and then falls back to the task itself', () => {
    expect(rowOf({ kind: 'carrier-pigeon' })).toEqual({ kind: 'none' });
    expect(rowOf({ kind: 'agent' })).toEqual({ kind: 'none' });
    expect(rowOf({ kind: 'schedule' })).toMatchObject({ kind: 'schedule', scheduleId: null });
  });

  test('narrows the list to the runs one kind of origin started', () => {
    const rows = buildRunRows({
      tasks: Object.entries(ORIGINS).map(([kind, origin]) =>
        taskFixture({ id: `run-${kind}`, contextId: 'handle', kind: 'catalog', origin } as never),
      ),
      goals: [],
      chats: [],
    });
    for (const kind of Object.keys(ORIGINS) as TaskOriginKind[]) {
      expect(filterRunRows(rows, { startedBy: kind }, 0).map((row) => row.id)).toEqual([
        `run-${kind}`,
      ]);
    }
  });
});

describe('an agent’s name in the Agent filter (COR-1862)', () => {
  test('keeps a name that fits, whole', () => {
    expect(filterLabelOf('support-triage')).toBe('support-triage');
    expect(filterLabelOf('a'.repeat(FILTER_LABEL_LIMIT))).toBe('a'.repeat(FILTER_LABEL_LIMIT));
  });

  test('cuts a 64-character name to the limit, keeping its start and its end', () => {
    const name = `responsive-agent-${'a'.repeat(46)}z`;
    expect(name).toHaveLength(64);
    const label = filterLabelOf(name);
    expect(Array.from(label)).toHaveLength(FILTER_LABEL_LIMIT);
    expect(label.startsWith('responsive-age')).toBe(true);
    expect(label.endsWith('aaaaz')).toBe(true);
    expect(label).toContain('…');
  });

  test('keeps two names that differ only at the end apart', () => {
    const base = 'quarterly-revenue-reconciliation-agent-for-the-emea-region';
    expect(filterLabelOf(`${base}-a`)).not.toBe(filterLabelOf(`${base}-b`));
  });

  test('counts characters, not UTF-16 units', () => {
    const label = filterLabelOf('🙂'.repeat(40));
    expect(Array.from(label)).toHaveLength(FILTER_LABEL_LIMIT);
  });
});
