/**
 * COR-1481 — the task registry: the durable record behind `bureau.tasks.*`.
 *
 * A task is the external face of one top-level Bureau run (`documentation/
 * external-control-plane.md`, "Tasks and contexts"). Its id is the run id. The
 * run store only holds a run while the process does, so this registry keeps the
 * facts the management plane needs after the run has settled or the process has
 * restarted: the owner, the context and its incarnation, the originating user
 * message, how the run settled, and how its cleanup ended.
 *
 * ## Keys
 *
 * - `bureau-task:v1:<runId>` holds the {@link TaskRecord}.
 * - `bureau-task-context:v1:<contextId>:<runId>` holds the run id, so a context's
 *   tasks are one prefix scan.
 *
 * Both prefixes are disjoint from every other prefix the Bureau stores under
 * (`task-registry.test.ts` pins it). A Bureau with no key-value store keeps the
 * same records in memory.
 *
 * ## What it does not hold
 *
 * The status of a live task is read from the live run, never stored: the record's
 * `settled` is written once the run ends. The originating message is the task's
 * own history, not the session transcript.
 *
 * @module task-registry
 */

import type { RuntimeIdentifiers } from '@lostgradient/lifecycle';
import type { AgentInput, CleanupAcknowledgement } from '@lostgradient/operative';
import { messageText } from 'conversationalist';
import {
  type ConditionalTextValueStore,
  encodeStorageKeyComponent,
  MemoryStorage,
  textValueStore,
} from '@lostgradient/weft';

import { isRunFailureFinishReason } from './runtime-composition';
import type { CancelDurableRunOutcome, PendingReview } from './types';

/** The key prefix of a task's record. */
export const TASK_RECORD_KEY_PREFIX = 'bureau-task:v1:';

/** The key prefix of the index from a context to its tasks. */
export const TASK_CONTEXT_INDEX_KEY_PREFIX = 'bureau-task-context:v1:';

/** How many times a record update retries a lost compare-and-swap. */
const MAX_UPDATE_ATTEMPTS = 10;

/** The most a task's answer may carry as its artifact. */
export const TASK_ARTIFACT_TEXT_LIMIT = 64 * 1024;

/** The longest status message a task view carries. */
export const TASK_STATUS_MESSAGE_LIMIT = 1000;

/** A task's state, from the decision document's table. */
export type TaskState =
  'submitted' | 'working' | 'input-required' | 'completed' | 'failed' | 'canceled';

/**
 * Where a task's cancellation and cleanup stand. The same vocabulary the
 * `bureau.tasks.cancel` and `bureau.contexts.delete` receipts draw from.
 */
export type TaskCleanupState =
  | 'cancel-requested'
  | 'canceled'
  | 'cleanup-pending'
  | 'cleaned-up'
  | 'cleanup-failed'
  | 'cleanup-unresolved'
  | 'unknown-outcome';

/** One message in a task's own history: what the requester said, not the session transcript. */
export interface TaskMessage {
  readonly messageId: string;
  readonly role: 'user';
  readonly text: string;
  readonly createdAt: string;
}

/** How a task ended. */
export interface TaskSettlement {
  readonly at: string;
  readonly status: Extract<TaskState, 'completed' | 'failed' | 'canceled'>;
  readonly finishReason: string | null;
  readonly message: string | null;
  /**
   * The answer of a catalog task that completed (bounded). A session run's answer lives in
   * its durable history; a catalog run records none, so its snapshot reads it from here.
   */
  readonly answer?: { readonly text: string; readonly truncated: boolean } | undefined;
}

/** The durable record of one task. */
export interface TaskRecord {
  readonly schemaVersion: 1;
  readonly taskId: string;
  /** The session id for a session run; `sessionId ?? runId` for a catalog run. */
  readonly contextId: string;
  /** The session incarnation the task ran in; `''` for a catalog run, which has no session. */
  readonly incarnation: string;
  readonly agentName: string | null;
  readonly owner: string;
  readonly createdAt: string;
  readonly history: readonly TaskMessage[];
  readonly settled?: TaskSettlement | undefined;
  readonly cleanup?: TaskCleanupState | undefined;
}

/** What a task is created from. */
export interface TaskAdmission {
  readonly taskId: string;
  readonly contextId: string;
  readonly incarnation: string;
  readonly agentName: string | null;
  readonly owner: string;
  /** The originating user message's text, when the request had one. */
  readonly message: string | undefined;
}

