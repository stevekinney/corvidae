/**
 * COR-1481 — the task registry: the durable record behind `bureau.tasks.*`.
 *
 * A task is the external face of one top-level Bureau run (`documentation/
 * external-control-plane.md`, "Tasks and contexts"). Its id is the run id. A schedule's fire is
 * one too (COR-1482): owned by the schedule's owner, with the scheduler as its `actor`. The
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
import {
  type AgentInput,
  type CleanupAcknowledgement,
  type CleanupAcknowledgementReason,
  isFailureFinishReason,
} from '@lostgradient/operative';
import { messageText } from 'conversationalist';
import {
  type ConditionalTextValueStore,
  encodeStorageKeyComponent,
  MemoryStorage,
  textValueStore,
  yieldToPortableEventLoop,
} from '@lostgradient/weft';

import {
  compareListingKeys,
  createTaskListingStore,
  decodeListingToken,
  encodeListingToken,
  fitsListingWindow,
  isAfterListingKey,
  listingEntryBytes,
  TASK_LISTING_LIFETIME_MILLISECONDS,
  TaskListingTokenError,
  type TaskListingEntry,
  type TaskListingFilters,
  type TaskListingKey,
  type TaskListingRecord,
  type TaskListingScope,
} from './task-list-snapshots';
import type { CancelDurableRunOutcome, PendingReview } from './types';

/** The key prefix of a task's record. */
export const TASK_RECORD_KEY_PREFIX = 'bureau-task:v1:';

/** The key prefix of the index from a context to its tasks. */
export const TASK_CONTEXT_INDEX_KEY_PREFIX = 'bureau-task-context:v1:';

/**
 * What {@link TaskRegistry.onSettled} calls. A promise it returns is awaited by the settlement
 * that announced it, so `flush()` and `idle()` wait for it.
 */
export type SettledListener = (view: TaskView, record: TaskRecord) => unknown;

/** How many event-loop turns {@link TaskRegistry.idle} waits, by default, for acknowledgements that have not arrived. */
const IDLE_MAXIMUM_TURNS = 50;

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

/** The kinds of task that are not ordinary runs. */
export type TaskKind = 'schedule-fire';

/**
 * What a task reads as in the management plane (COR-1689), by how its record was written: a record
 * of the `schedule-fire` kind is `schedule-fire`; otherwise a non-empty incarnation, the session
 * incarnation the run ran in, is `chat`; and anything else is `catalog`. A Bureau without a session store
 * records no incarnation for a task, so that task reads `catalog`: `catalog` means no session
 * incarnation was recorded. The kind a record stores ({@link TaskKind}) is only the fire.
 */
export type TaskViewKind = 'chat' | 'schedule-fire' | 'catalog';

/** The kind a task record reads as. See {@link TaskViewKind}. */
export function taskViewKindOf(record: Pick<TaskRecord, 'kind' | 'incarnation'>): TaskViewKind {
  if (record.kind === 'schedule-fire') return 'schedule-fire';
  return record.incarnation === '' ? 'catalog' : 'chat';
}

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
  /**
   * The principal that started the work on the owner's behalf, when that is not the owner: a
   * schedule's fire is owned by the schedule's owner and started by the scheduler's service
   * principal, `system:scheduler`. Absent for a task its owner started.
   */
  readonly actor?: string | undefined;
  /**
   * What kind of task this is, when it is not an ordinary run: `schedule-fire` for one fire of a
   * schedule (COR-1482). A fire runs headless on the durable engine: it has no live run in
   * Bureau's run store and writes no `run.*` events to the durable history, so what is known of
   * it is what this registry records. Absent for every other task.
   */
  readonly kind?: TaskKind | undefined;
  readonly createdAt: string;
  readonly history: readonly TaskMessage[];
  readonly settled?: TaskSettlement | undefined;
  readonly cleanup?: TaskCleanupState | undefined;
  /**
   * The acknowledgement `cleanup` was read from, once one arrived: what A2A's cleanup extension
   * reports beside the state, since the state alone does not say whether cleanup completed or was
   * not required, or why it is unresolved. Absent before an acknowledgement, and in a record
   * written before it was kept.
   */
  readonly cleanupAcknowledgement?: TaskCleanupAcknowledgement | undefined;
  /**
   * How many times the record has changed since it was written (COR-1669); absent in a record
   * written before it was kept, which reads as `0`. A `task.resynced` event carries the revision
   * it described, so a repair that raced a later change is known not to cover it.
   */
  readonly revision?: number | undefined;
  /**
   * Whether a durable event of the task failed to append and the history has not been repaired
   * since (COR-1669). Set before the repair is attempted and cleared only once the
   * `task.resynced` event it appends has committed, so a crash in between leaves the repair owed.
   */
  readonly resyncPending?: boolean | undefined;
  /**
   * The tools the task was granted when it started (COR-1710), read from `bureau.settings` once
   * and never rebuilt: a task resumed after recovery, or answered after it parked, is offered
   * these, whatever the settings say by then. Absent in a record written before it was kept; such
   * a task resumes with the settings at resume, which are then recorded here.
   */
  readonly tools?: TaskToolGrant | undefined;
}

