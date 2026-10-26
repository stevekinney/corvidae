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
 * A stream ends once the task is terminal, by the history's terminal event. Where that event could
 * not be appended and its repair has not landed (the task's record is marked resync-pending), the
 * stream ends with a live update read from the registry instead, sent without an `id`: the same
 * status and answer the repair will state, so the client is not left waiting on a history that
 * may not come. It is closed early, and the client reconnects with
 * `Last-Event-ID`, when its reader falls behind the buffer (every stream for a task must carry the
 * same events, A2A 1.0.1 section 3.5.2, so it is not thinned), or when the history's retention
 * floor overtakes its next cursor. A stream's end never cancels the task.
 *
 * @module a2a-task-stream
 */

import type { Artifact, Part, StreamResponse, Task, TaskState } from '@a2a-js/sdk';
import { RequestMalformedError } from '@a2a-js/sdk/errors';
import type { RuntimeTimeoutHandle, RuntimeTimers } from '@lostgradient/lifecycle';
import { decodeCursor, encodeCursor } from '@lostgradient/weft';
import { withStreamEventCursor } from '@lostgradient/weft/a2a';

import type { DurableEventEnvelope } from '@lostgradient/operative';

import { A2UI_EXTENSION_URI, offeredCatalogIds } from '../a2ui/catalogs.ts';
import { a2uiMessagesOf } from '../a2ui/messages.ts';
import { DURABLE_HISTORY_GAP_KIND } from '../durable-event-history.ts';
import { INTERACTIVE_SURFACE_EVENT_KINDS } from '../interactive-surface/store.ts';
import type { InteractiveSurface } from '../interactive-surface/types.ts';
import type { TaskRegistry, TaskView } from '../task-registry.ts';
import { bearsSettlement } from '../task-resync.ts';
import type { Bureau } from '../types.ts';
import { formsOf, type WaitForm, withPreviousForms } from './a2a-input-forms.ts';
import {
  a2aStateOf,
  agentMessage,
  isTerminal,
  replyMessageId,
  publishedReplyParts,
  deleteSurfacePart,
  type ReplyParts,
  resultArtifactId,
  surfaceParts,
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
  readonly tasks: Pick<TaskRegistry, 'get' | 'record' | 'onSettled' | 'onChanged'>;
};

/** The durable event kinds that change a surface: each one makes a stream re-read its surfaces. */
const SURFACE_KINDS: ReadonlySet<string> = new Set([
  INTERACTIVE_SURFACE_EVENT_KINDS.created,
  INTERACTIVE_SURFACE_EVENT_KINDS.updated,
  INTERACTIVE_SURFACE_EVENT_KINDS.closed,
  INTERACTIVE_SURFACE_EVENT_KINDS.frozen,
]);

/**
 * How a stream follows a task's A2UI surfaces (COR-837, part 3). Supplied only for a request that
 * activated A2UI's extension: any other client gets no per-revision surface frames.
 */
export type FollowSurfaces = {
  /** The task's surfaces as the stream's owner may see them. */
  readonly list: (taskId: string) => Promise<readonly InteractiveSurface[]>;
  /** The catalogs the client declared; `undefined` offers the basic catalog only. */
  readonly supportedCatalogIds: readonly string[] | undefined;
  /**
   * Freezes the task's open surfaces now that its run has ended, resolving once they are written.
   * The stream awaits it before its closing reconcile, so it never ends ahead of a freeze that the
   * task record's settlement (the surface store's own trigger) has not yet started.
   */
  readonly settle: (
    taskId: string,
    status: 'completed' | 'failed' | 'canceled',
  ) => Promise<unknown>;
};

/** What the opening snapshot hands back: the task, and the surfaces it showed. */
export type OpeningSnapshot = {
  readonly task: Task;
  readonly surfaces: readonly InteractiveSurface[];
};

/** What one stream needs beyond the Bureau. */
export type FollowTaskOptions = {
  readonly bureau: A2AStreamBureau;
  readonly taskId: string;
  /** The `Last-Event-ID` the client resumed with, if it did. */
  readonly lastEventId: string | undefined;
  /** Whether the request activated the durable-history extension. */
  readonly durableHistoryActive: boolean;
  /** Whether the request activated A2UI, so a status that asks for input carries its form. */
  readonly a2ui?: boolean | undefined;
  /** Builds the `Task` a snapshot sends, from the task's view with the folded status. */
  readonly snapshot: (view: TaskView) => Promise<OpeningSnapshot>;
  /** Present when the request activated A2UI: the stream then delivers each surface revision once. */
  readonly surfaces?: FollowSurfaces | undefined;
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
  a2ui = false,
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
      status.payload.value.status!.message = waitingMessage(view, forms, a2ui);
    }
    return [status];
  }
  return [statusUpdate(view, state, timestamp)];
}

