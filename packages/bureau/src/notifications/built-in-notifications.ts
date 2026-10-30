/**
 * The notifications Bureau writes on its own (COR-1941), from events it already publishes.
 *
 * It listens to the bureau emitter, the source of the event feed, so it hears exactly the kinds
 * `PUBLISHED_BUREAU_EVENT_KINDS` lists, and acts on these (see {@link BUILT_IN_NOTIFICATION_KINDS}):
 *
 * - `run.settled` of a top-level task that ended `failed` writes `run.failed`, or
 *   `run.budget-exceeded` when it ended on the `budget-exceeded` finish reason. The event carries
 *   only the run id, so the task record, committed before the event is dispatched, supplies the
 *   owner, the agent, the chat and the outcome. A task that a parent run, a goal or an agent tool
 *   call started (its origin is `agent`, `goal` or `parent`) writes nothing, so a run that fans out
 *   into children notifies once, for itself.
 * - `review.requested` writes `review.waiting` for the run's owner.
 * - `review.approved`, `denied`, `rejected`, `expired`, `revoked` and `canceled` dismiss that
 *   `review.waiting`, because nothing waits on the owner any more. `review.superseded` does not
 *   when it re-gates an approval, which stays pending, but it does when the replay of a schedule
 *   fire (`system:replay`) closes a request whose attempt died before it committed its step
 *   (COR-1613): no decision can reach that request, so nothing waits on the owner.
 *
 * Each notification carries a `dedupeKey` built from what happened (`run.settled:<runId>`,
 * `review.waiting:<reviewId>`), never from the event feed's sequence, which restarts with the
 * process. An event that is dispatched again after a restart, or seen by a second process, finds
 * the first notification and writes nothing.
 *
 * A failed run's notification is owed from the moment its settlement commits (COR-1945): the task
 * registry writes an outbox entry (`notification-outbox.ts`) in the same conditional batch as the
 * settlement, and a write clears it once the notification exists. A process that dies in between, or
 * a storage error on the write, leaves the entry, and `repair()` at the next boot writes the
 * notification from the task record; the dedupe key makes a repeat, or a repair beside the live
 * write, a no-op, so a failed run has one notification, never none and never two.
 *
 * Writes are applied one at a time in the order the events arrived, so a review that closes right
 * after it opened dismisses a notification that exists. A write that fails is diagnosed and does
 * not stop the next; `drain()` resolves when every write started so far has settled, which
 * shutdown awaits before it closes the storage.
 *
 * @module built-in-notifications
 */

import { isTopLevelTaskOrigin } from '../task-origin.ts';
import { RunSettledEvent, ReviewRequestedEvent, ReviewSupersededEvent } from '../events.ts';
import {
  REPLAY_SUPERSEDING_PRINCIPAL,
  REVIEW_CLOSING_EVENT_KINDS,
} from '../review-closing-events.ts';
import { boundedReviewId } from '../review-decision-record.ts';
import { serializeUnknownError } from '../serialization.ts';
import type { TaskView } from '../task-registry.ts';
import type { DiagnosticSink } from '../types.ts';
import type { NotificationOutbox } from './notification-outbox.ts';
import type { NotificationStore } from './notification-store.ts';
import {
  type BuiltInNotificationKind,
  NOTIFICATION_FIELD_LIMITS,
  type NotificationInput,
  type NotificationSubject,
} from './notification-types.ts';

/** The finish reason of a run that ended because it exceeded a budget. */
const BUDGET_EXCEEDED_FINISH_REASON = 'budget-exceeded';

/** How much of an error is kept as the notification's body: its first line, cut here. */
const BODY_LINE_LIMIT = 200;

/** What {@link startBuiltInNotifications} listens to and writes through. */
export interface BuiltInNotificationsOptions {
  /** The bureau emitter. */
  readonly source: {
    toObservable(): { subscribe(next: (event: Event) => void): { unsubscribe(): void } };
  };
  readonly store: Pick<NotificationStore, 'create' | 'dismissByDedupeKey'>;
  /** Reads a task's record by id. */
  readonly tasks: { get(taskId: string): Promise<TaskView | undefined> };
  readonly diagnose: DiagnosticSink;
  /**
   * The failed runs whose notification is still owed (COR-1945). Absent, nothing is owed or
   * repaired.
   */
  readonly outbox?: NotificationOutbox | undefined;
}

/** The running built-in notifications. */
export interface BuiltInNotifications {
  /** Stops listening. Writes already started still settle; `drain()` waits for them. */
  stop(): void;
  /** Resolves when every write started so far, and any they start in turn, has settled. */
  drain(): Promise<void>;
  /**
   * Writes the notification of each failed run the outbox still owes (COR-1945), after a restart
   * or a failed write. Resolves when they have settled. A run whose notification already exists
   * writes nothing, so repairing twice, or beside the live write, produces one notification.
   */
  repair(): Promise<void>;
}

/** The dedupe key of a run's outcome: one per run, whichever kind it wrote. */
export function runNotificationDedupeKey(runId: string): string {
  return `run.settled:${runId}`;
}

/**
 * The dedupe key of a review's waiting notification. The key is stored, so the review id in it is
 * bounded as `reviewCanceledDedupeKey` bounds its own: an id that fits in 128 UTF-8 bytes appears
 * as is, and a longer one, such as a human wait on a long signal name, as a fixed-length digest.
 */
export function reviewNotificationDedupeKey(reviewId: string): string {
  const kind = reviewId.startsWith('approval:') ? 'approval' : 'human-wait';
  return `review.waiting:${boundedReviewId(reviewId, kind)}`;
}

/**
 * A failed task's `statusMessage` is the run's error serialized as JSON (`{ "name", "message", "cause",
 * ... }`) or plain text. Only its `message` is wanted, never the cause chain or a stack.
 */
