/**
 * The Bureau's task operations as the browser calls them: `bureau.tasks.list`, `.get`, `.cancel`,
 * `.respond` and `.inspect` over JSON-RPC, and `bureau.tasks.events`, the one that is a subscription and so
 * reaches the browser over Server-Sent Events at `/bureau/v1/subscriptions/bureau.tasks.events`.
 *
 * The calls go through the generated client (`./bureau-api.ts`); the event schemas below still read
 * the stream.
 */
import type { TaskOriginKind } from '@lostgradient/bureau';
import { HttpClientError } from '@lostgradient/weft';
import { z } from 'zod';

import { bureauClient, type BureauEvent, type BureauOutput } from './bureau-api.ts';
import { BUREAU_PATH, type Fetcher, wireCodeOf } from './bureau-client.ts';
import { acceptedFetch, eventsOf } from './bureau-subscriptions.ts';

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

/**
 * What an input-required task waits on: a human wait with its signal, or a tool approval with its
 * call.
 */
export type TaskOpenWait = TaskView['openWaits'][number];

/** One task as the task list and `bureau.tasks.get` show it. Message text is never part of it. */
export type TaskView = Omit<
  BureauOutput<'bureau.tasks.get'>,
  'origin' | 'wakeAt' | 'workflow' | 'usage' | 'attention' | 'stalledSince' | 'failure' | 'retrying'
> & {
  /**
   * Why a failed task failed (COR-2531): the step (`index` and `label`, the failing tool's name or
   * `model`), the error's code and kind, and the tool call that failed. `null` for a task that did
   * not fail and for a failure nothing described; absent from a Bureau that does not report it.
   */
  readonly failure?: BureauOutput<'bureau.tasks.get'>['failure'] | undefined;
  /**
   * The step a running task is on a second or later try of (COR-2531): its `label` and `attempt`.
   * `null` when none is, and absent from a Bureau that does not report it.
   */
  readonly retrying?: BureauOutput<'bureau.tasks.get'>['retrying'] | undefined;
  /**
   * What the run has used and cost so far, or in total once it ended (COR-2524): tokens, and
   * `costUsd` in US dollars, `null` rather than `0` when nothing was priced. Absent from a Bureau
   * that does not report it, and `null` for a run that has recorded none.
   */
  readonly usage?: BureauOutput<'bureau.tasks.get'>['usage'] | undefined;
  /**
   * What asks for attention on a task (COR-2526): `stalled` for a run that is alive but making no
   * progress outside a declared wait, `looping` for a run whose toolbox reported a loop, both only
   * while the task has not ended; and `overspending` (COR-2527) for a run a step found over the
   * workspace's spend threshold, which stays after the run settles. Absent from a Bureau that does
   * not report it, which reads as none.
   */
  readonly attention?: BureauOutput<'bureau.tasks.get'>['attention'] | undefined;
  /** The instant (ISO 8601) the Bureau saw the run stall, while `attention` holds `stalled`. */
  readonly stalledSince?: string | null | undefined;
  /**
   * Where the task came from (COR-1867), when the Bureau recorded it. Only its `kind` is read, to
   * tell a run a person or a schedule started from one a parent run, a goal or an agent tool call
   * started.
   */
  readonly origin?:
    (Readonly<Record<string, unknown>> & { readonly kind: string }) | null | undefined;
  /**
   * The time (ISO 8601) a working task's run said it would wake at (COR-1987), or `null` for one
   * with no wakeup pending. Absent from a Bureau that does not report it, which reads as `null`.
   */
  readonly wakeAt?: string | null | undefined;
  /**
   * The workflow the task ran on (COR-2423). Absent from a Bureau that does not report it, which
   * reads as an ordinary run. `type` is `agentRun`, `goalRun`, `durableHeartbeatTick`,
   * `scheduleTick`, or the identifier of a workflow file for one of its instances; `scheduleId` is
   * the schedule the run belongs to; `tick` is what a schedule tick recorded; `steps` is how many
   * steps an instance's workflow has and the one it is at, failed at or finished on (from one); and
   * `awaitingSignal` is the signal an unfinished instance waits for.
   */
  readonly workflow?: BureauOutput<'bureau.tasks.get'>['workflow'] | undefined;
};

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

/** One page of tasks and the opaque token for the next page, or `null` on the last. */
export type TaskPage = BureauOutput<'bureau.tasks.list'>;