/** COR-1710 — the tools a task was granted at start: `tools.*` of `bureau.settings` at that moment. */
export interface TaskToolGrant {
  /** `false`, or the grant of `requestHumanInput` with its answer schemas per signal. */
  readonly humanInput:
    false | { readonly inputSchemas?: Readonly<Record<string, Readonly<Record<string, unknown>>>> };
  readonly wakeup: boolean;
  readonly decide: boolean;
}

/** A cleanup acknowledgement as a task record keeps it: its status and, when unresolved, why. */
export type TaskCleanupAcknowledgement =
  | { readonly status: 'not-required' | 'completed' | 'failed' }
  | { readonly status: 'unresolved'; readonly reason: CleanupAcknowledgementReason };

/** What a task is created from. */
export interface TaskAdmission {
  readonly taskId: string;
  readonly contextId: string;
  readonly incarnation: string;
  readonly agentName: string | null;
  readonly owner: string;
  /** See {@link TaskRecord.actor}. */
  readonly actor?: string | undefined;
  /** See {@link TaskRecord.kind}. */
  readonly kind?: TaskKind | undefined;
  /** The originating user message's text, when the request had one. */
  readonly message: string | undefined;
  /** See {@link TaskRecord.tools}. */
  readonly tools?: TaskToolGrant | undefined;
  /** When the work began, if that was before this record was written (ISO 8601). */
  readonly createdAt?: string | undefined;
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
  /** The service principal that started the task for its owner, or `null` when its owner did. */
  readonly actor: string | null;
  /** What `contextId` names. See {@link TaskViewKind}. */
  readonly kind: TaskViewKind;
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
  /**
   * Requests cancellation of a live task. Idempotent. `requested` when the run is being stopped,
   * `already-terminal` when it had ended before the request could take effect, `not-found` when
   * this process holds no such run.
   */
  readonly abort: (taskId: string) => 'requested' | 'already-terminal' | 'not-found';
  /** Cancels a durable run this process holds no live run for. */
  readonly cancelDurable: (taskId: string) => Promise<CancelDurableRunOutcome>;
  /**
   * Drops this process's own copy of a review another process closed (COR-1613): the durable
   * history says it was decided or expired, so what this process still lists for it is stale.
   */
  readonly releaseClosedReview?:
    ((taskId: string, reviewId: string, eventKind: string) => Promise<void>) | undefined;
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

/** A page of tasks, by offset: what {@link TaskRegistry.enumerate} answers. */
export interface TaskPage {
  readonly tasks: readonly TaskView[];
  readonly nextOffset: number | null;
}

/** A page of a snapshot-consistent listing (COR-1304). */
export interface TaskListPage<T = TaskView> {
  readonly tasks: readonly T[];
  /** Opaque; `null` when no entries remain. */
  readonly nextPageToken: string | null;
  /**
   * How many tasks matched when the listing's first page was read: the snapshot's size before
   * windowing, the same on every page. A task removed since is still counted.
   */
  readonly totalSize: number;
}

/** What {@link TaskRegistry.list} filters and pages by. */
export interface TaskListQuery<T = TaskView> {
  /**
   * Who is listing: the caller's identity, which owns the listing's snapshot and counts toward
   * the per-principal cap. It is the caller's owner key when it has one.
   */
  readonly principal: string;
  /** Only this owner's tasks; omit for the every-owner reach (`bureau.tasks:read`). */
  readonly owner?: string | undefined;
  readonly contextId?: string | undefined;
  readonly agentName?: string | undefined;
  readonly status?: TaskState | undefined;
  /** Only tasks whose status timestamp is strictly after this ISO 8601 instant. */
  readonly statusTimestampAfter?: string | undefined;
  /** Entries per page. It is not bound to the snapshot, so it may vary between pages. */
  readonly limit: number;
  readonly pageToken?: string | undefined;
  /**
   * What each entry is, computed once from the entry's view when the snapshot is built and
   * returned from the snapshot on every later page. It must return JSON-serializable data.
   * Omitted, an entry is its {@link TaskView}.
   */
  readonly project?: ((view: TaskView) => T | Promise<T>) | undefined;
  /**
   * Which wire projection the entries are in; a token is valid only for the projection it was
   * issued for. Defaults to `'task-view'`, the native listing; an A2A `ListTasks` names `'a2a'`.
   */
  readonly projection?: string | undefined;
}

/** What `enumerate` filters and pages by. */
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
  /**
   * Lists tasks, most recently changed first (`TaskView.updatedAt` descending, then id
   * ascending), as a snapshot-consistent listing (COR-1304). The first page that has a next page
   * records the ordered listing; its `nextPageToken` names that record, and every later page is
   * read from it, so a task that changes or is created mid-enumeration neither moves nor repeats.
   * A task removed since is skipped, so a page may hold fewer than `limit` entries. A refused
   * token throws a {@link TaskListingTokenError}.
   */
  list<T = TaskView>(query: TaskListQuery<T>): Promise<TaskListPage<T>>;
  /**
   * Every task matching `query`, newest first by creation, by offset. For the Bureau's own
   * enumerations: it records no snapshot and counts toward no cap.
   */
  enumerate(query: TaskQuery): Promise<TaskPage>;
  /** Deletes the expired task-listing snapshots without reading them. Resolves how many keys. */
  expireListings(): Promise<number>;
  /** Writes the record of a task about to start. */
  recordAdmission(admission: TaskAdmission): Promise<void>;
  /**
   * COR-1710 — records `tools` on a task whose record has none, and returns the grant the record
   * holds afterwards: the one it already had, or `tools`. `undefined` when there is no record.
   */
  recordToolGrant(taskId: string, tools: TaskToolGrant): Promise<TaskToolGrant | undefined>;
  /** Removes a record whose task never started. */
  discard(taskId: string): Promise<void>;
  /**
   * Binds a task to the session incarnation its run turned out to run in (COR-1482). A schedule's
   * fire is written before the session it runs in exists, and a fresh session gets its
   * incarnation when the fire first saves it, so the record is written unbound (`''`, a context
   * that is only a run) and bound here once the incarnation is known. A task already bound
   * keeps the incarnation it has. Resolves `false`, writing nothing, when the task has no record
   * or is already bound.
   */
  bindIncarnation(taskId: string, incarnation: string): Promise<boolean>;
  /**
   * The records of a context's schedule fires that have not been settled: the fires running, as
   * far as this registry knows. They are not in Bureau's run store, so they are what makes a
   * context live (and what deleting it must cancel) beside the runs the store holds. A fire
   * not yet bound to a session incarnation is the context's whichever incarnation it has; a
   * bound one belongs to `incarnation` like any task, so a context recreated under the same id
   * does not inherit its predecessor's fire.
   */
  unsettledFiresOfContext(
    contextId: string,
    incarnation: string | undefined,
  ): Promise<readonly TaskRecord[]>;
  /**
   * Calls `listener` with the task's view once it is settled, and once only, whether the
   * settlement was recorded by the run's end or by a cancellation. Returns the function that
   * stops listening. A task already settled is not announced: read it with {@link get}.
   */
  onSettled(taskId: string, listener: SettledListener): () => void;
  /**
   * Calls `listener` with the task's view each time {@link announceChanged} finds it changed, for
   * as long as it listens (COR-1596). Returns the function that stops listening.
   */
  onChanged(taskId: string, listener: (view: TaskView) => void): () => void;
  /**
   * Tells the task's listeners that a review of it opened or closed, which changes what its view
   * says without a write to its record. Those waiting for it to settle are told too, once the
   * closing of its last review is what lets a settled task read as over. Does nothing when no one
   * listens.
   */
  announceChanged(taskId: string): Promise<void>;
  /**
   * Tells the registry that a review of the task was closed by another process (COR-1613): its
   * stale copy here is dropped, then those following the task are told, as for a review closed
   * here, so the task's end reaches a stream this process serves.
   */
  reviewClosedElsewhere(taskId: string, reviewId: string, eventKind: string): Promise<void>;
  /**
   * Records how a task ended. The latest settlement wins, with the answer kept. Resolves
   * `false`, writing nothing, when the task has no record.
   */
  recordSettled(taskId: string, settlement: TaskSettlement): Promise<boolean>;
  /**
   * A bound, not a barrier. Waits up to `maximumTurns` event-loop turns (default 50; by turn, not
   * by clock) for the cleanup acknowledgements the registry is following to arrive, then waits
   * for every write it started to land. An acknowledgement that arrives within the bound is
   * recorded before this resolves; one that arrives later is not waited for, so after a shutdown
   * it is not recorded and its task keeps `cleanup-pending`: nothing here can know that an
   * acknowledgement is never coming. A
   * shutdown awaits it after the runs have been ended, so the cleanup of a run that ended as the
   * engine was disposed is recorded when the engine acknowledges it promptly, before storage
   * closes.
   */
  idle(maximumTurns?: number): Promise<void>;
  /**
   * Resolves once every settlement and cleanup write now in flight has landed (or failed),
   * including any that begin while it waits. A shutdown awaits it before storage closes.
   */
  flush(): Promise<void>;
  /** The records of tasks that have not been settled: the ones a crash may have left so. */
  unsettled(): Promise<readonly TaskRecord[]>;
  /**
   * The records of schedule fires that have been settled (COR-1594). A boot reads them to append the
   * history event of a fire whose process died between writing the settlement and appending it.
   */
  settledFires(): Promise<readonly TaskRecord[]>;
  /**
   * The records a history repair may owe (COR-1669): every session run's record that is marked
   * resync-pending or has settled. A schedule fire and a catalog task write no `run.*` events and
   * are never listed.
   */
  resyncCandidates(): Promise<readonly TaskRecord[]>;
  /**
   * Marks a task resync-pending without counting it as a change of the task. Resolves `false`
   * when the task has no record.
   */
  markResyncPending(taskId: string): Promise<boolean>;
  /**
   * Clears the mark, but only while the record is still at `revision`: a change that landed since
   * the repair read the task keeps the repair owed. Resolves whether the mark is clear.
   */
  clearResyncPending(taskId: string, revision: number): Promise<boolean>;
  /**
   * Follows a task's `closed()` acknowledgement and records where its cleanup
   * ended. A second call for a task already followed returns the first.
   */
  watchCleanup(taskId: string, closed: Promise<CleanupAcknowledgement>): Promise<TaskCleanupState>;
  /** Deletes a task's record, as its run is deleted. */
  remove(taskId: string): Promise<void>;
  /**
   * Deletes the record of every task that settled before `cutoffMs` and whose run
   * this process no longer holds, except the ids in `keep` and the tasks with a review
   * still pending. A run the Bureau still
   * holds is deleted through `deleteRun`, which removes its record. Resolves how
   * many records it removed. `onRemoved` hears each record it removed, once it is gone, so
   * state kept for a task past its settling can end with it; a listener that throws is its own
   * failure, never the removal's. `beforeRemove` runs first, for state that must be gone
   * before the record is: when it throws, the failure is diagnosed and the record is kept,
   * so a later pass retries it.
   */
  expire(
    cutoffMs: number,
    keep: ReadonlySet<string>,
    onRemoved?: (record: TaskRecord) => Promise<void> | void,
    beforeRemove?: (record: TaskRecord) => Promise<void>,
  ): Promise<number>;
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
  /**
   * What each context is doing, answered for the whole set in one query, from the context's
   * latest task alone. Only the tasks of the context's incarnation count (see
   * {@link belongsToIncarnation}): `incarnations` names the one a caller has authorized for a
   * context, and a context it does not name is read at the incarnation it has now.
   */
  activityOf(
    contextIds: readonly string[],
    incarnations?: ReadonlyMap<string, string>,
  ): Promise<ReadonlyMap<string, ContextActivity>>;
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
  /**
   * Told, after {@link TaskRegistry.recordSettled} has written the settlement and announced it
   * here, of each schedule fire it settled (COR-1594). The Bureau records the fire's end in the
   * durable history from here, which is how a stream another process serves learns of it. A
   * rejection is diagnosed, never thrown into the settlement.
   */
  readonly onFireSettled?: ((record: TaskRecord) => Promise<void>) | undefined;
  /** Told once after a task's first terminal state is committed. */
  readonly onSettled?: ((record: TaskRecord) => Promise<void>) | undefined;
}

