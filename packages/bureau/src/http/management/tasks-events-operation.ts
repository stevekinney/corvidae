/**
 * `bureau.tasks.events`: one task's lifecycle, as a catalog subscription over the
 * Bureau's durable event history.
 *
 * ## What it serves
 *
 * The elements are an allowlisted projection of the run's durable events, never the
 * events themselves. A durable `run.completed` carries every step, tool call and
 * tool result; this stream carries only what an A2A task update carries: the
 * task's state, a status message, the final answer as one artifact, and the
 * cursor and timestamp. A durable kind that {@link createTaskEventProjector} does not
 * list is dropped, so a kind added later reaches no client until it is added here
 * on purpose.
 *
 * ## Cursors, resume and the retention floor
 *
 * The cursor is the durable history's own, opaque to a client, which compares it
 * for equality only. It is each element's SSE `id`, so `Last-Event-ID` resumes.
 * Each durable event yields at most one element, so one cursor never names two.
 * A resume below the retention floor yields exactly one `task.gap` element, then
 * the retained events; the client repairs its state with `bureau.tasks.get`.
 *
 * A subscription without a cursor begins with a `task.snapshot` of the task as it
 * stands, then replays every retained event. The snapshot can restate a transition
 * the replay then repeats, never miss one, and each element declares a state rather
 * than a change, so a repeat is harmless. The stream ends after the task's
 * terminal status or its removal, as an A2A stream closes at a terminal state.
 *
 * @module tasks-events-operation
 */

import { createDefaultRuntimeServices, type RuntimeServices } from '@lostgradient/lifecycle';
import {
  createReplayAwareClosableIterable,
  decodeCursor,
  defineOperation,
  encodeCursor,
} from '@lostgradient/weft';
import { z } from 'zod';

import { DURABLE_HISTORY_GAP_KIND } from '../../durable-event-history.ts';
import {
  settledTaskState,
  TASK_STATUS_MESSAGE_LIMIT,
  type TaskRegistry,
} from '../../task-registry.ts';
import type { Bureau } from '../../types.ts';
import { type BureauOwnershipHost } from '../owner-predicate.ts';
import { resourceNotFound, taskStateSchema } from './management-schemas.ts';
import { mayAccessTask } from './tasks-operations.ts';

/** The most a task's answer may carry as its artifact text. */
export const TASK_ARTIFACT_TEXT_LIMIT = 64 * 1024;

/** How many elements may wait for a slow reader before its stream ends and it resumes. */
const MAX_QUEUED_ELEMENTS = 1_000;

/** How many durable events one replay page reads. */
const REPLAY_PAGE_LIMIT = 100;

const common = {
  taskId: z.string(),
  cursor: z.string(),
  emittedAtMs: z.number(),
};

const statusFields = {
  status: taskStateSchema,
  finishReason: z.string().nullable(),
  message: z.string().max(TASK_STATUS_MESSAGE_LIMIT).nullable(),
};

/** One element of a task's stream. */
export const taskEventSchema = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('task.snapshot'), ...statusFields }),
  z.object({
    ...common,
    kind: z.literal('task.status'),
    ...statusFields,
    artifact: z
      .object({ artifactId: z.string(), text: z.string(), truncated: z.boolean() })
      .nullable(),
  }),
  z.object({
    ...common,
    kind: z.literal('task.gap'),
    requestedCursor: z.string(),
    firstRetainedCursor: z.string(),
  }),
  z.object({ ...common, kind: z.literal('task.removed') }),
]);

export type TaskEvent = z.infer<typeof taskEventSchema>;

/** The part of a durable event the projection reads. */
export type TaskEventSource = {
  readonly kind: string;
  readonly cursor: string;
  readonly emittedAtMs: number;
  readonly payload: unknown;
};

function field(payload: unknown, name: string): unknown {
  return typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>)[name]
    : undefined;
}

function textField(payload: unknown, name: string): string | undefined {
  const value = field(payload, name);
  return typeof value === 'string' ? value : undefined;
}

function boundedMessage(text: string | undefined): string | null {
  return text === undefined || text === '' ? null : text.slice(0, TASK_STATUS_MESSAGE_LIMIT);
}

type TerminalSettlement = {
  readonly status: 'completed' | 'failed' | 'canceled';
  readonly finishReason: string | null;
  readonly message: string | null;
  readonly artifact: { artifactId: string; text: string; truncated: boolean } | null;
};

