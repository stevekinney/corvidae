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
import { createNotificationStore } from './notification-store';
import { NOTIFICATION_FIELD_LIMITS, type NotificationInput } from './notification-types';

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

  it('dismisses the notification of a request the replay of a schedule fire ended, which no decision can reach', async () => {
    const { running, dispatch, dismissed } = open();

    dispatch(
      new ReviewSupersededEvent('approval:run-1:c1', 'run-1', 'system:replay', 'tool-approval'),
    );
    await running.drain();

    expect(dismissed).toEqual(['review.waiting:approval:run-1:c1']);
  });

  it('bounds the dedupe key of a review with a long id, the same for the write and the close', async () => {
    const { running, dispatch, created, dismissed } = open();
    const reviewId = `human-wait:run-1:${'s'.repeat(600)}:0`;

    dispatch(new ReviewRequestedEvent(reviewId, 'run-1', 'api-key:alice', 'human-wait'));
    dispatch(new ReviewApprovedEvent(reviewId, 'run-1', 'api-key:alice', 'human-wait'));
    await running.drain();

    const key = created[0]?.dedupeKey ?? '';
    expect(key).toMatch(/^review\.waiting:human-wait:sha256:[0-9a-f]{64}$/);
    expect(key.length).toBeLessThan(NOTIFICATION_FIELD_LIMITS.dedupeKey);
    expect(dismissed).toEqual([key]);
  });

  it('writes a notification for a review with a long id into the real store, and closes it', async () => {
    const reviewId = `human-wait:run-1:${'s'.repeat(600)}:0`;
    const listeners = new Set<(event: Event) => void>();
    const diagnostics: string[] = [];
    let tick = 0;
    const store = createNotificationStore({
      clock: { nowISO: () => new Date(Date.UTC(2026, 9, 30, 12, 0, tick++)).toISOString() },
      identifiers: { next: (kind) => `${kind}-${tick}` },
      diagnose: (diagnostic) => diagnostics.push(diagnostic.message),
      refusal: (message) => new Error(message),
    });
    const running = startBuiltInNotifications({
      source: {
        toObservable: () => ({
          subscribe: (next) => {
            listeners.add(next);
            return { unsubscribe: () => listeners.delete(next) };
          },
        }),
      },
      store,
      tasks: { get: async () => undefined },
      diagnose: (diagnostic) => diagnostics.push(diagnostic.message),
    });
    const dispatch = (event: Event) => {
      for (const listener of listeners) listener(event);
    };

    dispatch(new ReviewRequestedEvent(reviewId, 'run-1', 'api-key:alice', 'human-wait'));
    await running.drain();
    const waiting = await store.list({ owner: 'api-key:alice' });
    dispatch(new ReviewApprovedEvent(reviewId, 'run-1', 'api-key:alice', 'human-wait'));
    await running.drain();
    const closed = await store.list({ owner: 'api-key:alice', includeDismissed: true });

    expect(diagnostics).toEqual([]);
    expect(waiting.notifications).toHaveLength(1);
    expect(waiting.notifications[0]?.subject?.reviewId).toMatch(/^human-wait:sha256:[0-9a-f]{64}$/);
    expect(closed.notifications[0]?.dismissedAt).not.toBeNull();
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

describe('the notification outbox (COR-1945)', () => {
  function open(tasks: Record<string, TaskView>, owed: string[]) {
    const created: string[] = [];
    const cleared: string[] = [];
    const diagnostics: string[] = [];
    let failWrites = 0;
    const running = startBuiltInNotifications({
      source: { toObservable: () => ({ subscribe: () => ({ unsubscribe: () => undefined }) }) },
      store: {
        create: async (input) => {
          if (failWrites > 0) {
            failWrites -= 1;
            throw new Error('storage unavailable');
          }
          // A dedupe key found is a no-op, as in the real store.
          const fresh = !created.includes(input.dedupeKey ?? '');
          if (fresh) created.push(input.dedupeKey ?? '');
          return { notification: {} as never, created: fresh };
        },
        dismissByDedupeKey: async () => 0,
      },
      tasks: { get: async (taskId) => tasks[taskId] },
      diagnose: (diagnostic) => diagnostics.push(diagnostic.message),
      outbox: {
        pending: async () => owed.filter((runId) => !cleared.includes(runId)),
        clear: async (runId) => {
          cleared.push(runId);
        },
      },
    });
    return {
      running,
      created,
      cleared,
      diagnostics,
      failNextWrites: (count: number) => (failWrites = count),
    };
  }

  it('writes what the outbox owes and clears each entry once its notification exists', async () => {
    const { running, created, cleared } = open(
      { 'run-1': task({ id: 'run-1' }), 'run-2': task({ id: 'run-2' }) },
      ['run-1', 'run-2'],
    );

    await running.repair();

    expect(created).toEqual(['run.settled:run-1', 'run.settled:run-2']);
    expect(cleared).toEqual(['run-1', 'run-2']);
  });

  it('keeps the entry when the write fails, and the next repair writes it', async () => {
    const { running, created, cleared, diagnostics, failNextWrites } = open(
      { 'run-1': task({ id: 'run-1' }) },
      ['run-1'],
    );
    failNextWrites(1);

    await running.repair();

    expect(created).toEqual([]);
    expect(cleared).toEqual([]);
    expect(diagnostics.join('\n')).toContain('storage unavailable');

    await running.repair();

    expect(created).toEqual(['run.settled:run-1']);
    expect(cleared).toEqual(['run-1']);
  });

  it('repairing twice, or after the live write, writes one notification', async () => {
    const { running, created } = open({ 'run-1': task({ id: 'run-1' }) }, ['run-1', 'run-1']);

    await running.repair();
    await running.repair();

    expect(created).toEqual(['run.settled:run-1']);
  });

  it('clears the entry of a run that calls for no notification, or whose record is gone', async () => {
    const { running, created, cleared } = open(
      { 'run-1': task({ id: 'run-1', status: 'completed' }) },
      ['run-1', 'run-gone'],
    );

    await running.repair();

    expect(created).toEqual([]);
    expect(cleared).toEqual(['run-1', 'run-gone']);
  });
});