/**
 * A status element, or a `task.resynced` read as one (it restates the status a failed append lost,
 * COR-1669); `undefined` for any other element.
 */
export function statusElementOf(
  element: TaskEvent | undefined,
): Extract<TaskEvent, { kind: 'task.status' }> | undefined {
  if (element?.kind === 'task.status') return element;
  if (element?.kind !== 'task.resynced') return undefined;
  const { revision: _revision, ...status } = element;
  return { ...status, kind: 'task.status' };
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
 * The view with the waits the durable events say are open. A registry read made after an event can
 * lag it, listing fewer waits than the event opened; the waits an `INPUT_REQUIRED` update names are
 * those of the events folded, each read as the registry lists it or, failing that, from its review.
 */
async function withOpenWaits(
  bureau: A2AStreamBureau,
  view: TaskView,
  reviewIds: readonly string[],
): Promise<TaskView> {
  const openWaits: TaskView['openWaits'][number][] = [];
  for (const reviewId of reviewIds) {
    const listed = view.openWaits.find((wait) => wait.reviewId === reviewId);
    if (listed !== undefined) {
      openWaits.push(listed);
      continue;
    }
    const review = await bureau.getReview(reviewId).catch(() => undefined);
    if (review?.kind === 'human-wait') {
      openWaits.push({ kind: 'human-wait', reviewId, signalName: review.signalName });
    } else if (review?.kind === 'tool-approval') {
      openWaits.push({ kind: 'tool-approval', reviewId, callId: review.approval.callId });
    }
  }
  return { ...view, openWaits };
}

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
  const terminalRetained = retained?.events.some((event) => bearsSettlement(event)) ?? false;
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
  /** A view's forms; with A2UI activated, each also names the form it replaces. */
  const formsFor = async (view: TaskView) => {
    const forms = await formsOf(bureau, view);
    return options.a2ui === true ? withPreviousForms(bureau, view, forms) : forms;
  };
  const requested = requireCursor(options.lastEventId);
  const initial = await bureau.tasks.get(taskId);
  if (initial === undefined) return;
  const retained = await readRetained(bureau, taskId, requested);

  const projector = createFoldProjector(taskId, initial, retained);
  let folded: Extract<TaskEvent, { kind: 'task.status' }> | undefined;
  for (const event of retained?.events ?? []) {
    const element = statusElementOf(projector.project(event));
    if (element !== undefined) folded = element;
  }
  const cursor =
    retained === undefined
      ? undefined
      : (retained.events.at(-1)?.cursor ?? retained.reached ?? '-1');
  const foldedView: TaskView =
    folded === undefined
      ? initial
      : {
          ...initial,
          status: folded.status,
          finishReason: folded.finishReason,
          statusMessage: folded.message,
        };
  const snapshotView =
    folded?.status === 'input-required'
      ? await withOpenWaits(bureau, foldedView, projector.openReviewIds())
      : foldedView;
  const { task, surfaces: shownInSnapshot } = await options.snapshot(snapshotView);
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
  // The state of the last status frame queued, which a surface frame repeats: `lastStatus` runs
  // ahead of it while events wait to be mapped.
  let sentState = snapshotView.status;
  const reconciler = createSurfaceReconciler(options.surfaces, shownInSnapshot);
  const stops: Array<() => void> = [];
  const abort = () => queue.end();
  signal?.addEventListener('abort', abort, { once: true });

  // Whether the history's own terminal event reached the queue, and whether the registry's live
  // terminal update did (a lost append that has not been repaired, see the module comment).
  let endedByHistory = false;
  let endedByRegistry = false;
  let recheck: { readonly handle: RuntimeTimeoutHandle } | undefined;
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
        const forms = await formsFor(view);
        for (const event of eventsOf(view, element, reply, forms, options.a2ui))
          queue.push({ event });
        if (isTerminal(view.status)) queue.end();
      } else {
        if (lastStatus === 'submitted' && view.status !== 'submitted') {
          lastStatus = 'working';
          sentState = 'working';
          queue.push({ event: statusUpdate(view, a2aStateOf('working'), view.updatedAt) });
        }
        if (isTerminal(view.status) && !endedByHistory && !endedByRegistry) {
          // The task has ended and its terminal event is not in the history yet. A task whose
          // append failed is marked until the repair commits, and ends here with a live update;
          // otherwise the event is on its way, and the registry is looked at again shortly.
          const stored = await bureau.tasks.record(taskId);
          if (stored?.resyncPending === true) {
            endedByRegistry = true;
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
            const mapped = eventsOf(view, element, reply, await formsFor(view), options.a2ui);
            for (const [index, event] of mapped.entries()) {
              queue.push({ event, ends: index === mapped.length - 1 });
            }
          } else if (recheck === undefined) {
            recheck = {
              handle: options.timers.setTimeout(() => {
                recheck = undefined;
                void bureau.tasks.get(taskId).then(consider, () => undefined);
              }, FOLLOW_POLL_MS),
            };
          }
        }
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
        if (recheck !== undefined) options.timers.clearTimeout(recheck.handle);
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
      const openIds = projector.openReviewIds();
      considering = chained(considering, async () => {
        if (!watching || element.status === lastStatus) return;
        lastStatus = element.status;
        const read = (await bureau.tasks.get(taskId)) ?? initial;
        const view =
          element.status === 'input-required' ? await withOpenWaits(bureau, read, openIds) : read;
        const forms = await formsFor(view);
        for (const mapped of eventsOf(view, element, undefined, forms, options.a2ui)) {
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
        if (SURFACE_KINDS.has(event.kind)) {
          // A surface event is a trigger, not a payload: the surfaces are re-read as they stand,
          // and each revision above what was sent goes out once, under this event's cursor.
          mapping = chained(mapping, async () => {
            const view = (await bureau.tasks.get(taskId)) ?? initial;
            const frame = await reconciler.reconcile(view, sentState, event.emittedAtMs);
            if (frame !== undefined) queue.push({ event: frame, cursor: event.cursor });
          }).catch((error: unknown) => queue.fail(error));
          return;
        }
        if (element === undefined) return;
        if (element.kind === 'task.removed') {
          mapping = chained(mapping, async () => queue.end());
          return;
        }
        const status = statusElementOf(element);
        if (status === undefined) return;
        lastStatus = status.status;
        // Whether this element ended the task, read now: a later event may end it before this
        // one is mapped.
        const endsTask = projector.ended;
        if (endsTask) endedByHistory = true;
        const openIds = projector.openReviewIds();
        // Events are mapped one after another, so a slow reply lookup never lets a later event
        // overtake an earlier one.
        mapping = chained(mapping, async () => {
          const read = (await bureau.tasks.get(taskId)) ?? initial;
          // The waits an update names are the events', not the registry read's, which can lag.
          const view =
            status.status === 'input-required' ? await withOpenWaits(bureau, read, openIds) : read;
          const reply = status.status === 'completed' ? await options.replyOf(view) : undefined;
          const events = eventsOf(view, status, reply, await formsFor(view), options.a2ui);
          // One last reconcile before the stream ends, so a surface the task froze or closed with
          // its end is delivered. It goes out ahead of the terminal status, which stays the last
          // frame of the stream, and repeats the state the client already holds.
          if (endsTask) {
            // The run event can precede the task record's settlement, which is what freezes the
            // surfaces on its own: freeze them here, so the reconcile below reads them frozen.
            if (
              options.surfaces !== undefined &&
              (status.status === 'completed' ||
                status.status === 'failed' ||
                status.status === 'canceled')
            ) {
              await options.surfaces.settle(taskId, status.status).catch(() => undefined);
            }
            const closing = await reconciler.reconcile(view, sentState, status.emittedAtMs);
            if (closing !== undefined) queue.push({ event: closing });
          }
          sentState = status.status;
          for (const [index, mapped] of events.entries()) {
            // Only the last event of a durable one carries its cursor, so a resume never skips
            // the part of it a reader had not received.
            const last = index === events.length - 1;
            queue.push({
              event: mapped,
              ...(last ? { cursor: event.cursor } : {}),
              ends: endsTask && last,
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

/** A surface data part without its `createSurface` message; any other part as it is. */
function withoutCreateSurface(part: Part): Part {
  if (part.content?.$case !== 'data' || !Array.isArray(part.content.value)) return part;
  const messages = (part.content.value as Record<string, unknown>[]).filter(
    (message) => !('createSurface' in message),
  );
  return { ...part, content: { $case: 'data', value: messages } };
}

/** What a client holds of one surface: the revision sent, and whether it was A2UI data. */
type SentSurface = {
  readonly revision: number;
  readonly data: boolean;
  /** The `createSurface` message sent, which holds the properties only it can carry. */
  readonly created: string;
  /** The ids of the components sent, which an update can add or replace but never remove. */
  readonly components: ReadonlySet<string>;
};

/**
 * Re-reads a task's surfaces and frames what the client has not been sent. `sent` starts as the
 * surfaces the opening snapshot showed, so a revision in the snapshot is never sent again; a
 * reconcile emits only revisions above what was sent, as one `statusUpdate` whose message carries
 * the same parts a read does (`surfaceParts`), and a `deleteSurface` envelope for a surface the
 * client holds that was torn down. It runs inside the stream's serial mapping chain.
 */
function createSurfaceReconciler(
  surfaces: FollowSurfaces | undefined,
  shown: readonly InteractiveSurface[],
) {
  if (surfaces === undefined) {
    return {
      reconcile: async (..._arguments: unknown[]): Promise<StreamResponse | undefined> => undefined,
    };
  }
  const offered = offeredCatalogIds(surfaces.supportedCatalogIds);
  const delivered = (surface: InteractiveSurface): boolean =>
    surface.representation?.kind === 'a2ui' && offered.includes(surface.representation.catalogId);
  /** The `createSurface` a surface would begin with: its catalog, theme, and data-model return. */
  const createdOf = (surface: InteractiveSurface): string =>
    delivered(surface)
      ? JSON.stringify(a2uiMessagesOf(surface).find((message) => 'createSurface' in message))
      : '';
  const sentOf = (surface: InteractiveSurface): SentSurface => ({
    revision: surface.revision,
    data: delivered(surface),
    created: createdOf(surface),
    components: new Set(
      surface.representation?.kind === 'a2ui'
        ? surface.representation.components.map((component) => JSON.stringify(component['id']))
        : [],
    ),
  });
  const sent = new Map<string, SentSurface>();
  for (const surface of shown) {
    if (surface.kind === 'a2ui') sent.set(surface.surfaceId, sentOf(surface));
  }
  const activated: ReadonlySet<string> = new Set([A2UI_EXTENSION_URI]);
  return {
    async reconcile(
      view: Pick<TaskView, 'id' | 'contextId'>,
      state: TaskView['status'],
      emittedAtMs: number,
    ): Promise<StreamResponse | undefined> {
      const parts: Part[] = [];
      const revisions: string[] = [];
      for (const surface of await surfaces.list(view.id)) {
        if (surface.kind !== 'a2ui') continue;
        const before = sent.get(surface.surfaceId);
        if (before !== undefined && before.revision >= surface.revision) continue;
        if (surface.representation === null) {
          sent.set(surface.surfaceId, {
            revision: surface.revision,
            data: false,
            created: '',
            components: new Set(),
          });
          // A client that never held the surface learns nothing of its end.
          if (before?.data !== true) continue;
          parts.push(deleteSurfacePart(surface));
        } else {
          const next = sentOf(surface);
          sent.set(surface.surfaceId, next);
          const whole = surfaceParts([surface], activated, surfaces.supportedCatalogIds);
          // A surface the client already holds is continued with its whole current state and no
          // second `createSurface`, which A2UI v0.9.1 forbids for an existing surface id.
          if (before?.data !== true) parts.push(...whole);
          else if (
            next.data &&
            (before.created !== next.created ||
              [...before.components].some((id) => !next.components.has(id)))
          ) {
            // `theme` and `sendDataModel` travel only in `createSurface`, and an
            // `updateComponents` only adds or replaces components, so a surface whose replacement
            // changed the first or dropped a component is deleted and begun again, whole.
            parts.push(deleteSurfacePart(surface), ...whole);
          } else parts.push(...whole.map(withoutCreateSurface));
        }
        revisions.push(`${surface.surfaceId}@${surface.revision}`);
      }
      if (parts.length === 0) return undefined;
      return {
        payload: {
          $case: 'statusUpdate',
          value: {
            taskId: view.id,
            contextId: view.contextId,
            status: {
              state: a2aStateOf(state),
              message: agentMessage(view, `${view.id}:surfaces:${revisions.join(',')}`, parts),
              timestamp: new Date(emittedAtMs).toISOString(),
            },
            metadata: undefined,
          },
        },
      };
    },
  };
}