/** What the live run of a task reports. */
export interface LiveTask {
  readonly phase: 'submitted' | 'running' | 'aborting' | 'completed' | 'error' | 'aborted';
  readonly finishReason: string | undefined;
  readonly error: string | undefined;
  /** Epoch milliseconds of the run's latest recorded action, when it has one. */
  readonly updatedAt: number | undefined;
}

/** An open wait on a task, by identifier only. */
export type TaskOpenWait =
  | { readonly kind: 'human-wait'; readonly reviewId: string; readonly signalName: string }
  | { readonly kind: 'tool-approval'; readonly reviewId: string; readonly callId: string };

/** A task as the management plane shows it. */
export interface TaskView {
  readonly id: string;
  readonly contextId: string;
  readonly agentName: string | null;
  readonly owner: string;
  readonly status: TaskState;
  readonly finishReason: string | null;
  readonly statusMessage: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly cleanup: TaskCleanupState | null;
  readonly openWaits: readonly TaskOpenWait[];
}

/** What a context is doing, from its latest live task. */
export type ContextActivity = 'running' | 'awaiting-input' | 'idle';

/** What the registry reads from the Bureau around it. */
export interface TaskRegistryHost {
  /** The task's live run, or `undefined` when this process holds none. */
  readonly liveTask: (taskId: string) => LiveTask | undefined;
  /**
   * The live runs of the given contexts, grouped by context. One call answers a
   * whole page, which is what keeps `activity` from costing a query per row.
   */
  readonly liveTasksOfContexts: (
    contextIds: readonly string[],
  ) => ReadonlyMap<
    string,
    readonly { readonly taskId: string; readonly phase: LiveTask['phase'] }[]
  >;
  readonly pendingReviews: () => readonly PendingReview[];
  /** The incarnation of the context's live session, or `undefined` when it has none. */
  readonly currentIncarnation: (contextId: string) => Promise<string | undefined>;
  /** Requests cancellation of a live task. Idempotent. Resolves whether a live run was found. */
  readonly abort: (taskId: string) => boolean;
  /** Cancels a durable run this process holds no live run for. */
  readonly cancelDurable: (taskId: string) => Promise<CancelDurableRunOutcome>;
  /** Resolves after `milliseconds` on the Bureau's runtime timers. */
  readonly sleep: (milliseconds: number) => Promise<void>;
}

/** The receipt `bureau.tasks.cancel` answers with. */
export type TaskCancelReceipt = TaskCleanupState | 'rejected';

/** What `cancel` found and did. */
export interface TaskCancelOutcome {
  readonly receipt: TaskCancelReceipt;
  readonly reason?: 'already-terminal';
}

/** A page of tasks. */
export interface TaskPage {
  readonly tasks: readonly TaskView[];
  readonly nextOffset: number | null;
}

/** What `list` filters and pages by. */
export interface TaskQuery {
  /** Only this owner's tasks; omit for every owner's. */
  readonly owner?: string | undefined;
  readonly contextId?: string | undefined;
  readonly agentName?: string | undefined;
  readonly status?: TaskState | undefined;
  readonly limit: number;
  readonly offset: number;
}

