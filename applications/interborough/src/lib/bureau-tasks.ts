/**
 * The Bureau's task operations as the browser calls them: `bureau.tasks.list`, `.get`, `.cancel`
 * and `.respond` over JSON-RPC, and `bureau.tasks.events`, the one that is a subscription and so
 * reaches the browser over Server-Sent Events at `/bureau/v1/subscriptions/bureau.tasks.events`.
 *
 * The schemas restate the wire shapes (`packages/bureau/src/http/management/`) the way
 * `bureau-client.ts` restates a context's: the browser does not import the Bureau, and a response
 * that does not parse is a fault in the Bureau, not data to show.
 */
import type { TaskOriginKind } from '@lostgradient/bureau';
import { HttpClientError } from '@lostgradient/weft';
import { z } from 'zod';

import { BUREAU_PATH, callBureau, type Fetcher, wireCodeOf } from './bureau-client.ts';
import { readServerSentEventStream } from './live-source/sse-reader.ts';

/** A task's state. */
export const taskStateSchema = z.enum([
  'submitted',
  'working',
  'input-required',
  'completed',
  'failed',
  'canceled',
]);

/** A task's state: submitted, working, waiting for input, or one of the three ways it ends. */
export type TaskState = z.infer<typeof taskStateSchema>;

/** Where a task's cancellation and cleanup stand, as `bureau.tasks.get` reports it. */
export const taskCleanupSchema = z.enum([
  'cancel-requested',
  'canceled',
  'cleanup-pending',
  'cleaned-up',
  'cleanup-failed',
  'cleanup-unresolved',
  'unknown-outcome',
]);

/** Where a task's cancellation and cleanup stand. */
export type TaskCleanup = z.infer<typeof taskCleanupSchema>;

/** What `bureau.tasks.cancel` answers: the cleanup states, and `rejected` for a task already over. */
export const taskCancelReceiptSchema = z.enum([...taskCleanupSchema.options, 'rejected']);

/**
 * What `bureau.tasks.cancel` answers: a cleanup state, or `rejected` for a task that is already
 * over.
 */
export type TaskCancelReceipt = z.infer<typeof taskCancelReceiptSchema>;

const openWaitSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('human-wait'), reviewId: z.string(), signalName: z.string() }),
  z.object({ kind: z.literal('tool-approval'), reviewId: z.string(), callId: z.string() }),
]);

/**
 * What an input-required task waits on: a human wait with its signal, or a tool approval with its
 * call.
 */
export type TaskOpenWait = z.infer<typeof openWaitSchema>;

/** One task, as `bureau.tasks.list` and `.get` show it. Message text is never part of it. */
export const taskViewSchema = z.object({
  id: z.string(),
  contextId: z.string(),
  agentName: z.string().nullable(),
  owner: z.string(),
  actor: z.string().nullable(),
  /**
   * How the Bureau's record of the task reads: `chat` when it recorded the session incarnation the
   * run ran in (so `contextId` is a session), `schedule-fire` for a schedule's fire, and `catalog`
   * otherwise: a dispatch's handle, or a run in a Bureau without a session store.
   */
  kind: z.enum(['chat', 'schedule-fire', 'catalog']),
  /**
   * Where the task came from (COR-1867), when the Bureau recorded it. Only its `kind` is read, to
   * tell a run a person or a schedule started from one a parent run, a goal or an agent tool call
   * started.
   */
  origin: z.looseObject({ kind: z.string() }).nullable().optional(),
  status: taskStateSchema,
  finishReason: z.string().nullable(),
  statusMessage: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  cleanup: taskCleanupSchema.nullable(),
  openWaits: z.array(openWaitSchema),
});

/** One task as the task list and `bureau.tasks.get` show it. Message text is never part of it. */
export type TaskView = z.infer<typeof taskViewSchema>;

/** The service principal the Bureau records as the `actor` of a run a schedule's fire started. */
export const SCHEDULER_ACTOR = 'system:scheduler';

/**
 * Whether a schedule's fire started the task. The task says so itself (`actor`), because the
 * session a fire runs in is not a reliable witness: a schedule may continue an existing chat
 * session, which keeps its `chat` origin.
 */
export function isScheduleFire(task: Pick<TaskView, 'actor'>): boolean {
  return task.actor === SCHEDULER_ACTOR;
}

/**
 * Whether the task belongs to a goal or a workflow, so it is not canceled on its own
 * (`bureau.tasks.cancel` refuses it with `owned-by-goal` or `owned-by-workflow`): an attempt of a
 * goal, or a step of a workflow instance.
 */
export function isOwnedElsewhere(task: Pick<TaskView, 'origin'>): boolean {
  const kind = task.origin?.kind;
  return kind === 'goal' || kind === 'parent';
}

const taskPageSchema = z.object({
  tasks: z.array(taskViewSchema),
  /** Opaque; `null` when the listing has no more tasks. */
  nextPageToken: z.string().nullable(),
});

