import { afterEach, describe, expect, test } from 'bun:test';

import { installBureauStub, type BureauStub } from '../lib/bureau-stub.test-support.ts';
import type { TaskView } from '../lib/bureau-tasks.ts';
import { isScheduledFailure, loadChats, loadScheduleNames } from './notification-sources.ts';

let stub: BureauStub | undefined;
afterEach(() => {
  stub?.restore();
  stub = undefined;
});

function task(overrides: Partial<TaskView> = {}): TaskView {
  return {
    id: 'run-1',
    contextId: 'session-1',
    agentName: 'assistant',
    owner: 'anonymous:local',
    actor: 'service:scheduler',
    status: 'failed',
    finishReason: null,
    statusMessage: 'Boom',
    createdAt: '2026-10-23T09:00:00.000Z',
    updatedAt: '2026-10-23T09:00:01.000Z',
    cleanup: null,
    openWaits: [],
    ...overrides,
  };
}

function schedule(id: string, description: string | null, agentName: string | null) {
  return {
    id,
    owner: 'anonymous:local',
    agentName,
    inputPreview: null,
    workflowType: 'agentRun',
    description,
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
  };
}

function fired(scheduleId: unknown) {
  return {
    records: [
      {
        sequence: 1,
        timestamp: '2026-10-23T09:00:00.000Z',
        type: 'schedule.fired',
        resource: 'run-1',
        principal: 'service:scheduler',
        detail: { scheduleId },
      },
    ],
    nextCursor: null,
  };
}

describe('loadChats', () => {
  test('maps each session to its title, with null for a chat that has none', async () => {
    stub = installBureauStub({
      'bureau.contexts.list': () => ({
        contexts: [
          { id: 'a', title: 'Refund order 1234' },
          { id: 'b', title: null },
        ].map((context) => ({
          ...context,
          owner: null,
          agentName: 'echo',
          lastMessagePreview: null,
          parentContextId: null,
          forkedFromMessageId: null,
          messageCount: 1,
          createdAt: '2026-10-23T09:00:00.000Z',
          updatedAt: '2026-10-23T09:00:00.000Z',
          activity: 'idle',
        })),
        nextOffset: null,
      }),
    });

    expect([...(await loadChats())]).toEqual([
      ['a', 'Refund order 1234'],
      ['b', null],
    ]);
  });
});

describe('isScheduledFailure', () => {
  test('is a failed task a schedule started', () => {
    expect(isScheduledFailure(task())).toBe(true);
    expect(isScheduledFailure(task({ actor: null }))).toBe(false);
    expect(isScheduledFailure(task({ status: 'completed' }))).toBe(false);
  });
});

describe('loadScheduleNames', () => {
  test('asks nothing when no failed task was started by a schedule', async () => {
    stub = installBureauStub({});

    const names = await loadScheduleNames([task({ actor: null }), task({ status: 'completed' })]);

    expect(names.size).toBe(0);
    expect(stub.calls).toEqual([]);
  });

  test('names a task’s schedule by its description, from the fire the audit trail recorded', async () => {
    stub = installBureauStub({
      'bureau.audit.query': () => fired('s-1'),
      'bureau.schedules.list': () => ({
        schedules: [schedule('s-1', 'Daily summary', 'assistant')],
        nextOffset: null,
      }),
    });

    const names = await loadScheduleNames([task()]);

    expect([...names]).toEqual([['run-1', { name: 'Daily summary', identifier: false }]]);
    expect(stub.callsTo('bureau.audit.query')[0]?.params).toMatchObject({
      runId: 'run-1',
      type: 'schedule.fired',
      limit: 1,
    });
  });

  test('falls back to the agent the schedule runs when it has no description', async () => {
    stub = installBureauStub({
      'bureau.audit.query': () => fired('s-1'),
      'bureau.schedules.list': () => ({
        schedules: [schedule('s-1', null, 'assistant')],
        nextOffset: null,
      }),
    });

    expect([...(await loadScheduleNames([task()]))]).toEqual([
      ['run-1', { name: 'assistant', identifier: true }],
    ]);
  });

  test('leaves out a task whose fire the trail does not name or whose schedule is gone', async () => {
    stub = installBureauStub({
      'bureau.audit.query': () => fired(undefined),
      'bureau.schedules.list': () => ({
        schedules: [schedule('s-1', 'Daily summary', 'assistant')],
        nextOffset: null,
      }),
    });
    const unnamed = await loadScheduleNames([task()]);
    expect(unnamed.size).toBe(0);

    stub.on('bureau.audit.query', () => fired('s-gone'));
    const gone = await loadScheduleNames([task()]);
    expect(gone.size).toBe(0);
  });
});