/** The task state a settled run maps to. */
export function settledTaskState(
  status: 'completed' | 'error' | 'aborted',
  finishReason: string | undefined,
): TaskSettlement['status'] {
  if (status === 'aborted') return 'canceled';
  if (status === 'error') return 'failed';
  if (finishReason === 'aborted') return 'canceled';
  return isFailureFinishReason(finishReason) ? 'failed' : 'completed';
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

/**
 * Whether a task belongs to one incarnation of its context: the one predicate every per-context
 * task read answers by (`list` with a `contextId`, `activityOf`, `clearHistory`), so they cannot
 * disagree. A context deleted and created again under the same id is a new one, and its
 * predecessor's tasks are not its own. A catalog record has `incarnation: ''`, so it belongs to
 * a context with no session and to none that has one; `incarnation` is `undefined` for a context
 * with no live session.
 */
export function belongsToIncarnation(
  record: Pick<TaskRecord, 'incarnation'>,
  incarnation: string | undefined,
): boolean {
  return record.incarnation === (incarnation ?? '');
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

const SETTLED_STATES: ReadonlySet<unknown> = new Set(['completed', 'failed', 'canceled']);
const CLEANUP_STATES: ReadonlySet<unknown> = new Set<TaskCleanupState>([
  'cancel-requested',
  'canceled',
  'cleanup-pending',
  'cleaned-up',
  'cleanup-failed',
  'cleanup-unresolved',
  'unknown-outcome',
]);

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isStringOrNull(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

function isTaskMessage(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value['messageId'] === 'string' &&
    value['role'] === 'user' &&
    typeof value['text'] === 'string' &&
    isTimestamp(value['createdAt'])
  );
}

function isTaskSettlement(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const answer = value['answer'];
  return (
    isTimestamp(value['at']) &&
    SETTLED_STATES.has(value['status']) &&
    isStringOrNull(value['finishReason']) &&
    isStringOrNull(value['message']) &&
    (answer === undefined ||
      (isRecord(answer) &&
        typeof answer['text'] === 'string' &&
        typeof answer['truncated'] === 'boolean'))
  );
}

const ACKNOWLEDGEMENT_STATUSES: ReadonlySet<unknown> = new Set([
  'not-required',
  'completed',
  'failed',
  'unresolved',
]);

const UNRESOLVED_REASONS: ReadonlySet<unknown> = new Set([
  'timed-out',
  'unreachable',
  'persistence-failed',
  'unknown-effect',
]);

function isCleanupAcknowledgement(value: unknown): boolean {
  if (!isRecord(value) || !ACKNOWLEDGEMENT_STATUSES.has(value['status'])) return false;
  return value['status'] !== 'unresolved' || UNRESOLVED_REASONS.has(value['reason']);
}

/** Whether a stored value is a task record in every field a reader depends on. */
function isTaskRecord(value: unknown): value is TaskRecord {
  return (
    isRecord(value) &&
    value['schemaVersion'] === 1 &&
    typeof value['taskId'] === 'string' &&
    typeof value['contextId'] === 'string' &&
    typeof value['incarnation'] === 'string' &&
    isStringOrNull(value['agentName']) &&
    typeof value['owner'] === 'string' &&
    (value['actor'] === undefined || typeof value['actor'] === 'string') &&
    (value['kind'] === undefined || value['kind'] === 'schedule-fire') &&
    isTimestamp(value['createdAt']) &&
    Array.isArray(value['history']) &&
    value['history'].every(isTaskMessage) &&
    (value['settled'] === undefined || isTaskSettlement(value['settled'])) &&
    (value['cleanup'] === undefined || CLEANUP_STATES.has(value['cleanup'])) &&
    (value['cleanupAcknowledgement'] === undefined ||
      isCleanupAcknowledgement(value['cleanupAcknowledgement']))
  );
}

function parseRecord(key: string, raw: string): TaskRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`The task record at "${key}" is not valid JSON.`, { cause: error });
  }
  if (!isTaskRecord(parsed)) throw new Error(`The value at "${key}" is not a task record.`);
  return parsed;
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
  /** Who is waiting to be told a task has settled (COR-1482). */
  const settledListeners = new Map<string, Set<SettledListener>>();
  /** Who is waiting to be told a task's view changed (COR-1596). */
  const changedListeners = new Map<string, Set<(view: TaskView) => void>>();

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
    counted = true,
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
        [
          {
            type: 'set',
            key,
            value: JSON.stringify(
              counted ? { ...next, revision: (current.revision ?? 0) + 1 } : next,
            ),
          },
        ],
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
      actor: record.actor ?? null,
      kind: taskViewKindOf(record),
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

  async function matchingViews(
    query: Pick<TaskQuery, 'owner' | 'contextId' | 'agentName' | 'status'>,
  ): Promise<TaskView[]> {
    let records =
      query.contextId === undefined ? await allRecords() : await recordsOfContext(query.contextId);
    if (query.contextId !== undefined) {
      // Only the context's current incarnation: a context deleted and recreated
      // under the same id is a new one, and its predecessor's tasks are not its own.
      const current = await host.currentIncarnation(query.contextId);
      records = records.filter((record) => belongsToIncarnation(record, current));
    }
    if (query.owner !== undefined) {
      records = records.filter((record) => record.owner === query.owner);
    }
    if (query.agentName !== undefined) {
      records = records.filter((record) => record.agentName === query.agentName);
    }
    const grouped = reviewsByRun(host.pendingReviews());
    const views = records.map((record) => viewOf(record, grouped.get(record.taskId)));
    return query.status === undefined
      ? views
      : views.filter((view) => view.status === query.status);
  }

  const listings = createTaskListingStore({
    kv,
    now: () => Date.parse(clock.nowISO()),
  });

  /**
   * The key a view sorts by in a snapshotted listing. The status timestamp is `updatedAt`: the
   * settlement's time once the task settled, otherwise the time of the run's latest recorded
   * action, otherwise its creation. A working task's timestamp therefore also moves on actions
   * that are not status changes, and a review opening or closing moves the status without moving
   * it; no separate status-change time is persisted.
   */
  function listingKeyOf(view: TaskView): TaskListingKey {
    return { at: Date.parse(view.updatedAt), id: view.id };
  }

  function filtersOf(query: TaskListQuery<unknown>): TaskListingFilters {
    return {
      contextId: query.contextId ?? null,
      agentName: query.agentName ?? null,
      status: query.status ?? null,
      statusTimestampAfter:
        query.statusTimestampAfter === undefined ? null : Date.parse(query.statusTimestampAfter),
    };
  }

  /** One fresh window: the matching views strictly after `after`, projected, within the bounds. */
  async function buildWindow<T>(
    query: TaskListQuery<T>,
    scope: TaskListingScope,
    after: TaskListingKey | null,
  ): Promise<{
    entries: TaskListingEntry<T>[];
    continuation: TaskListingKey | null;
    matched: number;
  }> {
    const { statusTimestampAfter } = scope.filters;
    const views = await matchingViews(query);
    const keyed = views
      .map((view) => ({ view, key: listingKeyOf(view) }))
      .filter(
        ({ key }) =>
          (statusTimestampAfter === null || key.at > statusTimestampAfter) &&
          (after === null || isAfterListingKey(key, after)),
      )
      .toSorted((left, right) => compareListingKeys(left.key, right.key));
    const entries: TaskListingEntry<T>[] = [];
    let bytes = 0;
    for (const { view, key } of keyed) {
      const value = query.project === undefined ? (view as T) : await query.project(view);
      const entry = { ...key, value };
      const entryBytes = listingEntryBytes(entry);
      if (!fitsListingWindow(entries.length, bytes, entryBytes)) {
        const last = entries.at(-1);
        return {
          entries,
          continuation: last === undefined ? null : { at: last.at, id: last.id },
          matched: keyed.length,
        };
      }
      entries.push(entry);
      bytes += entryBytes;
    }
    return { entries, continuation: null, matched: keyed.length };
  }

  /** The page of `record` starting at `position`, skipping tasks removed since the snapshot. */
  async function pageOf<T>(
    record: TaskListingRecord<T>,
    position: number,
    limit: number,
  ): Promise<TaskListPage<T>> {
    const end = position + limit;
    const tasks: T[] = [];
    for (const entry of record.entries.slice(position, end)) {
      if (await kv.has(recordKey(entry.id))) tasks.push(entry.value);
    }
    let nextPageToken: string | null = null;
    if (end < record.entries.length || record.continuation !== null) {
      nextPageToken = encodeListingToken({
        listingId: record.listingId,
        window: record.window,
        expiresAt: record.expiresAt,
        position: Math.min(end, record.entries.length),
      });
    }
    return { tasks, nextPageToken, totalSize: record.total };
  }

  async function startListing<T>(
    query: TaskListQuery<T>,
    scope: TaskListingScope,
  ): Promise<TaskListPage<T>> {
    const incarnation =
      query.contextId === undefined
        ? null
        : ((await host.currentIncarnation(query.contextId)) ?? '');
    const createdAt = Date.parse(clock.nowISO());
    const window = await buildWindow(query, scope, null);
    const record: TaskListingRecord<T> = {
      ...scope,
      listingId: identifiers.next('task-listing'),
      window: 0,
      incarnation,
      createdAt,
      expiresAt: createdAt + TASK_LISTING_LIFETIME_MILLISECONDS,
      entries: window.entries,
      continuation: window.continuation,
      total: window.matched,
    };
    const page = await pageOf(record, 0, query.limit);
    // A listing that fits its first page has no next page and leaves nothing behind.
    if (page.nextPageToken !== null) await listings.save(record);
    return page;
  }

  /** The window after `previous`, built once: a retried token finds the one already stored. */
  async function nextWindow<T>(
    query: TaskListQuery<T>,
    scope: TaskListingScope,
    previous: TaskListingRecord<T>,
  ): Promise<TaskListingRecord<T>> {
    const window = previous.window + 1;
    const stored = await listings.find<T>(scope, previous.listingId, previous.expiresAt, window);
    if (stored !== undefined) return stored;
    const built = await buildWindow(query, scope, previous.continuation);
    // A later window keeps the listing's total, counted once when its first page was read.
    const record: TaskListingRecord<T> = {
      ...previous,
      window,
      entries: built.entries,
      continuation: built.continuation,
    };
    await listings.save(record);
    return record;
  }

  async function continueListing<T>(
    query: TaskListQuery<T>,
    scope: TaskListingScope,
    pageToken: string,
  ): Promise<TaskListPage<T>> {
    const token = decodeListingToken(pageToken);
    let record = await listings.load<T>(token, scope);
    if (query.contextId !== undefined) {
      const current = (await host.currentIncarnation(query.contextId)) ?? '';
      if (current !== record.incarnation) throw new TaskListingTokenError('context-changed');
    }
    let { position } = token;
    if (position >= record.entries.length) {
      // The window is spent: the token after its last entry starts the next window.
      if (record.continuation === null) {
        return { tasks: [], nextPageToken: null, totalSize: record.total };
      }
      record = await nextWindow(query, scope, record);
      position = 0;
    }
    return pageOf(record, position, query.limit);
  }

  async function listSnapshotted<T = TaskView>(query: TaskListQuery<T>): Promise<TaskListPage<T>> {
    const scope: TaskListingScope = {
      principal: query.principal,
      reach: query.owner === undefined ? 'every-owner' : 'own',
      projection: query.projection ?? 'task-view',
      filters: filtersOf(query),
    };
    return query.pageToken === undefined
      ? startListing(query, scope)
      : continueListing(query, scope, query.pageToken);
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
        await track(
          update(taskId, (record) => ({
            ...record,
            cleanup: state,
            // The error an acknowledgement may carry is the run's own detail, never stored.
            cleanupAcknowledgement:
              acknowledgement.status === 'unresolved'
                ? { status: 'unresolved', reason: acknowledgement.reason }
                : { status: acknowledgement.status },
          })),
        );
      } catch (error) {
        diagnose(`Could not record the cleanup of task "${taskId}"`, error);
      }
      return state;
    });
    watchers.set(taskId, watcher);
    return watcher;
  }

  async function getView(taskId: string): Promise<TaskView | undefined> {
    const record = await read(taskId);
    if (record === undefined) return undefined;
    const grouped = reviewsByRun(host.pendingReviews().filter((review) => review.runId === taskId));
    return viewOf(record, grouped.get(taskId));
  }

  /**
   * Tells {@link CreateTaskRegistryOptions.onFireSettled} that a schedule fire's settlement has been
   * written, wherever it was written (COR-1594). Other kinds of task are not announced. A rejection
   * is diagnosed and not thrown into the settlement: the boot pass over settled fires appends an
   * event that never landed.
   */
  async function recordFireSettled(record: TaskRecord): Promise<void> {
    if (record.kind !== 'schedule-fire' || options.onFireSettled === undefined) return;
    try {
      await options.onFireSettled(record);
    } catch (error) {
      diagnose(`Could not record in the history how schedule fire "${record.taskId}" ended`, error);
    }
  }

  async function announceRecordedSettlement(
    taskId: string,
    record: TaskRecord,
    newlySettled: boolean,
  ): Promise<void> {
    await announceSettled(taskId);
    await recordFireSettled(record);
    if (newlySettled) await options.onSettled?.(record);
  }

  /**
   * Tells whoever waits that the task has settled. A listener is told once, however many
   * settlements are written back to back, and a task not yet settled (a write that changed
   * something else) tells no one. A listener that throws is its
   * own failure, never the write's.
   */
  async function recordSettlement(
    taskId: string,
    settlement: Parameters<TaskRegistry['recordSettled']>[1],
  ): Promise<boolean> {
    const captured: { settled?: TaskRecord; newlySettled: boolean } = { newlySettled: false };
    const recorded = await track(
      update(taskId, (record) => {
        // A task has more than one writer of its settlement (the action that ended the run,
        // and the catalog hook that carries the answer), so the answer is never lost to
        // whichever lands last. Only a catalog task and a schedule fire record one: a session
        // run's answer lives in its durable history, and a fire writes none there.
        const answer =
          record.incarnation === '' || record.kind === 'schedule-fire'
            ? (settlement.answer ?? record.settled?.answer)
            : undefined;
        const { answer: _ignored, ...rest } = settlement;
        captured.newlySettled = record.settled === undefined;
        const next: TaskRecord = {
          ...record,
          settled: { ...rest, ...(answer === undefined ? {} : { answer }) },
        };
        captured.settled = next;
        return next;
      }),
    );
    if (recorded && captured.settled !== undefined) {
      await announceRecordedSettlement(taskId, captured.settled, captured.newlySettled);
    }
    return recorded;
  }

  async function announceSettled(taskId: string): Promise<void> {
    const waiting = settledListeners.get(taskId);
    if (waiting === undefined || waiting.size === 0) return;
    const record = await read(taskId);
    const view = await getView(taskId);
    if (record === undefined || view === undefined) return;
    if (view.status !== 'completed' && view.status !== 'failed' && view.status !== 'canceled') {
      return;
    }
    // A settlement written while this call awaited was announced by its own call, which took
    // these listeners: two back-to-back settlements tell each listener once, not twice.
    if (settledListeners.get(taskId) !== waiting) return;
    settledListeners.delete(taskId);
    // A listener that returns a promise is awaited, so settlement work it starts (a reply fold)
    // is tracked with the write that announced it and a shutdown's `idle()` waits for it.
    await Promise.all(
      [...waiting].map(async (listener) => {
        try {
          await listener(view, record);
        } catch (error) {
          diagnose(`A listener of task "${taskId}" failed`, error);
        }
      }),
    );
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
      const createdAt = admission.createdAt ?? clock.nowISO();
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
        ...(admission.actor === undefined ? {} : { actor: admission.actor }),
        ...(admission.kind === undefined ? {} : { kind: admission.kind }),
        createdAt,
        history,
        ...(admission.tools === undefined ? {} : { tools: admission.tools }),
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

    async recordToolGrant(taskId, tools) {
      let held: TaskToolGrant | undefined;
      await update(
        taskId,
        (record) => {
          held = record.tools ?? tools;
          return record.tools === undefined ? { ...record, tools } : undefined;
        },
        false,
      );
      return held;
    },

    async discard(taskId) {
      await this.remove(taskId);
    },

    async bindIncarnation(taskId, incarnation) {
      if (incarnation === '') return false;
      let bound = false;
      await track(
        update(taskId, (record) => {
          if (record.incarnation !== '') return undefined;
          bound = true;
          return { ...record, incarnation };
        }),
      );
      return bound;
    },

    recordSettled(taskId, settlement) {
      // The whole settlement is tracked, its announcement included, so `flush()` (and so
      // `idle()`) also waits for what a settlement listener starts, such as a surface freeze.
      return track(recordSettlement(taskId, settlement));
    },

    async unsettledFiresOfContext(contextId, incarnation) {
      const records = await recordsOfContext(contextId);
      return records.filter(
        (record) =>
          record.kind === 'schedule-fire' &&
          record.settled === undefined &&
          (record.incarnation === '' || belongsToIncarnation(record, incarnation)),
      );
    },

    onSettled(taskId, listener) {
      const waiting = settledListeners.get(taskId) ?? new Set();
      waiting.add(listener);
      settledListeners.set(taskId, waiting);
      return () => {
        const held = settledListeners.get(taskId);
        held?.delete(listener);
        if (held?.size === 0) settledListeners.delete(taskId);
      };
    },

    onChanged(taskId, listener) {
      const waiting = changedListeners.get(taskId) ?? new Set();
      waiting.add(listener);
      changedListeners.set(taskId, waiting);
      return () => {
        const held = changedListeners.get(taskId);
        held?.delete(listener);
        if (held?.size === 0) changedListeners.delete(taskId);
      };
    },

    async reviewClosedElsewhere(taskId, reviewId, eventKind) {
      await host.releaseClosedReview?.(taskId, reviewId, eventKind);
      await this.announceChanged(taskId);
    },

    async announceChanged(taskId) {
      const waiting = changedListeners.get(taskId);
      if (waiting !== undefined && waiting.size > 0) {
        const view = await getView(taskId);
        if (view !== undefined) {
          for (const listener of waiting) {
            try {
              listener(view);
            } catch (error) {
              diagnose(`A listener of task "${taskId}" failed`, error);
            }
          }
        }
      }
      await announceSettled(taskId);
    },

    async idle(maximumTurns = IDLE_MAXIMUM_TURNS) {
      // Wait, by event-loop turn rather than by clock, for every cleanup acknowledgement being
      // followed to arrive. One that has not arrived after `maximumTurns` is abandoned, as a
      // shutdown abandons any other cleanup that is stuck, and the task keeps `cleanup-pending`.
      for (let turn = 0; turn < maximumTurns; turn += 1) {
        if ([...watchers.keys()].every((taskId) => observed.has(taskId))) break;
        await yieldToPortableEventLoop();
      }
      await this.flush();
    },

    async flush() {
      while (inFlight.size > 0) await Promise.allSettled(inFlight);
    },

    async unsettled() {
      const records = await allRecords();
      return records.filter((record) => record.settled === undefined);
    },

    async resyncCandidates() {
      const records = await allRecords();
      return records.filter(
        (record) =>
          record.kind !== 'schedule-fire' &&
          record.incarnation !== '' &&
          (record.resyncPending === true || record.settled !== undefined),
      );
    },

    async markResyncPending(taskId) {
      const marked = await update(
        taskId,
        (record) =>
          record.resyncPending === true ? undefined : { ...record, resyncPending: true },
        false,
      );
      return marked;
    },

    async clearResyncPending(taskId, revision) {
      let clear = false;
      await update(
        taskId,
        (record) => {
          if (record.resyncPending !== true) {
            clear = true;
            return undefined;
          }
          if ((record.revision ?? 0) !== revision) return undefined;
          clear = true;
          const { resyncPending: _cleared, ...rest } = record;
          return rest;
        },
        false,
      );
      return clear;
    },

    async settledFires() {
      const records = await allRecords();
      return records.filter(
        (record) => record.kind === 'schedule-fire' && record.settled !== undefined,
      );
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

    async expire(cutoffMs, keep, onRemoved, beforeRemove) {
      let removed = 0;
      // A review still open holds its task: it is waiting on its requester, and removing the
      // record would make `get` and `respond` not-found while the review holds the context open.
      const held = reviewsByRun(host.pendingReviews());
      for (const record of await allRecords()) {
        if (record.settled === undefined || keep.has(record.taskId)) continue;
        if (held.has(record.taskId)) continue;
        if (Date.parse(record.settled.at) >= cutoffMs) continue;
        if (host.liveTask(record.taskId) !== undefined) continue;
        try {
          await beforeRemove?.(record);
        } catch (error) {
          diagnose(`The cleanup before removing task "${record.taskId}" failed; it is kept`, error);
          continue;
        }
        await this.remove(record.taskId);
        removed += 1;
        try {
          await onRemoved?.(record);
        } catch (error) {
          diagnose(`A listener of the removal of task "${record.taskId}" failed`, error);
        }
      }
      return removed;
    },

    async clearHistory(contextId, incarnation) {
      let cleared = 0;
      for (const record of await recordsOfContext(contextId)) {
        if (!belongsToIncarnation(record, incarnation) || record.history.length === 0) continue;
        await update(record.taskId, (current) => ({ ...current, history: [] }));
        cleared += 1;
      }
      return cleared;
    },

    get: getView,

    async history(taskId) {
      const record = await read(taskId);
      return record?.history;
    },

    async ownerOf(taskId) {
      const record = await read(taskId);
      return record?.owner;
    },

    record: read,

    enumerate: async (query) => {
      const views = await matchingViews(query);
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

    list: listSnapshotted,

    expireListings: () => listings.expire(),

    async activityOf(contextIds, incarnations) {
      const live = host.liveTasksOfContexts(contextIds);
      const waiting = new Set(host.pendingReviews().map((review) => review.runId));
      const activity = new Map<string, ContextActivity>();
      for (const contextId of contextIds) {
        const incarnation =
          incarnations?.get(contextId) ?? (await host.currentIncarnation(contextId));
        // A schedule fire is live while it is unsettled, though it holds no run in the run store.
        const fires = await this.unsettledFiresOfContext(contextId, incarnation);
        // A fire whose run settled while a review of it is still open reads as input-required in
        // its task view, so the context agrees with it: the review holds the fire open (COR-1613).
        const contextRecords = await recordsOfContext(contextId);
        const reviewHeld = contextRecords.filter(
          (record) =>
            record.kind === 'schedule-fire' &&
            record.settled !== undefined &&
            waiting.has(record.taskId) &&
            (record.incarnation === '' || belongsToIncarnation(record, incarnation)),
        );
        const held = [
          ...(live.get(contextId) ?? []),
          ...[...fires, ...reviewHeld].map((record) => ({
            taskId: record.taskId,
            phase: 'running' as const,
          })),
        ];
        if (held.length === 0) {
          activity.set(contextId, 'idle');
          continue;
        }
        const owned: { task: (typeof held)[number]; createdAt: string }[] = [];
        for (const task of held) {
          const record = await read(task.taskId);
          if (
            record !== undefined &&
            (record.kind === 'schedule-fire' || belongsToIncarnation(record, incarnation))
          ) {
            owned.push({ task, createdAt: record.createdAt });
          }
        }
        // Oldest first, the runs of the store and the fires together, so the latest is the latest.
        owned.sort((left, right) =>
          left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0,
        );
        // The context's latest task alone decides: an older parked or working task does not.
        const latest = owned.at(-1)?.task;
        activity.set(
          contextId,
          latest === undefined
            ? 'idle'
            : waiting.has(latest.taskId)
              ? 'awaiting-input'
              : latest.phase === 'running' ||
                  latest.phase === 'aborting' ||
                  latest.phase === 'submitted'
                ? 'running'
                : 'idle',
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
            const canceled: { record?: TaskRecord } = {};
            const recorded = await update(taskId, (current) => {
              const next: TaskRecord = {
                ...current,
                settled: {
                  at: clock.nowISO(),
                  status: 'canceled',
                  finishReason: 'aborted',
                  message: null,
                },
                // A stop with no acknowledgement behind it: a repeat answers the same.
                cleanup: 'canceled',
              };
              canceled.record = next;
              return next;
            });
            if (recorded && canceled.record !== undefined) {
              await announceRecordedSettlement(taskId, canceled.record, true);
            }
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
      // The run can end between the check above and the abort; then nothing was canceled.
      if (host.abort(taskId) === 'already-terminal') {
        return { receipt: 'rejected', reason: 'already-terminal' };
      }
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
