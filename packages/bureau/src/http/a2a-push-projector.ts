/**
 * The push projector (COR-1543): A2A push notifications as a projection of a task's durable
 * event history.
 *
 * ## What it keeps
 *
 * Each push configuration has a persisted checkpoint (`a2a-push-checkpoint.ts`): the last
 * durable cursor whose events were enqueued for it. A configuration receives every event after
 * the cursor its checkpoint started at, and none before it (the client reads earlier state with
 * `GetTask`). The checkpoint advances only after the enqueue it records has committed, and the
 * enqueue is idempotent on the event, so a crash between the two replays into the same delivery
 * and the webhook receives the event once.
 *
 * ## Delivery order
 *
 * Weft's outbox lets a due delivery pass one in retry backoff, so the projector keeps at most
 * one unsettled delivery per configuration: it enqueues the next only once the previous is
 * terminal, and a webhook receives a configuration's updates in generation order.
 *
 * ## The retention floor
 *
 * A checkpoint that retention has overtaken cannot replay. The projector then folds the task's
 * retained events, enqueues one delivery carrying the task's current `Task` snapshot (a webhook
 * cannot reconnect to fetch it), and advances the checkpoint to the cursor that snapshot was read
 * at, so no event older than the snapshot follows it.
 *
 * ## Lifetime
 *
 * A configuration's task is watched from the durable history until its story ends. A restart
 * resumes every checkpoint ({@link A2APushProjector.recover}), and a task's removal deletes its
 * configurations through the sender's deletion path (fence, cancel, abort), then its checkpoints.
 *
 * @module a2a-push-projector
 */

import type { StreamResponse } from '@a2a-js/sdk';
import { ServerCallContext, type User } from '@a2a-js/sdk/server';
import type { RuntimeTimeoutHandle, RuntimeTimers } from '@lostgradient/lifecycle';
import {
  createOutboxPushNotificationSender,
  openDeliveries,
  pushDestinationRef,
  type OutboxPushNotificationSender,
} from '@lostgradient/weft/a2a';
import type { Outbox } from '@lostgradient/weft';

import type { TaskRegistry, TaskView } from '../task-registry.ts';
import type {
  A2APushCaller,
  A2APushCheckpoint,
  A2APushCheckpoints,
} from './a2a-push-checkpoint.ts';
import { isTerminal } from './a2a-task-projection.ts';
import type { A2ATaskReader } from './a2a-task-reader.ts';
import {
  type A2AStreamBureau,
  createFoldProjector,
  eventsOf,
  readRetained,
  type RetainedEvents,
} from './a2a-task-stream.ts';
import type { TaskEvent } from './management/tasks-events-operation.ts';

/** How long the projector waits between looks at a configuration's open deliveries. */
const SETTLE_POLL_MS = 100;

/** The longest a failing cleanup waits between attempts. */
const MAXIMUM_CLEANUP_BACKOFF_MS = 60_000;

/** How long a failed pump, cleanup, or subscription waits before it tries again. */
const RETRY_MS = 5_000;

/** How often the projector sweeps every checkpoint for a task that no longer exists. */
const SWEEP_MS = 3_600_000;

/** What the projector reads from a Bureau. */
export type A2APushBureau = A2AStreamBureau & {
  /** The Bureau's life: the projector stops once it is no longer `ready`. */
  readonly lifecycle: 'ready' | 'draining' | 'stopped';
  readonly tasks: Pick<TaskRegistry, 'get' | 'onSettled' | 'onChanged'>;
};

/** The sender and outbox a Bureau delivers push notifications through. */
export type A2APushDelivery = {
  readonly sender: OutboxPushNotificationSender;
  readonly outbox: Outbox;
};