/** What a task list can be narrowed by. */
export type TaskFilter = {
  readonly contextId?: string;
  readonly agentName?: string;
  readonly status?: TaskState;
  /** Only the tasks recorded with an origin of this kind; a task with none matches no kind. */
  readonly origin?: TaskOriginKind;
  /** Only the subordinate tasks of this run: the children it started. */
  readonly parentRunId?: string;
  /**
   * Only the child runs started from any run in this context (COR-1987), so a reloaded chat lists
   * the children of every run in its thread in one read.
   */
  readonly parentContextId?: string;
  /** Only the tasks that ran on this workflow type (COR-2423); a task's `workflow.type` says which. */
  readonly workflow?: string;
  /**
   * Only the tasks whose `attention` lists this kind (COR-2528). One kind at a time: the Bureau
   * takes no list, so {@link listAllTasksNeedingAttention} asks for each.
   */
  readonly attention?: TaskAttention;
  /**
   * `false` lists only the tasks that have records (COR-2424): the schedule tick's runs and the
   * instances of workflow files, which the engine holds, are left out so a reader of the newest
   * tasks (the chat list, the command palette) is not given its slots to them.
   */
  readonly engineRuns?: boolean;
};

type Options = { readonly signal?: AbortSignal; readonly fetch?: Fetcher };

/**
 * One page of tasks, most recently changed first (`bureau.tasks.list`). The first page's
 * `nextPageToken` names the listing as it stood then, so later pages neither repeat nor skip a task.
 */
export async function listTasks(
  input: TaskFilter & { readonly limit?: number; readonly pageToken?: string } = {},
  options?: Options,
): Promise<TaskPage> {
  return bureauClient['bureau.tasks.list'](input, options);
}

/** How many tasks one request of {@link listAllTasks} asks for: the most the Bureau answers. */
const TASKS_PAGE_SIZE = 100;

/**
 * Every task a filter matches (`bureau.tasks.list`), read page by page to the end. The listing has
 * no total, so a count of tasks is the length of this read: Home's Running now and the status
 * counts on Runs both count this way. The first page's token names the listing as it stood then, so
 * a task that changes mid-read appears once.
 */
export async function listAllTasks(
  filter: TaskFilter = {},
  options?: Options,
): Promise<TaskView[]> {
  const tasks: TaskView[] = [];
  let pageToken: string | undefined;
  do {
    const page = await listTasks(
      {
        ...filter,
        limit: TASKS_PAGE_SIZE,
        ...(pageToken === undefined ? {} : { pageToken }),
      },
      options,
    );
    tasks.push(...page.tasks);
    pageToken = page.nextPageToken ?? undefined;
  } while (pageToken !== undefined);
  return tasks;
}

/** What can ask for attention on a task (COR-2526, COR-2527), in the order a row says them. */
export const TASK_ATTENTION_KINDS = ['stalled', 'looping', 'overspending'] as const;

/** One of {@link TASK_ATTENTION_KINDS}. */
export type TaskAttention = (typeof TASK_ATTENTION_KINDS)[number];

/**
 * Every task that carries at least one attention state (COR-2528), asked of the Bureau one kind at
 * a time and merged by task, so a task that is stalled and over the threshold is listed once. The
 * Bureau keeps `overspending` on a task after it settles, so this lists a run that the Needs
 * attention feed dropped after seven days.
 */
export async function listAllTasksNeedingAttention(
  filter: Omit<TaskFilter, 'attention'> = {},
  options?: Options,
): Promise<TaskView[]> {
  const lists = await Promise.all(
    TASK_ATTENTION_KINDS.map((attention) => listAllTasks({ ...filter, attention }, options)),
  );
  const merged = new Map<string, TaskView>();
  for (const task of lists.flat()) {
    if (!merged.has(task.id)) merged.set(task.id, task);
  }
  return [...merged.values()];
}

/** The states of a task that is going: it has started, or it is about to. A waiting task is neither. */
const RUNNING_STATES = ['working', 'submitted'] as const satisfies readonly TaskState[];

/**
 * Whether a task counts as running now: it is working, or it has not yet started, which a person
 * reads as running. A run parked on a review or a question is waiting on a person, which is a
 * different count. Home's count and its Running now card both go through this, so they cannot
 * disagree.
 */
export function isRunning(task: Pick<TaskView, 'status' | 'workflow'>): boolean {
  // An instance parked at an `await-signal` step is waiting, not running (row 10h).
  if (task.workflow?.awaitingSignal != null) return false;
  return RUNNING_STATES.some((state) => state === task.status);
}

