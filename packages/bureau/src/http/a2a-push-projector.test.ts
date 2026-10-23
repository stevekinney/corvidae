/**
 * The push projector against a stand-in Bureau (COR-1543): a crash between a history append and
 * its enqueue, or between the enqueue and the checkpoint, yields one delivery; a configuration
 * created mid-task receives nothing from before it; a checkpoint below the retention floor
 * delivers one snapshot; deliveries to one configuration are serialized; and a removed task takes
 * its configurations, checkpoints, and queued deliveries with it.
 */
import type { Task } from '@a2a-js/sdk';
import { createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import type { DurableEventEnvelope } from '@lostgradient/operative';
import { MemoryStorage, Outbox, textValueStore } from '@lostgradient/weft';
import {
  A2A_PUSH_CONTENT_TYPE,
  A2A_PUSH_DELIVERY_KIND,
  createEgressPolicy,
  createHttpDeliveryAdapter,
  createOutboxPushNotificationSender,
  createWeftPushNotificationStore,
  openDeliveries,
  pushDestinationRef,
  pushNotificationResolvers,
  startPushDelivery,
} from '@lostgradient/weft/a2a';
import { afterEach, describe, expect, it } from 'bun:test';

import type { TaskView } from '../task-registry.ts';
import { createA2APushCheckpoints, type A2APushCheckpoints } from './a2a-push-checkpoint.ts';
import {
  type A2APushBureau,
  type A2APushProjector,
  createA2APushProjector,
} from './a2a-push-projector.ts';
import { eventually, Receiver, SIGNING_SECRET } from './a2a-push.test-support.ts';

const VIEW: TaskView = {
  id: 'task-1',
  contextId: 'context-1',
  agentName: 'asker',
  owner: 'api-key:alice',
  actor: null,
  status: 'working',
  finishReason: null,
  statusMessage: null,
  createdAt: '2026-10-22T00:00:00.000Z',
  updatedAt: '2026-10-22T00:00:00.000Z',
  cleanup: null,
  openWaits: [],
};

const CALLER = { authenticated: true, userName: 'api-key:alice' };

function envelope(sequence: number, kind: string, payload: unknown = {}): DurableEventEnvelope {
  return {
    owner: { kind: 'run', id: 'task-1' },
    kind,
    cursor: String(sequence),
    emittedAtMs: Date.parse('2026-10-22T00:00:00.000Z') + sequence,
    payload,
  } as unknown as DurableEventEnvelope;
}

/** A Bureau whose durable history the test appends to and trims. */
function standIn(initial: DurableEventEnvelope[] = []) {
  const history = [...initial];
  let floor = 0;
  const listeners: Array<(event: DurableEventEnvelope) => void> = [];
  let view: TaskView | undefined = VIEW;
  let beforeReplay: (() => void) | undefined;
  const closers: Array<(error?: unknown) => void> = [];
  const signals: AbortSignal[] = [];
  const changeListeners: Array<(view: TaskView) => void> = [];
  let getFailures = 0;
  const bureau: A2APushBureau = {
    lifecycle: 'ready',
    eventHistory: (async (_owner: unknown, options?: { since?: string; limit?: number }) => {
      if (options?.limit !== 1 && beforeReplay !== undefined) {
        const hook = beforeReplay;
        beforeReplay = undefined;
        hook();
      }
      const since = options?.since === undefined ? -1 : Number(options.since);
      if (since < floor - 1) return { outcome: 'gap', firstRetainedSequence: floor };
      const events = history.filter((event) => Number(event.cursor) > since);
      const limit = options?.limit ?? 100;
      const page = events.slice(0, limit);
      return {
        events: page,
        hasMore: events.length > limit,
        nextCursor: page.at(-1)?.cursor,
      };
    }) as never,
    subscribeEventHistory: ((
      _owner: unknown,
      listener: (event: DurableEventEnvelope) => void,
      subscription?: { onClosed?: (error?: unknown) => void; signal?: AbortSignal },
    ) => {
      if (subscription?.signal !== undefined) signals.push(subscription.signal);
      listeners.push(listener);
      if (subscription?.onClosed !== undefined) closers.push(subscription.onClosed);
      return { unsubscribe: () => undefined };
    }) as never,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    tasks: {
      get: async (taskId: string) => {
        if (getFailures > 0) {
          getFailures -= 1;
          throw new Error('registry fault');
        }
        return taskId === 'task-1' ? view : undefined;
      },
      onSettled: () => () => undefined,
      onChanged: (_taskId: string, listener: (view: TaskView) => void) => {
        changeListeners.push(listener);
        return () => undefined;
      },
    },
  };
  return {
    bureau,
    history,
    append(event: DurableEventEnvelope) {
      history.push(event);
      for (const listener of listeners) listener(event);
    },
    trim(newFloor: number) {
      floor = newFloor;
      history.splice(
        0,
        history.length,
        ...history.filter((event) => Number(event.cursor) >= floor),
      );
    },
    setView(next: TaskView | undefined) {
      view = next;
    },
    /** Fails the next `count` registry reads. */
    failGets(count: number) {
      getFailures = count;
    },
    /** Tells the watchers the registry changed the task, with no durable event. */
    notifyChanged() {
      for (const listener of changeListeners) listener(view as TaskView);
    },
    /** Whether every history subscription has been stopped. */
    allUnsubscribed: () => signals.length > 0 && signals.every((signal) => signal.aborted),
    /** Runs `hook` just before the next paged replay reads the history. */
    beforeNextReplay(hook: () => void) {
      beforeReplay = hook;
    },
    /** Closes every live subscription with `error`, as a failing history store does. */
    closeSubscriptions(error: unknown) {
      for (const close of closers.splice(0)) close(error);
      listeners.splice(0);
    },
  };
}

const harnesses: Array<{ dispose(): Promise<void> }> = [];

async function cursorOf(checkpoints: A2APushCheckpoints): Promise<string | undefined> {
  const checkpoint = await checkpoints.read('task-1', 'config-1');
  return checkpoint?.cursor;
}
afterEach(async () => {
  for (const entry of harnesses.splice(0)) await entry.dispose();
});

function harness(initial: DurableEventEnvelope[] = []) {
  const stand = standIn(initial);
  const storage = new MemoryStorage();
  const receiver = new Receiver();
  const pushStore = createWeftPushNotificationStore({ storage, namespace: 'projector' });
  const adapter = createHttpDeliveryAdapter({
    ...pushNotificationResolvers(pushStore),
    signingSecrets: [SIGNING_SECRET],
    egressPolicy: createEgressPolicy({
      allowInsecureHttp: true,
      allowlist: [receiver.host],
      resolveHost: null,
    }),
  });
  const outbox = new Outbox({
    storage,
    namespace: 'projector',
    ownerId: 'push',
    adapter,
    retryBackoffMs: 20,
  });
  const sender = createOutboxPushNotificationSender({ outbox, pushStore });
  const kv = textValueStore(new MemoryStorage());
  const checkpoints = createA2APushCheckpoints(kv);
  const errors: unknown[] = [];
  const snapshots: TaskView[] = [];
  const projectorOver = (store: A2APushCheckpoints = checkpoints): A2APushProjector =>
    createA2APushProjector({
      bureau: stand.bureau,
      checkpoints: store,
      delivery: { sender, outbox },
      tenant: 'tenant',
      reader: {
        replyOf: async () => undefined,
        read: async (view) => {
          snapshots.push(view);
          const task: Task = {
            id: view.id,
            contextId: view.contextId,
            status: undefined,
            artifacts: [],
            history: [],
            metadata: { snapshotOf: view.status },
          };
          return { task, record: undefined };
        },
      },
      timers: createDefaultRuntimeServices().timers,
      onError: (error) => errors.push(error),
      retryMs: 20,
    });
  const projector = projectorOver();
  const delivery = new AbortController();
  const result = {
    ...stand,
    storage,
    receiver,
    pushStore,
    outbox,
    checkpoints,
    projector,
    projectorOver,
    errors,
    snapshots,
    startDelivery() {
      void startPushDelivery({ outbox, signal: delivery.signal, intervalMs: 10 });
    },
    /** A configuration for the receiver, checkpointed at `cursor`. */
    async configure(
      cursor: string,
      id = 'config-1',
      taskId = 'task-1',
      pending: false | 'committed' | 'uncommitted' = false,
    ) {
      if (pending !== 'uncommitted')
        await pushStore.create(taskId, projector.contextOf(CALLER), {
          id,
          taskId,
          url: receiver.url(),
          token: 'token',
          authentication: undefined,
          tenant: '',
        });
      await checkpoints.create({
        recordVersion: 1,
        taskId,
        configId: id,
        cursor,
        caller: CALLER,
        ...(pending === false ? {} : { pending: true as const }),
      });
    },
    async dispose() {
      delivery.abort();
      receiver.close();
      outbox.dispose();
      storage[Symbol.dispose]();
    },
  };
  harnesses.push(result);
  return result;
}

const started = envelope(0, 'run.started');
const working = (sequence: number) => envelope(sequence, 'review.approved', { reviewId: 'r' });
const requested = (sequence: number) => envelope(sequence, 'review.requested', { reviewId: 'r' });
const completed = (sequence: number) =>
  envelope(sequence, 'run.completed', { content: 'done', finishReason: 'stop' });

describe('the push projector', () => {
  it('delivers each status event once and advances its checkpoint', async () => {
    const fixture = harness([started, requested(1), working(2), completed(3)]);
    await fixture.configure('-1');
    fixture.startDelivery();

    await fixture.projector.pump('task-1', 'config-1');
    await eventually(() => fixture.receiver.kinds().includes('status:TASK_STATE_COMPLETED'));

    expect(fixture.receiver.kinds()).toEqual([
      'status:TASK_STATE_INPUT_REQUIRED',
      'status:TASK_STATE_WORKING',
      'artifact',
      'status:TASK_STATE_COMPLETED',
    ]);
    expect(await cursorOf(fixture.checkpoints)).toBe('3');

    // A restart finds nothing owed.
    await fixture.projectorOver().pump('task-1', 'config-1');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fixture.receiver.requests).toHaveLength(4);
  });

  it('replays a crash between the history append and the enqueue into one delivery', async () => {
    const fixture = harness([started, requested(1)]);
    await fixture.configure('0');
    // The event was appended while the process was down: nothing has enqueued it.
    fixture.startDelivery();

    await fixture.projectorOver().recover();
    await eventually(() => fixture.receiver.requests.length === 1);
    await fixture.projector.pump('task-1', 'config-1');
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(fixture.receiver.kinds()).toEqual(['status:TASK_STATE_INPUT_REQUIRED']);
  });

  it('replays a crash between the enqueue and the checkpoint into the same delivery', async () => {
    const fixture = harness([started, requested(1)]);
    await fixture.configure('0');
    fixture.startDelivery();
    let failures = 1;
    const failing: A2APushCheckpoints = {
      ...fixture.checkpoints,
      advance: async (taskId, configId, cursor) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error('the process died before the checkpoint was written');
        }
        return fixture.checkpoints.advance(taskId, configId, cursor);
      },
    };

    const crashed = fixture.projectorOver(failing);
    await crashed.pump('task-1', 'config-1').catch(() => undefined);
    await eventually(() => fixture.receiver.requests.length === 1);
    expect(await cursorOf(fixture.checkpoints)).toBe('0');

    await fixture.projectorOver().pump('task-1', 'config-1');
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(fixture.receiver.requests).toHaveLength(1);
    expect(await cursorOf(fixture.checkpoints)).toBe('1');
  });

  it('delivers nothing from before the cursor a configuration was created at', async () => {
    const fixture = harness([started, requested(1), working(2)]);
    await fixture.configure('2');
    fixture.startDelivery();
    fixture.projector.watch('task-1');

    fixture.append(completed(3));
    await eventually(() => fixture.receiver.kinds().includes('status:TASK_STATE_COMPLETED'));

    expect(fixture.receiver.kinds()).toEqual(['artifact', 'status:TASK_STATE_COMPLETED']);
  });

  it('delivers one current snapshot for a checkpoint below the floor, then only later events', async () => {
    const fixture = harness([started, requested(1), working(2), completed(3)]);
    await fixture.configure('0');
    fixture.trim(3);
    fixture.startDelivery();

    await fixture.projector.pump('task-1', 'config-1');
    await eventually(() => fixture.receiver.requests.length === 1);

    expect(fixture.receiver.kinds()).toEqual(['task:none']);
    expect(fixture.receiver.requests[0]?.body.task.metadata).toEqual({
      snapshotOf: 'completed',
    });
    expect(await cursorOf(fixture.checkpoints)).toBe('3');
    await fixture.projector.pump('task-1', 'config-1');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fixture.receiver.requests).toHaveLength(1);
  });

  it('holds the next event until the previous one is terminal', async () => {
    const fixture = harness([started, requested(1), working(2)]);
    await fixture.configure('0');
    // The first attempt fails and waits out its backoff; the second event must wait for it.
    fixture.receiver.statuses.push(503);
    fixture.startDelivery();

    await fixture.projector.pump('task-1', 'config-1');
    await eventually(() => fixture.receiver.requests.length === 3);

    expect(fixture.receiver.kinds()).toEqual([
      'status:TASK_STATE_INPUT_REQUIRED',
      'status:TASK_STATE_INPUT_REQUIRED',
      'status:TASK_STATE_WORKING',
    ]);
  });

  it('holds the next event behind its own open delivery among more than 200 others', async () => {
    const fixture = harness([started, requested(1), working(2)]);
    await fixture.configure('0');
    // Other configurations' deliveries, older than any this configuration enqueues, fill past
    // the first 200 an outbox listing returns.
    for (let index = 0; index < 210; index += 1) {
      const admission = await fixture.outbox.enqueue({
        destinationRef: `other-${index}`,
        credentialRef: `other-${index}`,
        kind: A2A_PUSH_DELIVERY_KIND,
        payload: { form: 'inline', value: '{}' },
        payloadMediaType: A2A_PUSH_CONTENT_TYPE,
        idempotencyKey: `filler-${index}`,
        externalIdempotencyKey: `filler-${index}`,
        unknownOutcomePolicy: 'retry-with-idempotency',
        maxAttempts: 1,
      });
      expect(admission.status).toBe('enqueued');
    }

    void fixture.projector.pump('task-1', 'config-1');
    await new Promise((resolve) => setTimeout(resolve, 400));

    // Delivery is not running, so the first event stays open and the second must not be enqueued.
    const destination = pushDestinationRef(
      fixture.projector.contextOf(CALLER),
      'task-1',
      'config-1',
    );
    expect(await openDeliveries(fixture.outbox, destination)).toHaveLength(1);
  });

  it('confirms a pending checkpoint whose configuration was committed, and delivery resumes', async () => {
    const fixture = harness([started, requested(1)]);
    // A crash after the checkpoint was written and the configuration committed, before the confirm.
    await fixture.configure('0', 'config-1', 'task-1', 'committed');
    fixture.startDelivery();
    await fixture.projector.pump('task-1', 'config-1');
    expect(fixture.receiver.requests).toHaveLength(0);

    await fixture.projectorOver().recover();

    await eventually(() => fixture.receiver.requests.length === 1);
    const confirmed = await fixture.checkpoints.read('task-1', 'config-1');
    expect(confirmed?.pending).toBeUndefined();
  });

  it('removes a pending checkpoint whose configuration was never committed', async () => {
    const fixture = harness([started, requested(1)]);
    await fixture.configure('0', 'config-1', 'task-1', 'uncommitted');

    await fixture.projectorOver().recover();

    expect(await fixture.checkpoints.read('task-1', 'config-1')).toBeUndefined();
  });

  it('cleans up a configuration installed after its task was removed', async () => {
    const fixture = harness([started]);
    await fixture.configure('0');
    fixture.setView(undefined);

    fixture.projector.watch('task-1');

    await eventually(
      async () => (await fixture.checkpoints.read('task-1', 'config-1')) === undefined,
    );
    const live = await fixture.pushStore.get(
      'task-1',
      'config-1',
      fixture.projector.contextOf(CALLER),
    );
    expect(live).toBeUndefined();
  });

  it('reports and retries a cleanup that rejects, without an unhandled rejection', async () => {
    const fixture = harness([started]);
    await fixture.configure('0');
    let failures = 1;
    const flaky: A2APushCheckpoints = {
      ...fixture.checkpoints,
      listForTask: async (taskId) => {
        if (failures-- > 0) throw new Error('storage fault');
        return fixture.checkpoints.listForTask(taskId);
      },
    };
    const projector = fixture.projectorOver(flaky);

    await projector.cleanup('task-1');

    expect(fixture.errors).toHaveLength(1);
    await eventually(
      async () => (await fixture.checkpoints.read('task-1', 'config-1')) === undefined,
    );
  });

  it('resubscribes after the history subscription closes with an error', async () => {
    const fixture = harness([started]);
    await fixture.configure('0');
    fixture.startDelivery();
    fixture.projector.watch('task-1');
    await new Promise((resolve) => setTimeout(resolve, 50));

    fixture.closeSubscriptions(new Error('history store fault'));
    fixture.append(requested(1));
    await new Promise((resolve) => setTimeout(resolve, 150));

    await eventually(() => fixture.receiver.requests.length === 1);
    expect(fixture.errors).toHaveLength(1);
  });

  it('sends a repair snapshot when retention advances past the checkpoint during the replay', async () => {
    const fixture = harness([started, requested(1), working(2), completed(3)]);
    await fixture.configure('0');
    fixture.startDelivery();
    fixture.beforeNextReplay(() => fixture.trim(3));

    await fixture.projector.pump('task-1', 'config-1');
    await eventually(() => fixture.receiver.requests.length === 1);

    expect(fixture.receiver.kinds()).toEqual(['task:none']);
  });

  it('delivers a failure the history never recorded, once the registry reports it', async () => {
    const fixture = harness([started]);
    await fixture.configure('0');
    fixture.startDelivery();
    fixture.projector.watch('task-1');
    await new Promise((resolve) => setTimeout(resolve, 50));

    fixture.setView({ ...VIEW, status: 'failed', finishReason: 'error' });
    fixture.notifyChanged();

    await eventually(() => fixture.receiver.kinds().includes('status:TASK_STATE_FAILED'));
  });

  it('delivers one terminal status when the registry settles before the history records it', async () => {
    const fixture = harness([started]);
    await fixture.configure('0');
    fixture.startDelivery();
    fixture.projector.watch('task-1');
    await new Promise((resolve) => setTimeout(resolve, 50));

    fixture.setView({ ...VIEW, status: 'completed', finishReason: 'stop' });
    fixture.notifyChanged();
    await eventually(() => fixture.receiver.kinds().includes('status:TASK_STATE_COMPLETED'));

    // The durable event arrives after, and so does a restart that replays it.
    fixture.append(completed(1));
    await fixture.projectorOver().pump('task-1', 'config-1');
    await fixture.projector.pump('task-1', 'config-1');
    await new Promise((resolve) => setTimeout(resolve, 200));

    const terminals = fixture.receiver
      .kinds()
      .filter((kind) => kind === 'status:TASK_STATE_COMPLETED');
    expect(terminals).toHaveLength(1);
  });

  it('retries a task-level pump that throws, with no later event to wake it', async () => {
    const fixture = harness([started, requested(1)]);
    await fixture.configure('0');
    fixture.startDelivery();
    fixture.failGets(1);

    fixture.projector.watch('task-1');

    await eventually(() => fixture.receiver.requests.length === 1);
    expect(fixture.errors).toHaveLength(1);
  });

  it('leaves no watcher on a task whose last configuration was deleted', async () => {
    const fixture = harness([started]);
    await fixture.configure('0');
    fixture.projector.watch('task-1');
    await new Promise((resolve) => setTimeout(resolve, 50));

    await fixture.pushStore.delete('task-1', fixture.projector.contextOf(CALLER), 'config-1');
    await fixture.checkpoints.remove('task-1', 'config-1');
    fixture.projector.watch('task-1');

    await eventually(() => fixture.allUnsubscribed());
  });

  it('delivers two events that serialize identically as two deliveries', async () => {
    const fixture = harness([started, requested(1), requested(2)]);
    await fixture.configure('0');
    fixture.startDelivery();

    await fixture.projector.pump('task-1', 'config-1');

    await eventually(() => fixture.receiver.requests.length === 2);
  });

  it('delivers an event that races the creation of a configuration', async () => {
    const fixture = harness([started]);
    fixture.startDelivery();
    const cursor = (await fixture.projector.tailOf('task-1')) as string;

    // The event lands after the cursor was read and before the configuration exists.
    fixture.append(requested(1));
    await fixture.configure(cursor);
    fixture.projector.watch('task-1');

    await eventually(() => fixture.receiver.requests.length === 1);
    expect(fixture.receiver.kinds()).toEqual(['status:TASK_STATE_INPUT_REQUIRED']);
  });

  it('deletes a removed task’s configurations and checkpoints, and a queued delivery never arrives', async () => {
    const fixture = harness([started, requested(1)]);
    await fixture.configure('0');
    // No delivery loop is running, so the enqueued delivery stays queued.
    const pumped = fixture.projector.pump('task-1', 'config-1');
    await eventually(async () => {
      const queued = await fixture.outbox.list({ states: ['queued'] });
      return queued.length === 1;
    });

    await fixture.projector.cleanup('task-1');
    await pumped.catch(() => undefined);
    fixture.startDelivery();
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(fixture.receiver.requests).toEqual([]);
    expect(await fixture.checkpoints.read('task-1', 'config-1')).toBeUndefined();
    expect(
      await fixture.pushStore.get('task-1', 'config-1', fixture.projector.contextOf(CALLER)),
    ).toBeUndefined();
  });

  it('removes the checkpoint of a configuration that was deleted, and of a task that is gone', async () => {
    const fixture = harness([started, requested(1)]);
    await fixture.configure('0');
    await fixture.configure('0', 'config-1', 'task-gone');
    await fixture.pushStore.delete('task-1', fixture.projector.contextOf(CALLER), 'config-1');

    await fixture.projectorOver().recover();
    await fixture.projector.pump('task-1', 'config-1');

    // The orphan sweep deleted the checkpoint of a task the Bureau no longer holds.
    expect(await fixture.checkpoints.read('task-gone', 'config-1')).toBeUndefined();
    expect(await fixture.checkpoints.read('task-1', 'config-1')).toBeUndefined();
    expect(fixture.errors).toEqual([]);
  });
});