function messageOf(statusMessage: string | null): string | null {
  if (statusMessage === null) return null;
  try {
    const parsed: unknown = JSON.parse(statusMessage);
    if (typeof parsed === 'object' && parsed !== null) {
      const message = (parsed as { message?: unknown }).message;
      return typeof message === 'string' ? message : null;
    }
  } catch {
    // Not JSON: it is the message.
  }
  return statusMessage;
}

function firstLine(statusMessage: string | null): string | undefined {
  const line = messageOf(statusMessage)
    ?.split('\n')
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate !== '');
  if (line === undefined) return undefined;
  const limit = Math.min(BODY_LINE_LIMIT, NOTIFICATION_FIELD_LIMITS.body);
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

function subjectOf(task: TaskView): NotificationSubject {
  return {
    runId: task.id,
    contextId: task.contextId,
    ...(task.agentName === null ? {} : { agentName: task.agentName }),
    ...(task.origin?.kind === 'schedule' ? { scheduleId: task.origin.scheduleId } : {}),
  };
}

/** The notification a settled task calls for, or `undefined` when it calls for none. */
export function notificationForSettledTask(task: TaskView): NotificationInput | undefined {
  if (task.status !== 'failed' || !isTopLevelTaskOrigin(task.origin)) return undefined;
  const kind: BuiltInNotificationKind =
    task.finishReason === BUDGET_EXCEEDED_FINISH_REASON ? 'run.budget-exceeded' : 'run.failed';
  const agent = task.agentName;
  const title =
    kind === 'run.budget-exceeded'
      ? agent === null
        ? 'A run exceeded its budget'
        : `${agent} exceeded its budget`
      : agent === null
        ? 'A run failed'
        : `${agent} failed`;
  const body = firstLine(task.statusMessage);
  return {
    owner: task.owner,
    kind,
    title: title.slice(0, NOTIFICATION_FIELD_LIMITS.title),
    ...(body === undefined ? {} : { body }),
    dedupeKey: runNotificationDedupeKey(task.id),
    subject: subjectOf(task),
  };
}

/** Starts the built-in notifications. */
export function startBuiltInNotifications(
  options: BuiltInNotificationsOptions,
): BuiltInNotifications {
  let tail: Promise<void> = Promise.resolve();

  const enqueue = (label: string, work: () => Promise<void>): void => {
    tail = tail.then(work).catch((error: unknown) => {
      options.diagnose({
        level: 'error',
        scope: 'notifications',
        message: `[bureau] Could not write the notification for ${label}: ${serializeUnknownError(error)}`,
        cause: error,
      });
    });
  };

  async function onRunSettled(runId: string): Promise<void> {
    const task = await options.tasks.get(runId);
    const input = task === undefined ? undefined : notificationForSettledTask(task);
    if (input !== undefined) await options.store.create(input);
    // COR-1946: a task first settled `owner-lost` (a failure notified) whose owner then really
    // completed or canceled it no longer has a failure to report.
    else if (task !== undefined && (task.status === 'completed' || task.status === 'canceled')) {
      await options.store.dismissByDedupeKey(runNotificationDedupeKey(runId));
    }
    // Cleared only once the notification exists (written now, or found under the run's dedupe
    // key), or the run calls for none; a write that threw above leaves the debt for the repair.
    await options.outbox?.clear(runId);
  }

  async function onReviewRequested(event: ReviewRequestedEvent): Promise<void> {
    // Read before the first await: the event is the dispatcher's.
    const { reviewId, runId, principal, kind } = event;
    const task = await options.tasks.get(runId);
    const agent = task?.agentName ?? null;
    const who = agent ?? 'An agent';
    // The subject is bounded like the key: a human wait on a long signal name carries its digest.
    const boundedId = boundedReviewId(
      reviewId,
      reviewId.startsWith('approval:') ? 'approval' : 'human-wait',
    );
    await options.store.create({
      owner: principal,
      kind: 'review.waiting',
      title: kind === 'tool-approval' ? `${who} needs your approval` : `${who} has a question`,
      dedupeKey: reviewNotificationDedupeKey(reviewId),
      subject: {
        runId,
        reviewId: reviewId.length <= NOTIFICATION_FIELD_LIMITS.subject ? reviewId : boundedId,
        reviewKind: kind,
        ...(task === undefined ? {} : { contextId: task.contextId }),
        ...(agent === null ? {} : { agentName: agent }),
      },
    });
  }

  const subscription = options.source.toObservable().subscribe((event) => {
    if (event instanceof RunSettledEvent) {
      const { runId } = event;
      enqueue(`run "${runId}"`, () => onRunSettled(runId));
    } else if (event instanceof ReviewRequestedEvent) {
      enqueue(`review "${event.reviewId}"`, () => onReviewRequested(event));
    } else if (
      REVIEW_CLOSING_EVENT_KINDS.has(event.type) ||
      (event instanceof ReviewSupersededEvent && event.principal === REPLAY_SUPERSEDING_PRINCIPAL)
    ) {
      const reviewId = (event as { reviewId?: unknown }).reviewId;
      if (typeof reviewId === 'string') {
        enqueue(`review "${reviewId}"`, async () => {
          await options.store.dismissByDedupeKey(reviewNotificationDedupeKey(reviewId));
        });
      }
    }
  });

  const drain = async (): Promise<void> => {
    let seen: Promise<void>;
    do {
      seen = tail;
      await seen;
    } while (seen !== tail);
  };

  return {
    stop: () => subscription.unsubscribe(),
    drain,
    async repair() {
      if (options.outbox === undefined) return;
      for (const runId of await options.outbox.pending()) {
        enqueue(`run "${runId}"`, () => onRunSettled(runId));
      }
      await drain();
    },
  };
}