/** The task registry a Bureau exposes as `Bureau.tasks`. */
export interface TaskRegistry {
  /** Writes the record of a task about to start. */
  recordAdmission(admission: TaskAdmission): Promise<void>;
  /** Removes a record whose task never started. */
  discard(taskId: string): Promise<void>;
  /** Records how a task ended. The latest settlement wins. */
  recordSettled(taskId: string, settlement: TaskSettlement): Promise<void>;
  /**
   * Resolves once every settlement and cleanup write now in flight has landed (or failed),
   * including any that begin while it waits. A shutdown awaits it before storage closes.
   */
  flush(): Promise<void>;
  /** The records of tasks that have not been settled: the ones a crash may have left so. */
  unsettled(): Promise<readonly TaskRecord[]>;
  /**
   * Follows a task's `closed()` acknowledgement and records where its cleanup
   * ended. A second call for a task already followed returns the first.
   */
  watchCleanup(taskId: string, closed: Promise<CleanupAcknowledgement>): Promise<TaskCleanupState>;
  /** Deletes a task's record, as its run is deleted. */
  remove(taskId: string): Promise<void>;
  /**
   * Deletes the record of every task that settled before `cutoffMs` and whose run
   * this process no longer holds, except the ids in `keep`. A run the Bureau still
   * holds is deleted through `deleteRun`, which removes its record. Resolves how
   * many records it removed.
   */
  expire(cutoffMs: number, keep: ReadonlySet<string>): Promise<number>;
  /**
   * Empties the history of every task of one incarnation of a context, keeping
   * its status and cleanup. Resolves how many records it changed.
   */
  clearHistory(contextId: string, incarnation: string): Promise<number>;
  /**
   * Reports where the cleanup of each given task stands, waiting up to
   * `waitMilliseconds` (none, at zero) for acknowledgements still outstanding. A
   * cleanup that has not been acknowledged by then is `cleanup-pending`.
   */
  settleCleanup(
    tasks: readonly { readonly taskId: string; readonly closed: Promise<CleanupAcknowledgement> }[],
    waitMilliseconds: number,
  ): Promise<readonly { readonly taskId: string; readonly cleanup: TaskCleanupState }[]>;
  get(taskId: string): Promise<TaskView | undefined>;
  /** A task's own message history; `undefined` for a task this registry does not hold. */
  history(taskId: string): Promise<readonly TaskMessage[] | undefined>;
  /** The owner of record of a task, or `undefined` when no record exists. */
  ownerOf(taskId: string): Promise<string | undefined>;
  /** A task's record, as stored. */
  record(taskId: string): Promise<TaskRecord | undefined>;
  list(query: TaskQuery): Promise<TaskPage>;
  /** What each context is doing, answered for the whole set in one query. */
  activityOf(contextIds: readonly string[]): Promise<ReadonlyMap<string, ContextActivity>>;
  /**
   * Cancels a task and reports where its cleanup stands. With `waitMilliseconds`
   * above zero it waits that long for the acknowledgement; at zero it does not
   * wait, and `tasks.get().cleanup` carries the receipt later.
   */
  cancel(taskId: string, waitMilliseconds: number): Promise<TaskCancelOutcome | undefined>;
}

/** What {@link createTaskRegistry} needs. */
export interface CreateTaskRegistryOptions {
  /** The Bureau's key-value store; omitted for an ephemeral Bureau, which keeps records in memory. */
  readonly kv: ConditionalTextValueStore | undefined;
  readonly clock: { readonly nowISO: () => string };
  readonly identifiers: RuntimeIdentifiers;
  readonly host: TaskRegistryHost;
  readonly diagnose: (message: string, cause?: unknown) => void;
}

/** The task state a settled run maps to. */
export function settledTaskState(
  status: 'completed' | 'error' | 'aborted',
  finishReason: string | undefined,
): TaskSettlement['status'] {
  if (status === 'aborted') return 'canceled';
  if (status === 'error') return 'failed';
  if (finishReason === 'aborted') return 'canceled';
  return isRunFailureFinishReason(finishReason) ? 'failed' : 'completed';
}

/** The cleanup state an acknowledgement stands for. */
export function cleanupStateOf(acknowledgement: CleanupAcknowledgement): TaskCleanupState {
  switch (acknowledgement.status) {
    case 'not-required':
    case 'completed':
      return 'cleaned-up';
    case 'failed':
      return 'cleanup-failed';
    case 'unresolved':
      return acknowledgement.reason === 'unknown-effect' ? 'unknown-outcome' : 'cleanup-unresolved';
  }
}

/** Least settled first: the order an aggregate over several tasks resolves by. */
const CLEANUP_SETTLEDNESS: readonly TaskCleanupState[] = [
  'cancel-requested',
  'cleanup-pending',
  'canceled',
  'cleanup-unresolved',
  'unknown-outcome',
  'cleanup-failed',
  'cleaned-up',
];

/**
 * The aggregate of several tasks' cleanup states: the least settled wins, so a
 * pending cleanup on any task is `cleanup-pending`. A request still outstanding
 * reads as pending, and a stop with no acknowledgement behind it reads as
 * unresolved, so the aggregate never claims cleanup nothing supports.
 */
