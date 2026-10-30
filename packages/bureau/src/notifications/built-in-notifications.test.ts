/**
 * COR-1941 — which settled tasks call for a built-in notification: only a failed task that is top
 * level, so a run that fans out into children notifies once, for itself.
 */
import { describe, expect, it } from 'bun:test';

import {
  ReviewApprovedEvent,
  ReviewRequestedEvent,
  ReviewSupersededEvent,
  RunSettledEvent,
} from '../events';
import type { TaskView } from '../task-registry';
import { notificationForSettledTask, startBuiltInNotifications } from './built-in-notifications';
import type { NotificationInput } from './notification-types';

const task = (change: Partial<TaskView> = {}): TaskView => ({
  id: 'run-1',
  contextId: 'session-1',
  agentName: 'researcher',
  owner: 'api-key:alice',
  actor: null,
  kind: 'chat',
  origin: { kind: 'chat', contextId: 'session-1', agentName: 'researcher', principal: 'alice' },
  status: 'failed',
  finishReason: 'error',
  statusMessage: 'boom\nmore',
  createdAt: '2026-10-30T12:00:00.000Z',
  updatedAt: '2026-10-30T12:00:01.000Z',
  cleanup: null,
  openWaits: [],
  ...change,
});

describe('notificationForSettledTask', () => {
  it('writes run.failed for the owner, with the first line of the error and the run named', () => {
    expect(notificationForSettledTask(task())).toEqual({
      owner: 'api-key:alice',
      kind: 'run.failed',
      title: 'researcher failed',
      body: 'boom',
      dedupeKey: 'run.settled:run-1',
      subject: { runId: 'run-1', contextId: 'session-1', agentName: 'researcher' },
    });
  });

  it('writes run.budget-exceeded for the budget-exceeded finish reason', () => {
    expect(notificationForSettledTask(task({ finishReason: 'budget-exceeded' }))).toMatchObject({
      kind: 'run.budget-exceeded',
      title: 'researcher exceeded its budget',
      dedupeKey: 'run.settled:run-1',
    });
  });

  it('names the schedule of a scheduled fire, and writes for a task with no recorded origin', () => {
    const fire = task({ origin: { kind: 'schedule', scheduleId: 's1', fireId: 'f1' } });

    expect(notificationForSettledTask(fire)?.subject).toMatchObject({ scheduleId: 's1' });
    expect(notificationForSettledTask(task({ origin: null }))).toBeDefined();
  });

  it.each([
    ['completed', { status: 'completed' as const }],
    ['canceled', { status: 'canceled' as const }],
    ['an agent child', { origin: { kind: 'agent', parentRunId: 'p', agentName: 'a' } as const }],
    ['a goal attempt', { origin: { kind: 'goal', goalRunId: 'g', attemptId: 'a' } as const }],
    ['a parent child', { origin: { kind: 'parent', parentRunId: 'p' } as const }],
  ])('writes nothing for %s', (_name, change) => {
    expect(notificationForSettledTask(task(change))).toBeUndefined();
  });

  it('reads the message of an error serialized as JSON and never its cause or stack', () => {
    const serialized = JSON.stringify({
      name: 'AgentRunError',
      message: 'rate limited',
      cause: { stack: 'at secret.ts' },
    });

    const input = notificationForSettledTask(task({ statusMessage: serialized }));

    expect(input?.body).toBe('rate limited');
  });

  it('cuts a long first line, and leaves out a body when there is no message', () => {
    expect(notificationForSettledTask(task({ statusMessage: 'x'.repeat(500) }))?.body).toHaveLength(
      200,
    );
    expect(notificationForSettledTask(task({ statusMessage: null }))).not.toHaveProperty('body');
  });
});

