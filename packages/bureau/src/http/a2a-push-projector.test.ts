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
  createEgressPolicy,
  createHttpDeliveryAdapter,
  createOutboxPushNotificationSender,
  createWeftPushNotificationStore,
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
  let view = VIEW;
  const bureau: A2APushBureau = {
    lifecycle: 'ready',
    eventHistory: (async (_owner: unknown, options?: { since?: string; limit?: number }) => {
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
    subscribeEventHistory: ((_owner: unknown, listener: (event: DurableEventEnvelope) => void) => {
      listeners.push(listener);
      return { unsubscribe: () => undefined };
    }) as never,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    tasks: {
      get: async (taskId: string) => (taskId === 'task-1' ? view : undefined),
      onSettled: () => () => undefined,
      onChanged: () => () => undefined,
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
    setView(next: TaskView) {
      view = next;
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
    async configure(cursor: string, id = 'config-1', taskId = 'task-1') {
      await pushStore.create(taskId, projector.contextOf(CALLER), {
        id,
        taskId,
        url: receiver.url(),
        token: 'token',
        authentication: undefined,
        tenant: '',
      });
      await checkpoints.create({ recordVersion: 1, taskId, configId: id, cursor, caller: CALLER });
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
