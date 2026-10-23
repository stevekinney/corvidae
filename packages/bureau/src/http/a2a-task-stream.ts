/**
 * Following one task as an A2A stream (COR-903, part 2a): what `SendStreamingMessage` and
 * `SubscribeToTask` send after admission.
 *
 * ## The snapshot and the tail
 *
 * Every stream, fresh or resumed, starts with the task's current `Task`, then carries only what
 * happens after it, so a client's state never moves backwards. Where the Bureau keeps a durable
 * event history, the snapshot and its cursor C are read together without a barrier: the task's
 * retained durable events are read to their end, C is the last one's cursor, and the status they
 * fold to is the snapshot's. The tail subscribes after C, which the history replays and then
 * follows without a gap or a duplicate, so each later event arrives exactly once, with its
 * cursor as its SSE `id`. The snapshot carries C as its own `id`.
 *
 * Only two status facts have no durable event: a run starting (`SUBMITTED` to `WORKING`) and a
 * failure that ended without one. They are read from the task registry and sent without an `id`.
 *
 * Without a durable history, the same sequence comes from the task registry alone, and no event
 * carries an `id`.
 *
 * ## Closing
 *
 * A stream ends once the task is terminal. It is closed early, and the client reconnects with
 * `Last-Event-ID`, when its reader falls behind the buffer (every stream for a task must carry the
 * same events, A2A 1.0.1 section 3.5.2, so it is not thinned), or when the history's retention
 * floor overtakes its next cursor. A stream's end never cancels the task.
 *
 * @module a2a-task-stream
 */

import type { Artifact, StreamResponse, Task, TaskState } from '@a2a-js/sdk';
import { RequestMalformedError } from '@a2a-js/sdk/errors';
import type { RuntimeTimers } from '@lostgradient/lifecycle';
import { decodeCursor, encodeCursor } from '@lostgradient/weft';
import { withStreamEventCursor } from '@lostgradient/weft/a2a';

import type { DurableEventEnvelope } from '@lostgradient/operative';

import { DURABLE_HISTORY_GAP_KIND } from '../durable-event-history.ts';
import type { TaskRegistry, TaskView } from '../task-registry.ts';
import type { Bureau } from '../types.ts';
import { formsOf, type WaitForm } from './a2a-input-forms.ts';
import {
  a2aStateOf,
  agentMessage,
  isTerminal,
  replyMessageId,
  publishedReplyParts,
  type ReplyParts,
  resultArtifactId,
  waitingMessage,
} from './a2a-task-projection.ts';
import { createTaskEventProjector, type TaskEvent } from './management/tasks-events-operation.ts';

/** The durable-history extension's URI (`packages/weft/documentation/a2a/extensions/durable-history-v1.md`). */
export const DURABLE_HISTORY_EXTENSION_URI =
  'https://github.com/stevekinney/weft/blob/main/packages/weft/documentation/a2a/extensions/durable-history-v1.md';

/** How many events a stream holds for a reader that has not caught up before it closes. */
export const A2A_STREAM_BUFFER = 256;

/** How many durable events one replay page reads. */
const REPLAY_PAGE_LIMIT = 200;

/** How long a follower waits between reads of a task no event has announced. */
const FOLLOW_POLL_MS = 1_000;

/** The part of a Bureau a stream reads. */
export type A2AStreamBureau = Pick<
  Bureau,
  | 'eventHistory'
  | 'subscribeEventHistory'
  | 'addEventListener'
  | 'removeEventListener'
  | 'getReview'
> & {
  readonly tasks: Pick<TaskRegistry, 'get' | 'onSettled' | 'onChanged'>;
};