export function aggregateCleanup(
  states: readonly TaskCleanupState[],
): Exclude<TaskCleanupState, 'cancel-requested' | 'canceled'> | undefined {
  let least: TaskCleanupState | undefined;
  for (const state of states) {
    if (
      least === undefined ||
      CLEANUP_SETTLEDNESS.indexOf(state) < CLEANUP_SETTLEDNESS.indexOf(least)
    ) {
      least = state;
    }
  }
  if (least === undefined) return undefined;
  if (least === 'cancel-requested') return 'cleanup-pending';
  if (least === 'canceled') return 'cleanup-unresolved';
  return least;
}

/**
 * The text of the user message that started a catalog run, for the task's own
 * history: the text input itself, the text parts of a part-array input, or the
 * latest visible user row of a conversation input. `undefined` when there is none.
 */
export function originatingMessageText(input: AgentInput): string | undefined {
  if (typeof input === 'string') return input;
  if (Array.isArray(input)) {
    const text = input.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
    return text === '' ? undefined : text;
  }
  const { conversation } = input as Exclude<AgentInput, string | readonly unknown[]>;
  for (const id of [...conversation.ids].toReversed()) {
    const message = conversation.messages[id];
    if (message?.role === 'user' && !message.hidden) return messageText(message);
  }
  return undefined;
}

function recordKey(taskId: string): string {
  return `${TASK_RECORD_KEY_PREFIX}${encodeStorageKeyComponent(taskId)}`;
}

function contextIndexPrefix(contextId: string): string {
  return `${TASK_CONTEXT_INDEX_KEY_PREFIX}${encodeStorageKeyComponent(contextId)}:`;
}