describe('startBuiltInNotifications', () => {
  function open(tasks: Record<string, TaskView> = {}) {
    const listeners = new Set<(event: Event) => void>();
    const created: NotificationInput[] = [];
    const dismissed: string[] = [];
    const diagnostics: string[] = [];
    const running = startBuiltInNotifications({
      source: {
        toObservable: () => ({
          subscribe: (next) => {
            listeners.add(next);
            return { unsubscribe: () => listeners.delete(next) };
          },
        }),
      },
      store: {
        create: async (input) => {
          created.push(input);
          return { notification: {} as never, created: true };
        },
        dismissByDedupeKey: async (key) => {
          dismissed.push(key);
          return 1;
        },
      },
      tasks: { get: async (taskId) => tasks[taskId] },
      diagnose: (diagnostic) => diagnostics.push(diagnostic.message),
    });
    const dispatch = (event: Event) => {
      for (const listener of listeners) listener(event);
    };
    return { running, dispatch, created, dismissed, diagnostics, listeners };
  }

  it('writes review.waiting for the review’s principal, and dismisses it when the review closes but not when it is superseded', async () => {
    const { running, dispatch, created, dismissed } = open({ 'run-1': task({ id: 'run-1' }) });

    dispatch(
      new ReviewRequestedEvent('approval:run-1:c1', 'run-1', 'api-key:alice', 'tool-approval'),
    );
    dispatch(
      new ReviewSupersededEvent('approval:run-1:c1', 'run-1', 'api-key:alice', 'tool-approval'),
    );
    dispatch(new ReviewApprovedEvent('approval:run-1:c1', 'run-1', 'api-key:bob', 'tool-approval'));
    await running.drain();

    expect(created).toEqual([
      {
        owner: 'api-key:alice',
        kind: 'review.waiting',
        title: 'researcher needs your approval',
        dedupeKey: 'review.waiting:approval:run-1:c1',
        subject: {
          runId: 'run-1',
          reviewId: 'approval:run-1:c1',
          reviewKind: 'tool-approval',
          contextId: 'session-1',
          agentName: 'researcher',
        },
      },
    ]);
    expect(dismissed).toEqual(['review.waiting:approval:run-1:c1']);
  });

  it('words a human wait as a question, and still writes when the run’s record is not found', async () => {
    const { running, dispatch, created } = open();

    dispatch(
      new ReviewRequestedEvent('human-wait:run-9:x:0', 'run-9', 'api-key:alice', 'human-wait'),
    );
    await running.drain();

    expect(created[0]).toMatchObject({
      title: 'An agent has a question',
      subject: { runId: 'run-9', reviewKind: 'human-wait' },
    });
  });

  it('writes in the order the events arrived', async () => {
    const { running, dispatch, created, diagnostics } = open({
      'run-1': task({ id: 'run-1' }),
      'run-2': task({ id: 'run-2', agentName: 'second' }),
    });

    dispatch(new RunSettledEvent('run-1'));
    dispatch(new RunSettledEvent('run-2'));
    await running.drain();

    expect(created.map((input) => input.dedupeKey)).toEqual([
      'run.settled:run-1',
      'run.settled:run-2',
    ]);
    expect(diagnostics).toEqual([]);
  });

  it('diagnoses a write that fails and goes on to the next', async () => {
    const unreadable = task({ id: 'run-1' });
    Object.defineProperty(unreadable, 'status', {
      get() {
        throw new Error('storage unavailable');
      },
    });
    const { running, dispatch, created, diagnostics } = open({
      'run-1': unreadable,
      'run-2': task({ id: 'run-2' }),
    });

    dispatch(new RunSettledEvent('run-1'));
    dispatch(new RunSettledEvent('run-2'));
    await running.drain();

    expect(created.map((input) => input.dedupeKey)).toEqual(['run.settled:run-2']);
    expect(diagnostics.join('\n')).toContain('storage unavailable');
  });

  it('stops listening on stop, and drain waits for a write already started', async () => {
    const { running, dispatch, created, listeners } = open({ 'run-1': task({ id: 'run-1' }) });

    dispatch(new RunSettledEvent('run-1'));
    running.stop();
    dispatch(new RunSettledEvent('run-1'));
    await running.drain();

    expect(listeners.size).toBe(0);
    expect(created).toHaveLength(1);
  });
});
