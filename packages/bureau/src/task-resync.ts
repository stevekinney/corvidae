/**
 * The `task.resynced` durable event, and the repair that appends it (COR-1669, part 2b-3).
 *
 * A task's story is its durable events. When one fails to append, every reader of the history (a
 * `bureau.tasks.events` stream, an A2A stream, a push configuration) stays behind for good: the
 * event that moved the task is not there to be read. The repair appends one event that states
 * where the task stands now, so a reader that applies it is level with the task again.
 *
 * ## Persisted format
 *
 * - **owner**: the task's own run, `{ kind: 'run', id: <task id> }`, where its other events are.
 * - **kind**: {@link TASK_RESYNCED_EVENT_KIND}. The kind is additive inside the history's record
 *   wrapper, so the schema version stays 1, and a reader that does not list it drops it.
 * - **payload**: {@link TaskResyncedPayload}: the status the task shows, how its record says it
 *   settled (if it has), the identifiers of the reviews open on it, and the record's `revision`
 *   the payload described. A session run's answer is not carried: it lives in the transcript, and
 *   a reader of a completed task reads it from there, as it does for a `run.completed`.
 *
 * ## Protocol
 *
 * 1. A failed append of a run-owned event marks the task resync-pending in its task record
 *    (`TaskRecord.resyncPending`), before anything else.
 * 2. The repair then runs in the owner's append order ({@link DurableEventProducer.serialize}), so
 *    every append queued before it has settled, and reads the task there: the event it appends is
 *    the task as it stands after every earlier event, and a later change appends its own event
 *    after it. The repair marks the task first when it was found by comparison rather than by
 *    mark.
 * 3. The mark is cleared only once the append has committed, and only while the record is still at
 *    the revision the payload described: a change that landed meanwhile keeps the repair owed.
 * 4. Every boot and every durable maintenance pass repairs the tasks that are marked, and the
 *    settled session runs whose history holds no event that says how they ended (a process that
 *    died between the settlement and its append marks nothing). A task that has been repaired
 *    holds such an event, so it is not repaired again.
 *
 * A settled task whose settlement is older than the history's oldest retained event is left alone:
 * retention removes events from the front, so their absence is by design, and announcing it again
 * would repeat it every cycle.
 *
 * @module task-resync
 */

import type { DurableEventEnvelope, DurableEventOwner } from '@lostgradient/operative';

import type { DurableEventHistory, DurableEventProducer } from './durable-event-history.ts';
import type { TaskRecord, TaskRegistry, TaskView } from './task-registry.ts';

/** The `kind` of the event that restates where a task stands. */
export const TASK_RESYNCED_EVENT_KIND = 'task.resynced';

/** The payload of a {@link TASK_RESYNCED_EVENT_KIND} event. */
export interface TaskResyncedPayload {
  readonly runId: string;
  /** The record revision the payload described. */
  readonly revision: number;
  /** What the task shows now: a settled task with a review open is `input-required`. */
  readonly status: TaskView['status'];
  readonly finishReason: string | null;
  readonly message: string | null;
  /** How the task's record says it settled, or `null` while it has not. */
  readonly settled: {
    readonly status: 'completed' | 'failed' | 'canceled';
    readonly finishReason: string | null;
    readonly message: string | null;
    readonly answer: { readonly text: string; readonly truncated: boolean } | null;
  } | null;
  /** The reviews open on the task, by identifier only. */
  readonly openReviewIds: readonly string[];
}

/** The durable kinds that say how a run ended. */
const SETTLING_RUN_EVENT_KINDS: ReadonlySet<string> = new Set([
  'run.completed',
  'run.error',
  'run.aborted',
  'run.tripwire',
]);

/**
 * Whether an event says how its task ended: a terminal `run.*` event, or a resync whose record had
 * settled.
 */
export function bearsSettlement(event: {
  readonly kind: string;
  readonly payload: unknown;
}): boolean {
  if (SETTLING_RUN_EVENT_KINDS.has(event.kind)) return true;
  if (event.kind !== TASK_RESYNCED_EVENT_KIND) return false;
  const payload = event.payload;
  return (
    typeof payload === 'object' &&
    payload !== null &&
    typeof (payload as Record<string, unknown>)['settled'] === 'object' &&
    (payload as Record<string, unknown>)['settled'] !== null
  );
}

/** What the repair needs from the Bureau. */
export interface TaskResyncOptions {
  readonly tasks: Pick<
    TaskRegistry,
    'get' | 'record' | 'resyncCandidates' | 'markResyncPending' | 'clearResyncPending'
  >;
  readonly history: Pick<DurableEventHistory, 'page' | 'record' | 'retentionFloorTimestamp'>;
  readonly producer: Pick<DurableEventProducer, 'serialize'>;
  readonly diagnose: (message: string, cause: unknown) => void;
}