/**
 * The projection of one task's durable events, with the little state it needs.
 *
 * A task that finished successfully while a review is still open is
 * `input-required`, not `completed`, exactly as `bureau.tasks.get` reports it: the
 * requester has not finished with it, and answering the review is what finishes it.
 * So the projector follows which reviews are open, and a run's success is shown as
 * `input-required` until the last of them is resolved, at which point the success
 * is shown. A task that failed or was canceled is that, whatever is open.
 *
 * `project` reads each field of a payload by name; nothing is passed through, and a
 * kind it does not know is dropped. It yields at most one element per event.
 * `ended` is true once the task's story is over: a terminal status with no review
 * open, or its removal.
 */
export function createTaskEventProjector(taskId: string) {
  const open = new Set<string>();
  let settlement: TerminalSettlement | undefined;
  let ended = false;

  const element = (
    event: TaskEventSource,
    state: z.infer<typeof taskStateSchema>,
    finishReason: string | null,
    message: string | null,
    artifact: TerminalSettlement['artifact'] = null,
  ): TaskEvent => ({
    kind: 'task.status',
    taskId,
    cursor: event.cursor,
    emittedAtMs: event.emittedAtMs,
    status: state,
    finishReason,
    message,
    artifact,
  });

  /** The status the task shows now: the settlement, unless a review holds a success open. */
  const current = (event: TaskEventSource, artifact = true): TaskEvent | undefined => {
    if (settlement === undefined) {
      return element(event, open.size > 0 ? 'input-required' : 'working', null, null);
    }
    if (settlement.status === 'completed' && open.size > 0) {
      return element(event, 'input-required', settlement.finishReason, null);
    }
    ended = true;
    return element(
      event,
      settlement.status,
      settlement.finishReason,
      settlement.message,
      artifact ? settlement.artifact : null,
    );
  };

  return {
    get ended(): boolean {
      return ended;
    },
    project(event: TaskEventSource): TaskEvent | undefined {
      switch (event.kind) {
        case 'run.completed': {
          const finishReason = textField(event.payload, 'finishReason');
          const state = settledTaskState('completed', finishReason);
          const content = textField(event.payload, 'content') ?? '';
          const failure = state === 'failed' ? textField(event.payload, 'error') : undefined;
          settlement = {
            status: state,
            finishReason: finishReason ?? null,
            message: boundedMessage(failure ?? (state === 'failed' ? finishReason : undefined)),
            artifact:
              state === 'completed' && content !== ''
                ? {
                    artifactId: `${taskId}:result`,
                    text: content.slice(0, TASK_ARTIFACT_TEXT_LIMIT),
                    truncated: content.length > TASK_ARTIFACT_TEXT_LIMIT,
                  }
                : null,
          };
          return current(event);
        }
        case 'run.error':
          settlement = {
            status: 'failed',
            finishReason: null,
            message: boundedMessage(textField(event.payload, 'error') ?? 'The task failed.'),
            artifact: null,
          };
          return current(event);
        case 'run.aborted':
          settlement = {
            status: 'canceled',
            finishReason: 'aborted',
            message: null,
            artifact: null,
          };
          return current(event);
        // A review becoming pending is the task waiting on its requester. A supersession
        // keeps it pending under a replacement approval.
        case 'review.requested':
        case 'review.superseded': {
          const reviewId = textField(event.payload, 'reviewId');
          if (reviewId !== undefined) open.add(reviewId);
          return element(event, 'input-required', settlement?.finishReason ?? null, null);
        }
        // An answer arriving: the task works again, or, once the run had finished, is done.
        case 'review.approved':
        case 'review.denied':
        case 'review.rejected': {
          const reviewId = textField(event.payload, 'reviewId');
          if (reviewId !== undefined) open.delete(reviewId);
          return current(event);
        }
        // Expiry, revocation and cancellation carry no transition of their own while the
        // run is going; once it has finished they are what lets it be done.
        case 'review.expired':
        case 'review.revoked':
        case 'review.canceled': {
          const reviewId = textField(event.payload, 'reviewId');
          if (reviewId !== undefined) open.delete(reviewId);
          return settlement === undefined ? undefined : current(event);
        }
        case 'run.removed':
          ended = true;
          return {
            kind: 'task.removed',
            taskId,
            cursor: event.cursor,
            emittedAtMs: event.emittedAtMs,
          };
        case DURABLE_HISTORY_GAP_KIND: {
          const requestedCursor = textField(event.payload, 'requestedCursor');
          const firstRetainedCursor = textField(event.payload, 'firstRetainedCursor');
          if (requestedCursor === undefined || firstRetainedCursor === undefined) return undefined;
          return {
            kind: 'task.gap',
            taskId,
            cursor: event.cursor,
            emittedAtMs: event.emittedAtMs,
            requestedCursor,
            firstRetainedCursor,
          };
        }
        default:
          return undefined;
      }
    },
  };
}