function contextIndexKey(contextId: string, taskId: string): string {
  return `${contextIndexPrefix(contextId)}${encodeStorageKeyComponent(taskId)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRecord(key: string, raw: string): TaskRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`The task record at "${key}" is not valid JSON.`, { cause: error });
  }
  if (
    !isRecord(parsed) ||
    parsed['schemaVersion'] !== 1 ||
    typeof parsed['taskId'] !== 'string' ||
    typeof parsed['contextId'] !== 'string' ||
    typeof parsed['incarnation'] !== 'string' ||
    typeof parsed['owner'] !== 'string' ||
    typeof parsed['createdAt'] !== 'string' ||
    !Array.isArray(parsed['history'])
  ) {
    throw new Error(`The value at "${key}" is not a task record.`);
  }
  return parsed as unknown as TaskRecord;
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit);
}

/** Builds the registry over `options.kv`, or over memory when the Bureau has none. */
export function createTaskRegistry(options: CreateTaskRegistryOptions): TaskRegistry {
  const { clock, identifiers, host, diagnose } = options;
  const kv = options.kv ?? textValueStore(new MemoryStorage());
  const watchers = new Map<string, Promise<TaskCleanupState>>();
  /** Where each followed task's cleanup stands, set as soon as its acknowledgement arrives. */
  const observed = new Map<string, TaskCleanupState>();

  /**
   * The record at `key`, or `undefined` when its value cannot be read: another version, or
   * not a record at all. It is diagnosed and skipped, never thrown, so one bad value cannot
   * fail listing, retention or deletion for every other task (as the command ledger does).
   */
  function readable(key: string, raw: string): TaskRecord | undefined {
    try {
      return parseRecord(key, raw);
    } catch (error) {
      diagnose(`Skipped an unreadable task record at "${key}"`, error);
      return undefined;
    }
  }

  /** Settlement and cleanup writes in flight, so a shutdown can wait for them. */
  const inFlight = new Set<Promise<unknown>>();
  function track<T>(write: Promise<T>): Promise<T> {
    inFlight.add(write);
    const finished = () => void inFlight.delete(write);
    write.then(finished, finished);
    return write;
  }

  async function read(taskId: string): Promise<TaskRecord | undefined> {
    const key = recordKey(taskId);
    const raw = await kv.get(key);
    return raw === null ? undefined : readable(key, raw);
  }

  /** Applies `mutate` to the stored record with a compare-and-swap; no record, no write. */
  async function update(
    taskId: string,
    mutate: (record: TaskRecord) => TaskRecord | undefined,
  ): Promise<boolean> {
    const key = recordKey(taskId);
    for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt += 1) {
      const raw = await kv.get(key);
      if (raw === null) return false;
      const current = readable(key, raw);
      // A record this build cannot read is left as it is.
      if (current === undefined) return false;
      const next = mutate(current);
      if (next === undefined) return true;
      const committed = await kv.conditionalBatch(
        [{ key, expectedValue: raw }],
        [{ type: 'set', key, value: JSON.stringify(next) }],
      );
      if (committed) return true;
    }
    throw new Error(`Could not update the task record for "${taskId}" after repeated conflicts.`);
  }

  function reviewsByRun(reviews: readonly PendingReview[]): Map<string, PendingReview[]> {
    const grouped = new Map<string, PendingReview[]>();
    for (const review of reviews) {
      const held = grouped.get(review.runId) ?? [];
      held.push(review);
      grouped.set(review.runId, held);
    }
    return grouped;
  }

  function viewOf(record: TaskRecord, reviews: readonly PendingReview[] | undefined): TaskView {
    const live = host.liveTask(record.taskId);
    const openWaits: TaskOpenWait[] = (reviews ?? []).map((review) =>
      review.kind === 'human-wait'
        ? { kind: 'human-wait', reviewId: review.id, signalName: review.signalName }
        : { kind: 'tool-approval', reviewId: review.id, callId: review.approval.callId },
    );
    let status: TaskState;
    let finishReason: string | null;
    let statusMessage: string | null;
    if (live?.phase === 'submitted') {
      status = 'submitted';
      finishReason = null;
      statusMessage = null;
    } else if (live === undefined || live.phase === 'running' || live.phase === 'aborting') {
      if (live === undefined && record.settled !== undefined) {
        status = record.settled.status;
        finishReason = record.settled.finishReason;
        statusMessage = record.settled.message;
      } else {
        status = 'working';
        finishReason = null;
        statusMessage = null;
      }
    } else {
      status = settledTaskState(live.phase, live.finishReason);
      finishReason = live.finishReason ?? null;
      statusMessage =
        status === 'failed'
          ? truncate(
              live.error ?? live.finishReason ?? 'The task failed.',
              TASK_STATUS_MESSAGE_LIMIT,
            )
          : null;
    }
    // A pending review holds a task open: it is waiting on its requester, even when
    // the run that raised it has already ended its steps. A task that failed or was
    // canceled is that, whatever is still open.
    if (
      openWaits.length > 0 &&
      (status === 'completed' || status === 'working' || status === 'submitted')
    ) {
      status = 'input-required';
    }
    let cleanup: TaskCleanupState | null = record.cleanup ?? null;
    if (cleanup === null && live?.phase === 'aborting') cleanup = 'cancel-requested';
    if (cleanup === null && live?.phase === 'aborted' && watchers.has(record.taskId)) {
      cleanup = 'cleanup-pending';
    }
    const updatedAt =
      record.settled?.at ??
      (live?.updatedAt === undefined ? record.createdAt : new Date(live.updatedAt).toISOString());
    return {
      id: record.taskId,
      contextId: record.contextId,
      agentName: record.agentName,
      owner: record.owner,
      status,
      finishReason,
      statusMessage,
      createdAt: record.createdAt,
      updatedAt,
      cleanup,
      openWaits,
    };
  }

  async function recordsOfContext(contextId: string): Promise<TaskRecord[]> {
    const records: TaskRecord[] = [];
    for (const key of await kv.list(contextIndexPrefix(contextId))) {
      const taskId = await kv.get(key);
      if (taskId === null) continue;
      const record = await read(taskId);
      if (record !== undefined) records.push(record);
    }
    return records;
  }

  async function allRecords(): Promise<TaskRecord[]> {
    const records: TaskRecord[] = [];
    for (const key of await kv.list(TASK_RECORD_KEY_PREFIX)) {
      const raw = await kv.get(key);
      const record = raw === null ? undefined : readable(key, raw);
      if (record !== undefined) records.push(record);
    }
    return records;
  }

  async function watchCleanup(
    taskId: string,
    closed: Promise<CleanupAcknowledgement>,
  ): Promise<TaskCleanupState> {
    const existing = watchers.get(taskId);
    if (existing !== undefined) return existing;
    const watcher = closed.then(async (acknowledgement) => {
      const state = cleanupStateOf(acknowledgement);
      observed.set(taskId, state);
      try {
        await track(update(taskId, (record) => ({ ...record, cleanup: state })));
      } catch (error) {
        diagnose(`Could not record the cleanup of task "${taskId}"`, error);
      }
      return state;
    });
    watchers.set(taskId, watcher);
    return watcher;
  }

  /** The receipt a cleanup state is reported as. */
  function receiptFor(
    view: TaskView,
    observedState: TaskCleanupState | undefined,
    followed: boolean,
  ): TaskCancelReceipt {
    if (observedState !== undefined) return observedState;
    if (view.cleanup !== null) return view.cleanup;
    if (view.status !== 'canceled') return 'cancel-requested';
    // A cleanup this process follows is pending until it is acknowledged. One nothing follows
    // (a stop recorded before a restart) has no evidence behind it, so it claims only the stop.
    return followed ? 'cleanup-pending' : 'canceled';
  }

  return {
    async recordAdmission(admission) {
      const createdAt = clock.nowISO();
      const history: TaskMessage[] =
        admission.message === undefined
          ? []
          : [
              {
                messageId: identifiers.next('task-message'),
                role: 'user',
                text: admission.message,
                createdAt,
              },
            ];
      const record: TaskRecord = {
        schemaVersion: 1,
        taskId: admission.taskId,
        contextId: admission.contextId,
        incarnation: admission.incarnation,
        agentName: admission.agentName,
        owner: admission.owner,
        createdAt,
        history,
      };
      const key = recordKey(admission.taskId);
      const indexKey = contextIndexKey(admission.contextId, admission.taskId);
      // Written once: a second admission of the same run id leaves the first.
      await kv.conditionalBatch(
        [
          { key, expectedValue: null },
          { key: indexKey, expectedValue: null },
        ],
        [
          { type: 'set', key, value: JSON.stringify(record) },
          { type: 'set', key: indexKey, value: admission.taskId },
        ],
      );
    },

    async discard(taskId) {
      await this.remove(taskId);
    },

    async recordSettled(taskId, settlement) {
      await track(update(taskId, (record) => ({ ...record, settled: settlement })));
    },

    async flush() {
      while (inFlight.size > 0) await Promise.allSettled(inFlight);
    },

    async unsettled() {
      const records = await allRecords();
      return records.filter((record) => record.settled === undefined);
    },

    watchCleanup,

    async remove(taskId) {
      const record = await read(taskId);
      watchers.delete(taskId);
      observed.delete(taskId);
      if (record === undefined) return;
      await kv.conditionalBatch(
        [],
        [
          { type: 'delete', key: recordKey(taskId) },
          { type: 'delete', key: contextIndexKey(record.contextId, taskId) },
        ],
      );
    },

    async expire(cutoffMs, keep) {
      let removed = 0;
      for (const record of await allRecords()) {
        if (record.settled === undefined || keep.has(record.taskId)) continue;
        if (Date.parse(record.settled.at) >= cutoffMs) continue;
        if (host.liveTask(record.taskId) !== undefined) continue;
        await this.remove(record.taskId);
        removed += 1;
      }
      return removed;
    },

    async clearHistory(contextId, incarnation) {
      let cleared = 0;
      for (const record of await recordsOfContext(contextId)) {
        if (record.incarnation !== incarnation || record.history.length === 0) continue;
        await update(record.taskId, (current) => ({ ...current, history: [] }));
        cleared += 1;
      }
      return cleared;
    },

    async get(taskId) {
      const record = await read(taskId);
      if (record === undefined) return undefined;
      const grouped = reviewsByRun(
        host.pendingReviews().filter((review) => review.runId === taskId),
      );
      return viewOf(record, grouped.get(taskId));
    },

    async history(taskId) {
      const record = await read(taskId);
      return record?.history;
    },

    async ownerOf(taskId) {
      const record = await read(taskId);
      return record?.owner;
    },

    record: read,

    async list(query) {
      let records =
        query.contextId === undefined
          ? await allRecords()
          : await recordsOfContext(query.contextId);
      if (query.contextId !== undefined) {
        // Only the context's current incarnation: a context deleted and recreated
        // under the same id is a new one, and its predecessor's tasks are not its own.
        const current = (await host.currentIncarnation(query.contextId)) ?? '';
        records = records.filter((record) => record.incarnation === current);
      }
      if (query.owner !== undefined)
        records = records.filter((record) => record.owner === query.owner);
      if (query.agentName !== undefined) {
        records = records.filter((record) => record.agentName === query.agentName);
      }
      const grouped = reviewsByRun(host.pendingReviews());
      let views = records.map((record) => viewOf(record, grouped.get(record.taskId)));
      if (query.status !== undefined) views = views.filter((view) => view.status === query.status);
      views.sort((left, right) =>
        left.createdAt === right.createdAt
          ? left.id < right.id
            ? 1
            : -1
          : left.createdAt < right.createdAt
            ? 1
            : -1,
      );
      const page = views.slice(query.offset, query.offset + query.limit);
      const nextOffset =
        query.offset + query.limit < views.length ? query.offset + query.limit : null;
      return { tasks: page, nextOffset };
    },

    async activityOf(contextIds) {
      const live = host.liveTasksOfContexts(contextIds);
      const waiting = new Set(host.pendingReviews().map((review) => review.runId));
      const activity = new Map<string, ContextActivity>();
      for (const contextId of contextIds) {
        const running = (live.get(contextId) ?? []).filter(
          (task) =>
            task.phase === 'running' || task.phase === 'aborting' || task.phase === 'submitted',
        );
        const latest = running.at(-1);
        const parked = (live.get(contextId) ?? []).some((task) => waiting.has(task.taskId));
        activity.set(
          contextId,
          parked ? 'awaiting-input' : latest === undefined ? 'idle' : 'running',
        );
      }
      return activity;
    },

    async settleCleanup(tasks, waitMilliseconds) {
      const watched = tasks.map(({ taskId, closed }) => ({
        taskId,
        watcher: watchCleanup(taskId, closed),
      }));
      const pending = Symbol('pending');
      const timeout =
        waitMilliseconds > 0
          ? host.sleep(waitMilliseconds).then(() => pending)
          : Promise.resolve(pending);
      const settled: { taskId: string; cleanup: TaskCleanupState }[] = [];
      for (const { taskId, watcher } of watched) {
        const state = observed.get(taskId) ?? (await Promise.race([watcher, timeout]));
        settled.push({ taskId, cleanup: typeof state === 'symbol' ? 'cleanup-pending' : state });
      }
      return settled;
    },

    async cancel(taskId, waitMilliseconds) {
      const record = await read(taskId);
      if (record === undefined) return undefined;
      const reviews = host.pendingReviews().filter((review) => review.runId === taskId);
      const before = viewOf(record, reviews);
      const live = host.liveTask(taskId);
      const isLive =
        live?.phase === 'submitted' || live?.phase === 'running' || live?.phase === 'aborting';
      if (!isLive) {
        if (live === undefined && record.settled === undefined) {
          // A durable run this process holds no live run for.
          const outcome = await host.cancelDurable(taskId);
          if (outcome.status === 'requested') {
            await update(taskId, (current) => ({
              ...current,
              settled: {
                at: clock.nowISO(),
                status: 'canceled',
                finishReason: 'aborted',
                message: null,
              },
              // A stop with no acknowledgement behind it: a repeat answers the same.
              cleanup: 'canceled',
            }));
            return { receipt: 'canceled' };
          }
          if (outcome.status === 'failed') throw outcome.error;
          return { receipt: 'rejected', reason: 'already-terminal' };
        }
        if (before.status === 'canceled') {
          // The same bound a first cancel has: what the cleanup has reported by now, or what it
          // reports within the wait, and `cleanup-pending` when it has not.
          const watched = watchers.get(taskId);
          let state = observed.get(taskId);
          if (state === undefined && watched !== undefined && waitMilliseconds > 0) {
            state = await Promise.race([
              watched,
              host.sleep(waitMilliseconds).then(() => undefined),
            ]);
          }
          return { receipt: receiptFor(before, state, watched !== undefined) };
        }
        return { receipt: 'rejected', reason: 'already-terminal' };
      }
      host.abort(taskId);
      const watched = watchers.get(taskId);
      if (watched === undefined || waitMilliseconds <= 0) {
        const view = (await this.get(taskId)) ?? before;
        return {
          receipt: receiptFor(view, observed.get(taskId), watchers.has(taskId)),
        };
      }
      const settled = await Promise.race([
        watched,
        host.sleep(waitMilliseconds).then(() => undefined),
      ]);
      const view = (await this.get(taskId)) ?? before;
      return { receipt: receiptFor(view, settled, true) };
    },
  };
}