/** The repair. */
export interface TaskResync {
  /** Reacts to a failed append of `owner`'s event: marks the task, then repairs it in order. */
  appendFailed(owner: DurableEventOwner): Promise<void>;
  /**
   * Repairs one task if it is owed one. Resolves `true` when it appended a `task.resynced`
   * event, `false` when nothing was owed or the repair could not complete (the mark stays).
   */
  repair(taskId: string): Promise<boolean>;
  /** Repairs every task that is owed one. Resolves how many events it appended. */
  repairAll(): Promise<number>;
}

const PAGE_LIMIT = 200;

/** Creates the repair over `options`. */
export function createTaskResync(options: TaskResyncOptions): TaskResync {
  const { tasks, history, producer } = options;

  /** Every retained event of the task, or `undefined` when the history cannot be read. */
  async function retainedEvents(
    owner: DurableEventOwner,
  ): Promise<readonly DurableEventEnvelope[] | undefined> {
    const events: DurableEventEnvelope[] = [];
    let since: string | undefined;
    for (;;) {
      const page = await history.page(owner, {
        ...(since === undefined ? {} : { since }),
        limit: PAGE_LIMIT,
      });
      if ('outcome' in page) {
        if (page.outcome === 'gap') {
          since = String(Math.max(page.firstRetainedSequence - 1, -1));
          continue;
        }
        return undefined;
      }
      for (const event of page.events) {
        events.push(event);
        since = event.cursor;
      }
      if (!page.hasMore) return events;
      since = page.nextCursor ?? since;
    }
  }

  function payloadOf(view: TaskView, record: TaskRecord, revision: number): TaskResyncedPayload {
    return {
      runId: view.id,
      revision,
      status: view.status,
      finishReason: view.finishReason,
      message: view.statusMessage,
      settled:
        record.settled === undefined
          ? null
          : {
              status: record.settled.status,
              finishReason: record.settled.finishReason,
              message: record.settled.message,
              answer: record.settled.answer ?? null,
            },
      openReviewIds: view.openWaits.map((wait) => wait.reviewId),
    };
  }

  /** The repair itself. Runs in the task's append order. */
  async function repairInOrder(taskId: string): Promise<boolean> {
    const owner = { kind: 'run', id: taskId } as const;
    const record = await tasks.record(taskId);
    if (record === undefined || record.kind === 'schedule-fire' || record.incarnation === '') {
      return false;
    }
    const events = await retainedEvents(owner);
    if (events === undefined) return false;
    let owed = record.resyncPending === true;
    if (!owed && record.settled !== undefined && !events.some(bearsSettlement)) {
      // The settling event is lost only if the history still reaches back to the settlement:
      // one that starts later has retired it, by design, and a history with nothing in it says
      // nothing either way.
      const floor = await history.retentionFloorTimestamp();
      owed = floor !== undefined && Date.parse(record.settled.at) >= floor;
    }
    if (!owed) return false;
    const view = await tasks.get(taskId);
    if (view === undefined) return false;
    // A history that says the task ended while its record does not yet say so is ahead of the
    // record, which is about to catch up: restating the older state would put it behind.
    if (record.settled === undefined && events.some(bearsSettlement)) return false;
    const revision = record.revision ?? 0;
    // Marked first: a crash between here and the append leaves the repair owed.
    if (!(await tasks.markResyncPending(taskId))) return false;
    await history.record(owner, TASK_RESYNCED_EVENT_KIND, payloadOf(view, record, revision));
    await tasks.clearResyncPending(taskId, revision);
    return true;
  }

  async function repair(taskId: string): Promise<boolean> {
    let appended = false;
    await producer.serialize({ kind: 'run', id: taskId }, async () => {
      appended = await repairInOrder(taskId);
    });
    return appended;
  }

  return {
    async appendFailed(owner) {
      if (owner.kind !== 'run') return;
      try {
        if (!(await tasks.markResyncPending(owner.id))) return;
        await repair(owner.id);
      } catch (error) {
        options.diagnose(
          `Could not repair the history of task "${owner.id}" after a failed append`,
          error,
        );
      }
    },

    repair,

    async repairAll() {
      let appended = 0;
      for (const record of await tasks.resyncCandidates()) {
        try {
          if (await repair(record.taskId)) appended += 1;
        } catch (error) {
          options.diagnose(`Could not repair the history of task "${record.taskId}"`, error);
        }
      }
      return appended;
    },
  };
}