/** What {@link createA2APushProjector} needs. */
export type A2APushProjectorOptions = {
  readonly bureau: A2APushBureau;
  readonly checkpoints: A2APushCheckpoints;
  readonly delivery: A2APushDelivery;
  /** The tenant the A2A mount stamps on every request, which scopes the push store. */
  readonly tenant: string;
  readonly reader: A2ATaskReader;
  readonly timers: RuntimeTimers;
  /** Told of a failure no request is waiting on. Defaults to `console.error`. */
  readonly onError?: ((error: unknown) => void) | undefined;
  /** How long a failure waits before its retry. Defaults to five seconds. */
  readonly retryMs?: number | undefined;
  /**
   * How long the projector waits between sweeps of every checkpoint, which clean up a
   * configuration or checkpoint whose task is gone and settle one written ahead of its
   * configuration. Defaults to one hour. A sweep also runs once, at start.
   */
  readonly sweepMs?: number | undefined;
};

/** The projector. */
export type A2APushProjector = {
  /** The call context that reproduces a configuration's caller scope. */
  contextOf(caller: A2APushCaller): ServerCallContext;
  /**
   * The cursor after the last event the task's history holds now, or `undefined` when the Bureau
   * keeps no durable history. A configuration created from it receives every later event.
   */
  tailOf(taskId: string): Promise<string | undefined>;
  /**
   * Starts projecting a task's history to its configurations: enqueues what each is owed now,
   * then follows the history until the task's story ends.
   */
  watch(taskId: string): void;
  /** Enqueues what one configuration is owed, once. Resolves when it has caught up. */
  pump(taskId: string, configId: string): Promise<void>;
  /**
   * Resumes every checkpoint, as a restarted process does. A task whose recovery fails does not
   * stop the others; the first failure is thrown once every task has been tried.
   */
  recover(): Promise<void>;
  /**
   * Recovers every task once and resolves, whatever failed: a task that failed keeps being
   * retried in the background with backoff, and holds up no other task. An install waits for
   * this, then takes its task's fence, which a retry of the same task's reconciliation also takes.
   */
  recoverUntilReady(): Promise<void>;
  /**
   * Stops the periodic sweep and clears its timer. The sweep also stops by itself the next time
   * it fires after the Bureau is no longer `ready`; this is for a host that releases the
   * projector earlier.
   */
  stop(): void;
  /**
   * Runs `work` once at a time per task, in call order. Every mutation of a task's push
   * configurations and checkpoints (an install, a delete, a removal's cleanup) runs through it, so
   * a create and a delete of the same id never interleave.
   */
  fence<T>(taskId: string, work: () => Promise<T>): Promise<T>;
  /**
   * Deletes a removed task's configurations through the sender's deletion path, then their
   * checkpoints. A checkpoint whose configuration will not delete is kept for a later attempt.
   */
  cleanup(taskId: string): Promise<void>;
};

/** The sequence a cursor names; `'-1'` is before the first event. */
function sequenceOf(cursor: string): number {
  const sequence = Number(cursor);
  return Number.isSafeInteger(sequence) ? sequence : -1;
}