/** What the operation reads from the handler's `host`. */
export type BureauTaskEventsOperationHost = BureauOwnershipHost & {
  readonly tasks: Pick<TaskRegistry, 'get' | 'ownerOf' | 'record'>;
  readonly taskHistory: Pick<Bureau, 'eventHistory' | 'subscribeEventHistory'>;
  readonly runtime?: Pick<RuntimeServices, 'identifiers' | 'clock'>;
};

const tasksEventsInput = z.object({
  taskId: z.string().min(1),
  // Checked in the schema, so a malformed cursor is `InvalidParams` on every transport.
  fromCursor: z
    .string()
    .min(1)
    .refine((cursor) => decodeCursor(cursor) !== null, { message: 'Invalid cursor' })
    .optional(),
});

const tasksEventsEnvelope = z.object({ subscriptionId: z.string(), cursor: z.string() });

/** A bounded hand-off from the history's listener to the stream's reader. */
function createQueue<T>() {
  const items: T[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  let failure: { readonly error: unknown } | undefined;
  const notify = (): void => {
    const waiting = wake;
    wake = undefined;
    waiting?.();
  };
  return {
    push(item: T): void {
      if (ended) return;
      if (items.length >= MAX_QUEUED_ELEMENTS) {
        // A reader this far behind resumes with `Last-Event-ID`; the buffer stays bounded.
        ended = true;
      } else {
        items.push(item);
      }
      notify();
    },
    end(): void {
      ended = true;
      notify();
    },
    /** Ends the stream with an error the reader sees once it has read what was queued. */
    fail(error: unknown): void {
      failure ??= { error };
      ended = true;
      notify();
    },
    async next(): Promise<{ done: true } | { done: false; value: T }> {
      for (;;) {
        const value = items.shift();
        if (value !== undefined) return { done: false, value };
        if (failure !== undefined) throw failure.error;
        if (ended) return { done: true };
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

export const tasksEventsOperation = defineOperation<
  typeof tasksEventsInput,
  typeof tasksEventsEnvelope,
  typeof taskEventSchema,
  BureauTaskEventsOperationHost
>({
  name: 'bureau.tasks.events',
  mcpExposable: false,
  kind: 'subscription',
  summary: 'Follow one task’s lifecycle',
  description:
    'Streams a task’s lifecycle from its durable history: `task.status` elements carry the task’s state, a status message and, when it completes, its answer as one artifact; `task.snapshot` opens a subscription that names no cursor; `task.gap` marks a resume below the retention floor (exactly once; repair with `bureau.tasks.get`); `task.removed` ends the stream. Each element’s `cursor` resumes the stream through `fromCursor` or `Last-Event-ID`. The stream carries no step content, tool call or tool result. The task’s owner may subscribe; any other principal needs `bureau.tasks:read`, and a subscription to another owner’s task answers as a missing one does. The grant is checked when the subscription starts.',
  destructive: false,
  tags: ['Tasks'],
  inputSchema: tasksEventsInput,
  outputSchema: tasksEventsEnvelope,
  producibleFaults: ['InvalidParams', 'NotFound', 'UnsupportedCapability'],
  eventSchema: taskEventSchema,
  access: { kind: 'authenticated' },
  discoverable: true,
  transports: { http: true, jsonRpcHttp: false, jsonRpcWebSocket: true, jsonRpcStdio: false },
  unknownKeyPolicy: { http: 'strip', jsonRpc: 'reject' },
  invoke: async ({ input, host, principal }) => {
    const { taskId } = input;
    if (!(await mayAccessTask(host, principal, taskId, 'bureau.tasks:read'))) {
      throw resourceNotFound('task', taskId);
    }
    const task = await host.tasks.get(taskId);
    if (task === undefined) throw resourceNotFound('task', taskId);
    const catalog = (await host.tasks.record(taskId))?.incarnation === '';
    const owner = { kind: 'run', id: taskId } as const;
    const history = host.taskHistory;
    // A resume is probed here, so a Bureau with no durable history to follow answers
    // before a stream is opened, and a cursor below the retention floor is known.
    const probe = await history.eventHistory(owner, {
      ...(input.fromCursor === undefined ? {} : { since: input.fromCursor }),
      limit: 1,
    });
    if ('outcome' in probe && probe.outcome === 'unsupported-capability') {
      throw {
        code: 'UnsupportedCapability',
        message: 'This Bureau keeps no durable event history, so a task cannot be followed',
        data: { capability: 'event-history' },
      };
    }

    const controller = new AbortController();
    const queue = createQueue<TaskEvent>();
    const projector = createTaskEventProjector(taskId);
    const runtime = host.runtime ?? createDefaultRuntimeServices();
    let subscription: { unsubscribe(): void } | undefined;

    const pump = async (onReplayComplete: () => void): Promise<void> => {
      // Elements are emitted only for events after this sequence. The projector reads the
      // whole retained history regardless, because what an event means (a success shown as
      // `input-required` while a review is open) depends on the events before it.
      let emitAfter = input.fromCursor === undefined ? -1 : (decodeCursor(input.fromCursor) ?? -1);
      if (input.fromCursor === undefined) {
        queue.push({
          kind: 'task.snapshot',
          taskId,
          cursor: '-1',
          emittedAtMs: runtime.clock.now(),
          status: task.status,
          finishReason: task.finishReason,
          message: task.statusMessage,
        });
      } else if ('outcome' in probe && probe.outcome === 'gap') {
        const lastBefore = Math.max(probe.firstRetainedSequence - 1, -1);
        queue.push({
          kind: 'task.gap',
          taskId,
          cursor: String(lastBefore),
          emittedAtMs: runtime.clock.now(),
          requestedCursor: probe.requestedCursor,
          firstRetainedCursor: encodeCursor(probe.firstRetainedSequence),
        });
        emitAfter = lastBefore;
      }

      // A catalog task (no session, so no incarnation) records no durable `run.*` events: its
      // stream is the snapshot alone, and the task's state is read with `bureau.tasks.get`.
      if (catalog) {
        queue.end();
        onReplayComplete();
        return;
      }

      let since: string | undefined;
      for (;;) {
        if (controller.signal.aborted) return;
        const page = await history.eventHistory(owner, {
          ...(since === undefined ? {} : { since }),
          limit: REPLAY_PAGE_LIMIT,
        });
        if ('outcome' in page && page.outcome === 'gap') {
          // The whole retained history is read, so the read starts at the floor.
          since = String(Math.max(page.firstRetainedSequence - 1, -1));
          continue;
        }
        if (!('events' in page)) break;
        for (const event of page.events) {
          since = event.cursor;
          const element = projector.project(event);
          if (element !== undefined && (decodeCursor(event.cursor) ?? -1) > emitAfter) {
            queue.push(element);
          }
          if (projector.ended) {
            queue.end();
            onReplayComplete();
            return;
          }
        }
        if (!page.hasMore) break;
        since = page.nextCursor ?? since;
      }
      onReplayComplete();
      if (controller.signal.aborted) return;
      if (task.status === 'completed' || task.status === 'failed' || task.status === 'canceled') {
        // A task already over has nothing live to follow.
        queue.end();
        return;
      }
      subscription = history.subscribeEventHistory(
        owner,
        (event) => {
          const element = projector.project(event);
          if (element !== undefined) queue.push(element);
          if (projector.ended) queue.end();
        },
        { ...(since === undefined ? {} : { since }), signal: controller.signal },
      );
    };

    const iterable = createReplayAwareClosableIterable<TaskEvent>(
      (onReplayComplete) => {
        void pump(onReplayComplete).catch((error: unknown) => queue.fail(error));
        return {
          async *[Symbol.asyncIterator]() {
            for (;;) {
              const next = await queue.next();
              if (next.done) return;
              yield next.value;
            }
          },
        };
      },
      {
        close: () => {
          controller.abort();
          subscription?.unsubscribe();
          queue.end();
        },
      },
    );

    return {
      envelope: {
        subscriptionId: `sub_${runtime.identifiers.next('task-subscription')}`,
        cursor: input.fromCursor ?? '-1',
      },
      iterable,
      close: () => iterable.close(),
    };
  },
});