/**
 * The runs that are running now (`bureau.tasks.list`): the tasks that are working or have not yet
 * started, as {@link isRunning} says. A run parked on a review or a question is not among them.
 * Every page is read ({@link listAllTasks}), because the listing has no total, so the count of the
 * result is the count of runs running.
 */
export async function listRunningTasks(options?: Options): Promise<TaskView[]> {
  const running: TaskView[] = [];
  for (const status of RUNNING_STATES) {
    const tasks = await listAllTasks({ status }, options);
    running.push(...tasks.filter(isRunning));
  }
  return running;
}

/** The states of a task a restart recovers: submitted, working, or parked on a person. */
const IN_FLIGHT_STATES = [
  'submitted',
  'working',
  'input-required',
] as const satisfies readonly TaskState[];

/**
 * The runs of the agents named in `agentNames` that are in flight (`bureau.tasks.list`): started,
 * working, or waiting on a person, so a restart would recover them (COR-2235). It is the
 * per-plugin read of Settings › Plugins, which passes a plugin's agents: the listing is read once
 * per state, never once per agent, and holds only runs that have not ended.
 */
export async function listInFlightTasks(
  agentNames: ReadonlySet<string>,
  options?: Options,
): Promise<TaskView[]> {
  const found = await Promise.all(
    IN_FLIGHT_STATES.map((status) => listAllTasks({ status }, options)),
  );
  return found
    .flat()
    .filter((task) => task.agentName !== null && agentNames.has(task.agentName))
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/**
 * Every child run started from any run in `contextId` (`bureau.tasks.list` with `parentContextId`,
 * COR-1987), read page by page. A reloaded chat shows the children of every run in its thread, not
 * only the run it reattached to. A child a tool or a peer started has no task and is not listed.
 */
export async function listChildRuns(contextId: string, options?: Options): Promise<TaskView[]> {
  return listAllTasks({ parentContextId: contextId }, options);
}

/** The origins of a task that a person's chat did not start: a run's own child, a goal's attempt, a workflow's step. */
const NOT_THE_CHAT_RUN: ReadonlySet<string> = new Set(['agent', 'goal', 'parent']);

/**
 * The run a session ran last (`bureau.tasks.list`, newest change first), or `undefined` for a
 * session with none. A run the session's own run handed work to is not the session's run, so
 * those are passed over.
 */
export async function getLastRun(
  contextId: string,
  options?: Options,
): Promise<TaskView | undefined> {
  const page = await listTasks({ contextId, limit: 25 }, options);
  return page.tasks.find((task) => !NOT_THE_CHAT_RUN.has(task.origin?.kind ?? ''));
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

/** One task. A task the caller may not see is answered as a missing one: a not-found fault. */
export async function getTask(taskId: string, options?: Options): Promise<TaskView> {
  return bureauClient['bureau.tasks.get']({ taskId }, options);
}

type TaskInspection = BureauOutput<'bureau.tasks.inspect'>;

/** One step's reply details: why it ran on its model and what that model saw, each `null` when unrecorded. */
export type TaskStep = Pick<
  TaskInspection['steps'][number],
  'step' | 'messageId' | 'planReason' | 'hasEffectiveContext'
> & {
  readonly effectiveContext: EffectiveContext | null;
};

/** Why a step's generation ran on its model, and the models the plan passed over. */
export type PlanReason = NonNullable<TaskInspection['steps'][number]['planReason']>;

/** Why a step ran on its model: the codes `bureau.tasks.inspect` names. */
export type PlanReasonCode = PlanReason['code'];

/**
 * What a step's model saw, as the Bureau records it: the sources the prompt was composed from and
 * the ids and roles of its messages. Never the content of a message.
 */
export type EffectiveContext = Pick<
  NonNullable<TaskInspection['steps'][number]['effectiveContext']>,
  'epochId' | 'messageCount' | 'truncated'
> & {
  readonly sources: readonly {
    readonly sourceId: string;
    readonly disposition: 'included' | 'excluded' | 'absent-by-composition';
    readonly reason?: string | undefined;
  }[];
  readonly messages: readonly { readonly id: string; readonly role: string }[];
};

/**
 * The reply details of one step of a task (`bureau.tasks.inspect` with `step`): why the step ran on
 * its model and what that model saw. `null` when the run recorded no such step, which is an answer
 * and not a fault: a step whose tool phase failed returns before it is recorded. A task the caller
 * may not see is answered as a missing one: a not-found fault.
 */
export async function inspectTaskStep(
  taskId: string,
  step: number,
  options?: Options,
): Promise<TaskStep | null> {
  const answer = await bureauClient['bureau.tasks.inspect']({ taskId, step }, options);
  return answer.steps.find((entry) => entry.step === step) ?? null;
}

/** One registration of a live run's hook plan: its identity, hook point, who registered it, priority and replay. */
export type TaskHook = NonNullable<TaskInspection['hooks']['plan']>[number];

/** One registration of a run's plan that threw: how often, and when it last did. Never the error's text. */
export type TaskFailedHook = TaskInspection['hooks']['failed'][number];

/**
 * A run's hooks (`bureau.tasks.inspect`, COR-2115): the plan of a run that is still going (`null`
 * once it has ended, and when the plan cannot be read) and the registrations of its plan that
 * threw. A task the caller may not see is answered as a missing one: a not-found fault.
 */
export type TaskHooks = TaskInspection['hooks'];

/** The hook plan and the failed hooks of one task. */
export async function inspectTaskHooks(taskId: string, options?: Options): Promise<TaskHooks> {
  const answer = await bureauClient['bureau.tasks.inspect']({ taskId }, options);
  return answer.hooks;
}

/**
 * The Bureau's answer to a cancellation: the task, the receipt, and the task's view when the
 * Bureau sends it.
 */
export type TaskCancelAnswer = BureauOutput<'bureau.tasks.cancel'>;

/**
 * Asks a task to stop. The receipt says where the cancellation stands, which is often "requested"
 * and not yet done: `bureau.tasks.get` carries the same state afterwards.
 */
export async function cancelTask(taskId: string, options?: Options): Promise<TaskCancelAnswer> {
  return bureauClient['bureau.tasks.cancel']({ taskId }, options);
}

/**
 * The Bureau's answer to a response to a task's wait: the review it resolved, the decision, and
 * whether it was applied, rejected, or superseded.
 */
export type TaskRespondAnswer = BureauOutput<'bureau.tasks.respond'>;

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
  return bureauClient['bureau.tasks.respond'](input, options);
}

/**
 * The text that carries a question control's answer to `bureau.tasks.respond`, which takes a
 * string. Text goes as it is. Any other answer (a boolean, a number, an array of picks, an object)
 * goes as its JSON, which the Bureau reads back into the value when the text itself does not fit the
 * question's schema (`answerFromText`).
 */
export function taskAnswerText(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
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

/** The kinds of element a task's stream sends. */
const TASK_EVENT_KINDS: ReadonlySet<string> = new Set([
  'task.snapshot',
  'task.status',
  'task.resynced',
  'task.gap',
  'task.removed',
]);

/**
 * One element of a task's event stream (`bureau.tasks.events`): a snapshot, a status change, a
 * resync (the Bureau's history failed to record a change and restates where the task stands,
 * COR-1669: apply it as a `task.status`), a gap in the retained history, or the task's removal.
 */
export type TaskEvent = BureauEvent<'bureau.tasks.events'>;

/**
 * Reads what the stream sent as an element, or `undefined` for data that is not one (a frame of a
 * kind this build does not know, or one with no cursor), which the follower skips.
 */
export function readTaskEvent(data: unknown): TaskEvent | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const kind: unknown = Reflect.get(data, 'kind');
  const cursor: unknown = Reflect.get(data, 'cursor');
  if (typeof kind !== 'string' || !TASK_EVENT_KINDS.has(kind) || typeof cursor !== 'string') {
    return undefined;
  }
  // The kind and the cursor are read; the rest is what the subscription's event type says.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return data as TaskEvent;
}

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
 * element as the Bureau sends it. The cursor resumes the stream (`Last-Event-ID`). A refusal throws
 * the `HttpClientError` the response's status makes, a stream that ends ends this generator, and
 * data that is not an element is skipped: heartbeats are frames too.
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
  const messages = bureauClient['bureau.tasks.events'](
    { taskId },
    {
      fetch: acceptedFetch(options),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.cursor === undefined ? {} : { lastEventId: options.cursor }),
    },
  );
  for await (const { data } of eventsOf(messages, 'task stream')) {
    const element = readTaskEvent(data);
    if (element !== undefined) yield element;
  }
}