/** Creates the projector over `options`. */
export function createA2APushProjector(options: A2APushProjectorOptions): A2APushProjector {
  const { bureau, checkpoints, delivery, tenant, reader, timers } = options;
  const retryMs = options.retryMs ?? RETRY_MS;
  const sweepMs = options.sweepMs ?? SWEEP_MS;
  const store = delivery.sender.pushStore;
  const stopped = (): boolean => bureau.lifecycle !== 'ready';
  const reportTo =
    options.onError ?? ((error: unknown) => console.error('A2A push projection failed:', error));
  // A Bureau that is shutting down stops its projections; what they fail with then is no news.
  const report = (error: unknown): void => {
    if (!stopped()) reportTo(error);
  };
  const flights = new Map<string, Promise<unknown>>();
  const dirty = new Set<string>();
  const watching = new Map<string, () => void>();
  const triggers = new Map<string, () => void>();

  /**
   * Runs `work` for `key` once at a time. A request that arrives meanwhile marks the key dirty,
   * and the work runs once more after the current run, so nothing recorded in between is missed.
   */
  function singleFlight<T>(key: string, work: () => Promise<T>): Promise<T> {
    const running = flights.get(key) as Promise<T> | undefined;
    if (running !== undefined) {
      dirty.add(key);
      return running;
    }
    const run = (async () => {
      try {
        let result: T;
        do {
          dirty.delete(key);
          result = await work();
        } while (dirty.has(key));
        return result;
      } finally {
        flights.delete(key);
      }
    })();
    flights.set(key, run);
    return run;
  }

  const fences = new Map<string, Promise<unknown>>();
  function fence<T>(taskId: string, work: () => Promise<T>): Promise<T> {
    const previous = fences.get(taskId) ?? Promise.resolve();
    const run = previous.then(work);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    fences.set(taskId, tail);
    void tail.finally(() => {
      if (fences.get(taskId) === tail) fences.delete(taskId);
    });
    return run;
  }

  function contextOf(caller: A2APushCaller): ServerCallContext {
    const user: User = { isAuthenticated: caller.authenticated, userName: caller.userName };
    return new ServerCallContext({ user, tenant });
  }

  async function sleep(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) => {
      timers.setTimeout(resolve, milliseconds);
    });
  }

  /** Waits until no delivery to `destination` can still move. */
  async function settled(destination: string): Promise<void> {
    for (;;) {
      if (stopped()) throw new Error('The Bureau stopped.');
      const open = await openDeliveries(delivery.outbox, destination);
      if (open.length === 0) return;
      await sleep(SETTLE_POLL_MS);
    }
  }

  /** The sender that enqueues for one configuration only, not every configuration of the task. */
  function senderOf(configId: string): OutboxPushNotificationSender {
    return createOutboxPushNotificationSender({
      outbox: delivery.outbox,
      pushStore: {
        ...store,
        load: async (taskId, context) => {
          const configurations = await store.load(taskId, context);
          return configurations.filter((config) => config.id === configId);
        },
      },
    });
  }

  async function tailOf(taskId: string): Promise<string | undefined> {
    const retained = await readRetained(bureau, taskId, undefined);
    if (retained === undefined) return undefined;
    return retained.events.at(-1)?.cursor ?? retained.reached ?? '-1';
  }

  /** Enqueues what the configuration is owed. Resolves whether the task's story has ended. */
  async function pumpOnce(taskId: string, configId: string): Promise<boolean> {
    const checkpoint = await checkpoints.read(taskId, configId);
    if (checkpoint === undefined) return true;
    // Its configuration may not exist yet: recovery or the install itself settles it.
    if (checkpoint.pending === true) return false;
    const context = contextOf(checkpoint.caller);
    if ((await store.get(taskId, configId, context)) === undefined) {
      await checkpoints.remove(taskId, configId);
      return true;
    }
    const initial = await bureau.tasks.get(taskId);
    if (initial === undefined) return true;
    const retained = await readRetained(bureau, taskId, checkpoint.cursor);
    if (retained === undefined) return true;
    const projector = createFoldProjector(taskId, initial, retained);
    const destination = pushDestinationRef(context, taskId, configId);
    const sender = senderOf(configId);

    /** Enqueues one event once the configuration's previous delivery is terminal. */
    const send = async (response: StreamResponse, eventKey: string): Promise<boolean> => {
      await settled(destination);
      // A deleted configuration is owed nothing.
      if ((await store.get(taskId, configId, context)) === undefined) return false;
      await sender.sendKeyed(response, context, eventKey);
      return true;
    };

    if (retained.gap !== undefined) {
      return snapshotPump({ taskId, configId, initial, retained, projector, send, checkpoint });
    }
    const floor = sequenceOf(checkpoint.cursor);
    let view: TaskView | undefined;
    let terminalSent = checkpoint.terminalSent !== undefined;
    for (const event of retained.events) {
      const element = projector.project(event);
      if (sequenceOf(event.cursor) <= floor) continue;
      if (element?.kind === 'task.removed') return true;
      if (element?.kind === 'task.status') {
        view ??= (await bureau.tasks.get(taskId)) ?? initial;
        const reply = element.status === 'completed' ? await reader.replyOf(view) : undefined;
        // One terminal delivery per configuration, whichever source fired first.
        const duplicateTerminal = isTerminal(element.status) && terminalSent;
        const responses = duplicateTerminal ? [] : eventsOf(view, element, reply);
        for (const [index, response] of responses.entries()) {
          if (!(await send(response, `${event.cursor}:${index}`))) return true;
        }
        if (isTerminal(element.status) && !terminalSent) {
          terminalSent = true;
          await checkpoints.markTerminal(taskId, configId, element.status);
        }
      }
      await checkpoints.advance(taskId, configId, event.cursor);
    }
    const reached = retained.events.at(-1)?.cursor ?? retained.reached;
    if (reached !== undefined) await checkpoints.advance(taskId, configId, reached);
    // A task can settle without a durable event (a failure the history never recorded): its
    // registry state is then the only record, so the settled status is sent from it. The key
    // names the status, so a repeat of this pump deduplicates.
    if (!projector.ended && !terminalSent && isTerminal(initial.status)) {
      const settledElement: Extract<TaskEvent, { kind: 'task.status' }> = {
        kind: 'task.status',
        taskId,
        cursor: reached ?? '-1',
        emittedAtMs: Date.parse(initial.updatedAt),
        status: initial.status,
        finishReason: initial.finishReason,
        message: initial.statusMessage,
        artifact: null,
      };
      const reply = initial.status === 'completed' ? await reader.replyOf(initial) : undefined;
      for (const [index, response] of eventsOf(initial, settledElement, reply).entries()) {
        if (!(await send(response, `settled:${initial.status}:${index}`))) return true;
      }
      await checkpoints.markTerminal(taskId, configId, initial.status);
      return true;
    }
    return projector.ended;
  }

  /** Delivers the task's current snapshot, for a checkpoint the retention floor has overtaken. */
  async function snapshotPump(input: {
    readonly taskId: string;
    readonly configId: string;
    readonly initial: TaskView;
    readonly retained: RetainedEvents;
    readonly projector: ReturnType<typeof createFoldProjector>;
    readonly send: (response: StreamResponse, eventKey: string) => Promise<boolean>;
    readonly checkpoint: A2APushCheckpoint;
  }): Promise<boolean> {
    const { taskId, configId, initial, retained, projector, checkpoint } = input;
    let folded: Extract<TaskEvent, { kind: 'task.status' }> | undefined;
    for (const event of retained.events) {
      const element = projector.project(event);
      if (element?.kind === 'task.status') folded = element;
    }
    const cursor = retained.events.at(-1)?.cursor ?? retained.reached ?? '-1';
    // A configuration is owed one terminal delivery: a gap after it was sent repairs nothing.
    if (checkpoint.terminalSent !== undefined) {
      await checkpoints.advance(taskId, configId, cursor);
      return true;
    }
    // A settled registry state is authoritative: a task can settle without a durable event, so a
    // retained status older than that must not roll the snapshot back to a live one.
    const view: TaskView =
      folded === undefined || isTerminal(initial.status)
        ? initial
        : {
            ...initial,
            status: folded.status,
            finishReason: folded.finishReason,
            statusMessage: folded.message,
          };
    const { task } = await reader.read(view, { includeArtifacts: true, activated: new Set() });
    if (!(await input.send({ payload: { $case: 'task', value: task } }, `snapshot:${cursor}`))) {
      return true;
    }
    await checkpoints.advance(taskId, configId, cursor);
    if (isTerminal(view.status)) await checkpoints.markTerminal(taskId, configId, view.status);
    return projector.ended || isTerminal(view.status);
  }

  /** Pumps every configuration of a task. Resolves whether every story has ended. */
  async function pumpTask(taskId: string): Promise<boolean> {
    // A configuration installed in the window after its task was removed is cleaned up here, as
    // the removal listener's own pass could already have finished.
    if ((await bureau.tasks.get(taskId)) === undefined) {
      await cleanup(taskId);
      return true;
    }
    const configured = await checkpoints.listForTask(taskId);
    const ended = await Promise.all(
      configured.map(async ({ configId }) => {
        try {
          return await pumpGuarded(taskId, configId);
        } catch (error) {
          report(error);
          retryLater(taskId, configId);
          return false;
        }
      }),
    );
    return ended.every(Boolean);
  }

  function pumpGuarded(taskId: string, configId: string): Promise<boolean> {
    return singleFlight(`${taskId}\u0000${configId}`, () => pumpOnce(taskId, configId));
  }

  function retryLater(taskId: string, configId: string): void {
    if (stopped()) return;
    timers.setTimeout(() => {
      void pumpGuarded(taskId, configId).catch(() => retryLater(taskId, configId));
    }, retryMs);
  }

  function watch(taskId: string): void {
    const existing = triggers.get(taskId);
    if (existing !== undefined) {
      // A configuration installed on a task already watched is pumped now.
      existing();
      return;
    }
    const controller = new AbortController();
    let subscription: AbortController = controller;
    const stop = () => {
      // A watcher that was replaced must not remove the one that replaced it.
      if (watching.get(taskId) === stop) {
        watching.delete(taskId);
        triggers.delete(taskId);
      }
      controller.abort();
      subscription.abort();
      for (const unwatch of unwatchRegistry) unwatch();
    };
    watching.set(taskId, stop);
    let pending = Promise.resolve();
    let queued = false;
    let failures = 0;
    const trigger = (): void => {
      // Events that arrive while a pump is queued are covered by it: it reads the history itself.
      if (queued) return;
      queued = true;
      pending = pending
        .then(async () => {
          queued = false;
          if (controller.signal.aborted) return undefined;
          const ended = await pumpTask(taskId);
          failures = 0;
          if (ended) stop();
          return undefined;
        })
        .catch((error: unknown) => {
          report(error);
          // The task-level pump failed before any configuration's own retry could start, and no
          // later event is owed: try again, a little later each time.
          if (controller.signal.aborted || stopped()) return;
          const delay = Math.min(retryMs * 2 ** failures, MAXIMUM_CLEANUP_BACKOFF_MS);
          failures += 1;
          timers.setTimeout(() => {
            if (!controller.signal.aborted && !stopped()) trigger();
          }, delay);
        });
    };
    triggers.set(taskId, trigger);
    // The registry changes a task without a durable event (it starts working, or fails with no
    // record), so its changes pump too, as a stream's do.
    const unwatchRegistry = [
      bureau.tasks.onChanged(taskId, () => trigger()),
      bureau.tasks.onSettled(taskId, () => trigger()),
    ];
    const subscribe = (): void => {
      subscription = new AbortController();
      const current = subscription;
      bureau.subscribeEventHistory(
        { kind: 'run', id: taskId },
        // A removal is pumped too: the pump finds the task gone and cleans up what the removal
        // listener's own pass did not see.
        () => trigger(),
        {
          signal: current.signal,
          onClosed: (error) => {
            if (controller.signal.aborted || current.signal.aborted) return;
            report(error);
            // A closed subscription is not the end of the story: look again, then resume it.
            if (stopped()) return;
            timers.setTimeout(() => {
              if (controller.signal.aborted || stopped()) return;
              subscribe();
              trigger();
            }, retryMs);
          },
        },
      );
    };
    subscribe();
    trigger();
  }

  async function cleanup(taskId: string, attempt = 0): Promise<void> {
    watching.get(taskId)?.();
    let failed = false;
    try {
      await fence(taskId, async () => {
        for (const checkpoint of await checkpoints.listForTask(taskId)) {
          try {
            await store.delete(taskId, contextOf(checkpoint.caller), checkpoint.configId);
            await checkpoints.remove(taskId, checkpoint.configId);
          } catch (error) {
            failed = true;
            report(error);
          }
        }
      });
    } catch (error) {
      failed = true;
      report(error);
    }
    // What a failed cleanup left behind is retried, not left for a restart.
    if (failed && !stopped()) {
      timers.setTimeout(
        () => {
          void cleanup(taskId, attempt + 1);
        },
        Math.min(retryMs * 2 ** attempt, MAXIMUM_CLEANUP_BACKOFF_MS),
      );
    }
  }

  /**
   * Settles checkpoints written ahead of their configuration: one whose configuration was
   * committed is confirmed, and one whose configuration never was is removed.
   */
  async function reconcile(taskId: string): Promise<void> {
    for (const checkpoint of await checkpoints.listForTask(taskId)) {
      if (checkpoint.pending !== true) continue;
      const configuration = await store.get(
        taskId,
        checkpoint.configId,
        contextOf(checkpoint.caller),
      );
      if (configuration === undefined) {
        await checkpoints.removePending(taskId, checkpoint.configId, checkpoint.installId);
      } else await checkpoints.confirm(taskId, checkpoint.configId);
    }
  }

  /** Recovers one task's checkpoints. Resolves the failure, or `undefined` on success. */
  async function recoverTask(taskId: string): Promise<{ readonly error: unknown } | undefined> {
    try {
      if ((await bureau.tasks.get(taskId)) === undefined) await cleanup(taskId);
      else {
        // Under the task's fence, so an install of the same task cannot race its reconciliation.
        await fence(taskId, () => reconcile(taskId));
        watch(taskId);
      }
      return undefined;
    } catch (error) {
      return { error };
    }
  }

  /** Tries every task; resolves the failures. A task's failure never stops the others. */
  async function recoverTasks(taskIds: readonly string[]) {
    const failures: Array<{ readonly taskId: string; readonly error: unknown }> = [];
    for (const taskId of taskIds) {
      const failure = await recoverTask(taskId);
      if (failure !== undefined) failures.push({ taskId, error: failure.error });
    }
    return failures;
  }

  async function recover(): Promise<void> {
    const failures = await recoverTasks(await checkpoints.listTaskIds());
    if (failures[0] !== undefined) throw failures[0].error;
  }

  /** Keeps trying `taskIds` (or, when `undefined`, the whole listing) until all have recovered. */
  function retryRecovery(taskIds: readonly string[] | undefined, attempt: number): void {
    if (stopped()) return;
    timers.setTimeout(
      () => {
        void (async () => {
          if (stopped()) return;
          try {
            const failures = await recoverTasks(taskIds ?? (await checkpoints.listTaskIds()));
            for (const failure of failures) report(failure.error);
            if (failures.length > 0) {
              retryRecovery(
                failures.map((failure) => failure.taskId),
                attempt + 1,
              );
            }
          } catch (error) {
            report(error);
            retryRecovery(taskIds, attempt + 1);
          }
        })();
      },
      Math.min(retryMs * 2 ** attempt, MAXIMUM_CLEANUP_BACKOFF_MS),
    );
  }

  /**
   * One pass over every task, after which installs may proceed whatever its outcome: a task that
   * failed keeps being retried in the background, and its failure holds up no other task.
   */
  async function recoverUntilReady(): Promise<void> {
    let taskIds: string[];
    try {
      taskIds = await checkpoints.listTaskIds();
    } catch (error) {
      report(error);
      retryRecovery(undefined, 0);
      return;
    }
    const failures = await recoverTasks(taskIds);
    for (const failure of failures) report(failure.error);
    if (failures.length > 0) {
      retryRecovery(
        failures.map((failure) => failure.taskId),
        0,
      );
    }
  }

  let sweepTimer: RuntimeTimeoutHandle;
  let sweepArmed = false;
  let sweeping = true;

  /**
   * Recovers every checkpointed task again: a task that no longer exists has its configurations
   * and checkpoints removed, and one written ahead of its configuration is settled. A failure is
   * reported and left for the next sweep (a cleanup retries itself).
   */
  async function sweep(): Promise<void> {
    const failures = await recoverTasks(await checkpoints.listTaskIds());
    for (const failure of failures) report(failure.error);
  }

  /** Arms the next sweep. The timer never keeps the process alive, and the chain ends with the Bureau. */
  function armSweep(): void {
    if (!sweeping || stopped()) return;
    const handle = timers.setTimeout(() => {
      sweepArmed = false;
      if (!sweeping || stopped()) return;
      void singleFlight('sweep', sweep).catch(report).finally(armSweep);
    }, sweepMs);
    (handle as { unref?: () => void } | undefined)?.unref?.();
    sweepTimer = handle;
    sweepArmed = true;
  }

  function stopSweeping(): void {
    sweeping = false;
    if (sweepArmed) timers.clearTimeout(sweepTimer);
    sweepArmed = false;
  }

  return {
    contextOf,
    tailOf,
    watch,
    pump: async (taskId, configId) => {
      await pumpGuarded(taskId, configId);
    },

    recover,

    recoverUntilReady: async () => {
      await recoverUntilReady();
      armSweep();
    },

    stop: stopSweeping,

    fence,

    cleanup,
  };
}