/** One page of tasks and the opaque token for the next page, or `null` on the last. */
export type TaskPage = z.infer<typeof taskPageSchema>;

/** What a task list can be narrowed by. */
export type TaskFilter = {
  readonly contextId?: string;
  readonly agentName?: string;
  readonly status?: TaskState;
  /** Only the tasks recorded with an origin of this kind; a task with none matches no kind. */
  readonly origin?: TaskOriginKind;
};

type Options = { readonly signal?: AbortSignal };

/**
 * One page of tasks, most recently changed first (`bureau.tasks.list`). The first page's
 * `nextPageToken` names the listing as it stood then, so later pages neither repeat nor skip a task.
 */
export async function listTasks(
  input: TaskFilter & { readonly limit?: number; readonly pageToken?: string } = {},
  options?: Options,
): Promise<TaskPage> {
  return taskPageSchema.parse(await callBureau('bureau.tasks.list', input, options));
}

/**
 * Whether `error` is the Bureau refusing a page token: the listing it named expired (fifteen
 * minutes after its first page), was ended by newer listings, or belongs to other filters. The
 * listing has to start again from its first page.
 */
export function isRefusedPageToken(error: unknown): boolean {
  if (wireCodeOf(error) !== 'InvalidParams' || !(error instanceof HttpClientError)) return false;
  const issues = error.data?.['issues'];
  return (
    Array.isArray(issues) &&
    issues.some(
      (issue: unknown) =>
        typeof issue === 'object' &&
        issue !== null &&
        String((issue as { code?: unknown }).code).startsWith('page-token-'),
    )
  );
}

/** The part of an infinite query Load more drives. */
type PagedTasks = {
  fetchNextPage(): Promise<{ readonly error: unknown }>;
  refetch(): Promise<unknown>;
};

/**
 * Reads the next page. When the Bureau refuses the page token, the listing is read again from
 * its first page, which issues fresh tokens, so Load more works again instead of failing for good.
 */
export async function loadMoreTasks(tasks: PagedTasks): Promise<void> {
  const next = await tasks.fetchNextPage();
  if (isRefusedPageToken(next.error)) await tasks.refetch();
}

/** One task. A task the caller may not see is answered as a missing one: a not-found fault. */
export async function getTask(taskId: string, options?: Options): Promise<TaskView> {
  return taskViewSchema.parse(await callBureau('bureau.tasks.get', { taskId }, options));
}

const cancelAnswerSchema = z.object({
  taskId: z.string(),
  receipt: taskCancelReceiptSchema,
  reason: z.enum(['already-terminal', 'owned-by-goal', 'owned-by-workflow']).optional(),
  task: taskViewSchema.optional(),
});

/**
 * The Bureau's answer to a cancellation: the task, the receipt, and the task's view when the
 * Bureau sends it.
 */
export type TaskCancelAnswer = z.infer<typeof cancelAnswerSchema>;

/**
 * Asks a task to stop. The receipt says where the cancellation stands, which is often "requested"
 * and not yet done: `bureau.tasks.get` carries the same state afterwards.
 */
export async function cancelTask(taskId: string, options?: Options): Promise<TaskCancelAnswer> {
  return cancelAnswerSchema.parse(await callBureau('bureau.tasks.cancel', { taskId }, options));
}

const respondAnswerSchema = z.object({
  taskId: z.string(),
  messageId: z.string(),
  reviewId: z.string(),
  kind: z.enum(['tool-approval', 'human-wait']),
  decision: z.enum(['approve', 'deny', 'reject']),
  receipt: z.enum(['applied', 'rejected', 'superseded']),
  feedback: z.string().optional(),
});

/**
 * The Bureau's answer to a response to a task's wait: the review it resolved, the decision, and
 * whether it was applied, rejected, or superseded.
 */
export type TaskRespondAnswer = z.infer<typeof respondAnswerSchema>;

/**
 * Answers a task's human-input wait with text (`bureau.tasks.respond`). `messageId` makes the
 * command idempotent, so a retry of the same answer resolves nothing twice.
 */
export async function respondToTask(
  input: {
    readonly taskId: string;
    readonly messageId: string;
    readonly answer: string;
    readonly signalName: string;
  },
  options?: Options,
): Promise<TaskRespondAnswer> {
  return respondAnswerSchema.parse(await callBureau('bureau.tasks.respond', input, options));
}

/**
 * Why the Bureau refused an answer to a wait (`bureau.tasks.respond`) for reasons the person can
 * fix: the `data.issues` of the `InvalidParams` fault, with each path rooted at the answer (the
 * wire roots it at the request's `answer` field, which is dropped here). `undefined` for any other
 * failure.
 */