/** What one stream needs beyond the Bureau. */
export type FollowTaskOptions = {
  readonly bureau: A2AStreamBureau;
  readonly taskId: string;
  /** The `Last-Event-ID` the client resumed with, if it did. */
  readonly lastEventId: string | undefined;
  /** Whether the request activated the durable-history extension. */
  readonly durableHistoryActive: boolean;
  /** Builds the `Task` a snapshot sends, from the task's view with the folded status. */
  readonly snapshot: (view: TaskView) => Promise<Task>;
  /** The agent's reply on a completed task, for its artifact and final status message. */
  readonly replyOf: (view: TaskView) => Promise<ReplyParts | undefined>;
  readonly timers: RuntimeTimers;
  readonly signal: AbortSignal | undefined;
  /** How many events the stream holds for a reader that has fallen behind. */
  readonly buffer?: number | undefined;
};

type Gap = { readonly requestedCursor: string; readonly firstRetainedCursor: string };

/** Refuses a `Last-Event-ID` that is not a cursor this server could have issued. */
export function requireCursor(lastEventId: string | undefined): string | undefined {
  if (lastEventId === undefined || lastEventId === '') return undefined;
  if (decodeCursor(lastEventId) === null) {
    throw new RequestMalformedError(
      `Last-Event-ID '${lastEventId}' is not a cursor of this server.`,
    );
  }
  return lastEventId;
}

/** Runs `work` once `previous` has settled, so steps applied to one stream keep their order. */
function chained(previous: Promise<void>, work: () => Promise<void>): Promise<void> {
  return (async () => {
    await previous.catch(() => undefined);
    await work();
  })();
}