export function answerRefusalIssues(
  error: unknown,
):
  readonly { readonly path: readonly (string | number)[]; readonly message: string }[] | undefined {
  if (!(error instanceof HttpClientError) || wireCodeOf(error) !== 'InvalidParams') {
    return undefined;
  }
  const raw = error.data?.['issues'];
  if (!Array.isArray(raw)) return undefined;
  const found: { path: (string | number)[]; message: string }[] = [];
  for (const issue of raw as unknown[]) {
    if (typeof issue !== 'object' || issue === null) continue;
    const { path, message } = issue as { path?: unknown; message?: unknown };
    if (typeof message !== 'string' || !Array.isArray(path) || path[0] !== 'answer') continue;
    found.push({
      path: (path as unknown[])
        .slice(1)
        .filter(
          (segment): segment is string | number =>
            typeof segment === 'string' || typeof segment === 'number',
        ),
      message,
    });
  }
  return found.length > 0 ? found : undefined;
}

/** The answer of a finished task, as one artifact. */
export const taskArtifactSchema = z.object({
  artifactId: z.string(),
  text: z.string(),
  truncated: z.boolean(),
});

/**
 * The answer of a finished task: the artifact's identifier, its text, and whether the text was cut
 * short.
 */
export type TaskArtifact = z.infer<typeof taskArtifactSchema>;

const elementCommon = { taskId: z.string(), cursor: z.string(), emittedAtMs: z.number() };

const statusFields = {
  status: taskStateSchema,
  finishReason: z.string().nullable(),
  message: z.string().nullable(),
};

/** One element of a task's stream (`bureau.tasks.events`). */
export const taskEventSchema = z.discriminatedUnion('kind', [
  z.object({
    ...elementCommon,
    kind: z.literal('task.snapshot'),
    ...statusFields,
    artifact: taskArtifactSchema.nullable().optional(),
  }),
  z.object({
    ...elementCommon,
    kind: z.literal('task.status'),
    ...statusFields,
    artifact: taskArtifactSchema.nullable(),
  }),
  // The Bureau's history failed to record a change and restates where the task stands
  // (COR-1669): apply it as a `task.status`.
  z.object({
    ...elementCommon,
    kind: z.literal('task.resynced'),
    ...statusFields,
    artifact: taskArtifactSchema.nullable(),
    revision: z.number(),
  }),
  z.object({
    ...elementCommon,
    kind: z.literal('task.gap'),
    requestedCursor: z.string(),
    firstRetainedCursor: z.string(),
  }),
  z.object({ ...elementCommon, kind: z.literal('task.removed') }),
]);

/**
 * One element of a task's event stream: a snapshot, a status change, a resync, a gap in the
 * retained history, or the task's removal.
 */
export type TaskEvent = z.infer<typeof taskEventSchema>;

/** The cursor a snapshot carries. It names no durable position, so a stream cannot resume from it. */
export const SNAPSHOT_CURSOR = '-1';

/** Whether a task is over, as a status says it. */
export function isTerminalState(status: TaskState): boolean {
  return status === 'completed' || status === 'failed' || status === 'canceled';
}

/** The path of the one generic subscription route, with the task a stream follows. */
export function taskEventsPath(taskId: string): string {
  return `${BUREAU_PATH}/v1/subscriptions/bureau.tasks.events?${new URLSearchParams({ taskId }).toString()}`;
}

/**
 * Opens one task's stream from `cursor` (or from its snapshot when there is none) and yields each
 * element as the Bureau sends it. The cursor goes in `Last-Event-ID`, which is how the Bureau
 * resumes a stream. A refusal throws the `HttpClientError` the response's status makes, a stream
 * that ends ends this generator, and a frame that does not parse is skipped: heartbeats are
 * frames too.
 */
export async function* followTaskEvents(
  taskId: string,
  options: {
    readonly cursor?: string;
    readonly signal?: AbortSignal;
    readonly fetch?: Fetcher;
    /** Called once the Bureau has accepted the subscription, before any element arrives. */
    readonly onOpen?: () => void;
  },
): AsyncGenerator<TaskEvent, void, void> {
  const send = options.fetch ?? fetch;
  const response = await send(taskEventsPath(taskId), {
    headers: {
      accept: 'text/event-stream',
      ...(options.cursor === undefined ? {} : { 'last-event-id': options.cursor }),
    },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (!response.ok) {
    // A refusal on the REST surface is a flat `{ error: <message> }`, and its status is what
    // says what kind of fault it is.
    const body: unknown = await response.json().catch(() => undefined);
    const message =
      typeof body === 'object' && body !== null ? Reflect.get(body, 'error') : undefined;
    throw new HttpClientError(
      response.status,
      typeof message === 'string' ? message : `The task stream answered ${response.status}.`,
    );
  }
  options.onOpen?.();
  for await (const frame of readServerSentEventStream(response, options.signal)) {
    if (frame.event === undefined || !frame.event.startsWith('task.')) continue;
    let payload: unknown;
    try {
      payload = JSON.parse(frame.data);
    } catch {
      continue;
    }
    const parsed = taskEventSchema.safeParse(payload);
    if (parsed.success) yield parsed.data;
  }
}