/** A bounded queue: past its bound, it ends instead of growing, and the stream closes. */
function createQueue<T>(bound: number) {
  const items: T[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  let failure: { readonly error: unknown } | undefined;
  const notify = () => {
    const waiting = wake;
    wake = undefined;
    waiting?.();
  };
  return {
    push(item: T): void {
      if (ended) return;
      if (items.length >= bound) ended = true;
      else items.push(item);
      notify();
    },
    end(): void {
      ended = true;
      notify();
    },
    fail(error: unknown): void {
      failure ??= { error };
      ended = true;
      notify();
    },
    async next(): Promise<T | undefined> {
      for (;;) {
        const item = items.shift();
        if (item !== undefined) return item;
        if (failure !== undefined) throw failure.error;
        if (ended) return undefined;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

function statusUpdate(
  view: Pick<TaskView, 'id' | 'contextId'>,
  state: TaskState,
  timestamp: string,
  message?: Parameters<typeof agentMessage>[2],
): StreamResponse {
  return {
    payload: {
      $case: 'statusUpdate',
      value: {
        taskId: view.id,
        contextId: view.contextId,
        status: {
          state,
          message:
            message === undefined
              ? undefined
              : agentMessage(view, `${view.id}:${timestamp}`, message),
          timestamp,
        },
        metadata: undefined,
      },
    },
  };
}

function artifactUpdate(
  view: Pick<TaskView, 'id' | 'contextId'>,
  parts: ReplyParts,
): StreamResponse {
  const artifact: Artifact = {
    artifactId: resultArtifactId(view.id),
    name: 'result',
    description: '',
    parts: [...parts],
    metadata: undefined,
    extensions: [],
  };
  return {
    payload: {
      $case: 'artifactUpdate',
      value: {
        taskId: view.id,
        contextId: view.contextId,
        artifact,
        append: false,
        lastChunk: true,
        metadata: undefined,
      },
    },
  };
}

/** The events a projected status element becomes on an A2A stream: an artifact, then the status. */
export function eventsOf(
  view: TaskView,
  element: Extract<TaskEvent, { kind: 'task.status' }>,
  reply: ReplyParts | undefined,
  forms: readonly WaitForm[] = [],
): StreamResponse[] {
  const timestamp = new Date(element.emittedAtMs).toISOString();
  const state = a2aStateOf(element.status);
  if (element.status === 'completed') {
    const parts = publishedReplyParts(reply, element.artifact?.text);
    if (parts.length === 0) return [statusUpdate(view, state, timestamp)];
    return [
      artifactUpdate(view, parts),
      {
        payload: {
          $case: 'statusUpdate',
          value: {
            taskId: view.id,
            contextId: view.contextId,
            status: {
              state,
              message: agentMessage(view, replyMessageId(view.id), parts),
              timestamp,
            },
            metadata: undefined,
          },
        },
      },
    ];
  }
  if (element.status === 'failed') {
    return [
      statusUpdate(
        view,
        state,
        timestamp,
        element.message ?? element.finishReason ?? 'The task failed.',
      ),
    ];
  }
  if (element.status === 'input-required' && view.openWaits.length > 0) {
    // The waits are named, as a read's status message names them, so a stream client can address
    // the one it answers when several are open.
    const status = statusUpdate(view, state, timestamp);
    if (status.payload?.$case === 'statusUpdate') {
      status.payload.value.status!.message = waitingMessage(view, forms);
    }
    return [status];
  }
  return [statusUpdate(view, state, timestamp)];
}

/** Reads a task's retained durable events to their end, or `undefined` without a history. */
export async function readRetained(
  bureau: A2AStreamBureau,
  taskId: string,
  requested: string | undefined,
): Promise<
  { events: DurableEventEnvelope[]; gap: Gap | undefined; reached: string | undefined } | undefined
> {
  const owner = { kind: 'run', id: taskId } as const;
  let gap: Gap | undefined;
  if (requested !== undefined) {
    const probe = await bureau.eventHistory(owner, { since: requested, limit: 1 });
    if ('outcome' in probe && probe.outcome === 'unsupported-capability') return undefined;
    if ('outcome' in probe && probe.outcome === 'gap') {
      gap = {
        requestedCursor: requested,
        firstRetainedCursor: encodeCursor(probe.firstRetainedSequence),
      };
    }
  }
  const events: DurableEventEnvelope[] = [];
  let since: string | undefined;
  for (;;) {
    const page = await bureau.eventHistory(owner, {
      ...(since === undefined ? {} : { since }),
      limit: REPLAY_PAGE_LIMIT,
    });
    if ('outcome' in page) {
      if (page.outcome === 'unsupported-capability') return undefined;
      if (page.outcome === 'gap') {
        since = String(Math.max(page.firstRetainedSequence - 1, -1));
        continue;
      }
      break;
    }
    for (const event of page.events) {
      events.push(event);
      since = event.cursor;
    }
    if (!page.hasMore) break;
    since = page.nextCursor ?? since;
  }
  // Retention may have advanced past the requested cursor while the pages were read: the replay
  // skipped that gap without naming it, so look again and report it.
  if (requested !== undefined && gap === undefined) {
    const probe = await bureau.eventHistory(owner, { since: requested, limit: 1 });
    if ('outcome' in probe && probe.outcome === 'gap') {
      gap = {
        requestedCursor: requested,
        firstRetainedCursor: encodeCursor(probe.firstRetainedSequence),
      };
    }
  }
  return { events, gap, reached: since };
}

/** A task's retained durable events, as {@link readRetained} reads them. */
export type RetainedEvents = NonNullable<Awaited<ReturnType<typeof readRetained>>>;

/**
 * The projector that folds a task's retained durable events to its status. Reviews are known
 * only from their durable events, so a review is never counted twice; the terminal state comes
 * from the history when its event survived, and from the task otherwise.
 */
export function createFoldProjector(
  taskId: string,
  initial: TaskView,
  retained: RetainedEvents | undefined,
) {
  const terminalRetained =
    retained?.events.some((event) =>
      ['run.completed', 'run.error', 'run.aborted', 'run.tripwire'].includes(event.kind),
    ) ?? false;
  return createTaskEventProjector(taskId, {
    status: terminalRetained || !isTerminal(initial.status) ? 'working' : initial.status,
    finishReason: initial.finishReason,
    statusMessage: initial.statusMessage,
    // Retention can drop the event that opened a review and keep later ones: the task's own
    // open waits seed the fold, which is a set, so a retained event never counts one twice.
    openWaits: initial.openWaits,
  });
}

/**
 * Follows a task: its snapshot, then each change after it, until it is terminal. The caller has
 * already checked the caller may see the task and that a subscription to it is allowed.
 */
export async function* followTask(options: FollowTaskOptions): AsyncGenerator<StreamResponse> {
  const { bureau, taskId, signal } = options;
  const requested = requireCursor(options.lastEventId);
  const initial = await bureau.tasks.get(taskId);
  if (initial === undefined) return;
  const retained = await readRetained(bureau, taskId, requested);

  const projector = createFoldProjector(taskId, initial, retained);
  let folded: Extract<TaskEvent, { kind: 'task.status' }> | undefined;
  for (const event of retained?.events ?? []) {
    const element = projector.project(event);
    if (element?.kind === 'task.status') folded = element;
  }
  const cursor =
    retained === undefined
      ? undefined
      : (retained.events.at(-1)?.cursor ?? retained.reached ?? '-1');
  const snapshotView: TaskView =
    folded === undefined
      ? initial
      : {
          ...initial,
          status: folded.status,
          finishReason: folded.finishReason,
          statusMessage: folded.message,
        };
  const task = await options.snapshot(snapshotView);
  if (options.durableHistoryActive && cursor !== undefined) {
    task.metadata = {
      ...task.metadata,
      [DURABLE_HISTORY_EXTENSION_URI]: {
        cursor,
        ...(requested === undefined ? {} : { requestedCursor: requested }),
        ...(retained?.gap === undefined ? {} : { gap: retained.gap }),
      },
    };
  }
  const opening: StreamResponse = { payload: { $case: 'task', value: task } };
  const first = cursor === undefined ? opening : withStreamEventCursor(opening, cursor);
  if (isTerminal(snapshotView.status) || signal?.aborted === true) {
    yield first;
    return;
  }

  const queue = createQueue<{ event: StreamResponse; cursor?: string; ends?: boolean }>(
    options.buffer ?? A2A_STREAM_BUFFER,
  );
  let lastStatus = snapshotView.status;
  const stops: Array<() => void> = [];
  const abort = () => queue.end();
  signal?.addEventListener('abort', abort, { once: true });

  // The facts with no durable event: a run starting and, without a history, every change. A
  // view a listener is handed is the change itself, so a short-lived state (WORKING between a
  // review's close and the run's end) is seen even when the task has moved on by the next read.
  let watching = true;
  let considering: Promise<void> = Promise.resolve();
  const consider = (view: TaskView | undefined): Promise<void> => {
    considering = chained(considering, async () => {
      if (!watching) return;
      if (view === undefined) {
        queue.end();
        return;
      }
      if (retained === undefined) {
        if (view.status === lastStatus) return;
        lastStatus = view.status;
        const reply = view.status === 'completed' ? await options.replyOf(view) : undefined;
        const element = {
          kind: 'task.status' as const,
          taskId,
          cursor: '',
          emittedAtMs: Date.parse(view.updatedAt),
          status: view.status,
          finishReason: view.finishReason,
          message: view.statusMessage,
          artifact: null,
        };
        const forms = await formsOf(bureau, view);
        for (const event of eventsOf(view, element, reply, forms)) queue.push({ event });
        if (isTerminal(view.status)) queue.end();
      } else if (lastStatus === 'submitted' && view.status !== 'submitted') {
        lastStatus = 'working';
        queue.push({ event: statusUpdate(view, a2aStateOf('working'), view.updatedAt) });
      }
    });
    return considering;
  };
  const watchRegistry = async (): Promise<void> => {
    let wake: (() => void) | undefined;
    const notified = (view: TaskView) => {
      void consider(view);
      wake?.();
    };
    stops.push(
      bureau.tasks.onChanged(taskId, notified),
      bureau.tasks.onSettled(taskId, notified),
      () => {
        watching = false;
      },
    );
    for (;;) {
      if (signal?.aborted === true || !watching) return;
      await consider(await bureau.tasks.get(taskId));
      // With a history, the registry adds only a run's start; after it, the history follows.
      if (retained !== undefined && lastStatus !== 'submitted') return;
      if (retained === undefined && isTerminal(lastStatus)) return;
      await new Promise<void>((resolve) => {
        const timer = options.timers.setTimeout(resolve, FOLLOW_POLL_MS);
        wake = () => {
          wake = undefined;
          options.timers.clearTimeout(timer);
          resolve();
        };
      });
    }
  };
  void watchRegistry().catch((error: unknown) => queue.fail(error));

  if (retained === undefined) {
    // Without a history, a review opening or closing is read from the Bureau's own live review
    // events, folded by the same projector a history is, so both compositions send the same
    // sequence. The run's end is the registry's settlement.
    const reviewKinds = [
      'review.requested',
      'review.superseded',
      'review.approved',
      'review.denied',
      'review.rejected',
      'review.expired',
      'review.revoked',
      'review.canceled',
    ] as const;
    const onReview = (event: {
      readonly type: string;
      readonly runId: string;
      readonly reviewId: string;
    }) => {
      if (event.runId !== taskId) return;
      const element = projector.project({
        kind: event.type,
        cursor: '',
        emittedAtMs: Date.now(),
        payload: { reviewId: event.reviewId },
      });
      if (element?.kind !== 'task.status' || isTerminal(element.status)) return;
      considering = chained(considering, async () => {
        if (!watching || element.status === lastStatus) return;
        lastStatus = element.status;
        const view = (await bureau.tasks.get(taskId)) ?? initial;
        const forms = await formsOf(bureau, view);
        for (const mapped of eventsOf(view, element, undefined, forms)) {
          queue.push({ event: mapped });
        }
      });
    };
    for (const kind of reviewKinds) bureau.addEventListener(kind, onReview);
    stops.push(() => {
      for (const kind of reviewKinds) bureau.removeEventListener(kind, onReview);
    });
  }

  if (retained !== undefined) {
    let mapping: Promise<void> = Promise.resolve();
    const controller = new AbortController();
    stops.push(() => controller.abort());
    const subscription = bureau.subscribeEventHistory(
      { kind: 'run', id: taskId },
      (event) => {
        if (event.kind === DURABLE_HISTORY_GAP_KIND) {
          // Retention passed the next cursor: close rather than skip, and the client reconnects.
          // The close waits its turn, so an earlier event still being mapped is sent first.
          mapping = chained(mapping, async () => queue.end());
          return;
        }
        const element = projector.project(event);
        if (element === undefined) return;
        if (element.kind === 'task.removed') {
          mapping = chained(mapping, async () => queue.end());
          return;
        }
        if (element.kind !== 'task.status') return;
        lastStatus = element.status;
        // Whether this element ended the task, read now: a later event may end it before this
        // one is mapped.
        const endsTask = projector.ended;
        // Events are mapped one after another, so a slow reply lookup never lets a later event
        // overtake an earlier one.
        mapping = chained(mapping, async () => {
          const view = (await bureau.tasks.get(taskId)) ?? initial;
          const reply = element.status === 'completed' ? await options.replyOf(view) : undefined;
          const events = eventsOf(view, element, reply, await formsOf(bureau, view));
          for (const [index, mapped] of events.entries()) {
            // Only the last event of a durable one carries its cursor, so a resume never skips
            // the part of it a reader had not received.
            queue.push({
              event: mapped,
              ...(index === events.length - 1 ? { cursor: event.cursor } : {}),
              ends: endsTask && index === events.length - 1,
            });
          }
        }).catch((error: unknown) => queue.fail(error));
      },
      {
        since: cursor ?? '-1',
        signal: controller.signal,
        // A storage fault closes the subscription; the client reconnects instead of hanging.
        onClosed: (error) => queue.fail(error),
      },
    );
    stops.push(() => subscription.unsubscribe());
  }

  try {
    // The snapshot goes out only now, with every watcher already listening and buffering, so a
    // change between the snapshot and the consumer's next read is not lost.
    yield first;
    for (;;) {
      const next = await queue.next();
      if (next === undefined) return;
      yield next.cursor === undefined ? next.event : withStreamEventCursor(next.event, next.cursor);
      if (next.ends === true) return;
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    for (const stop of stops) stop();
  }
}
