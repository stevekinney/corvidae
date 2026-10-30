/**
 * Writes `LiveSource` frames into the TanStack `QueryClient` (plan §4, §5.1,
 * T1.4): "Frames write into the TanStack cache (setQueryData on detail +
 * events); components render from the cache so a disconnect degrades to
 * last-known-state, never a blank."
 *
 * **Query-key contract.** Plan §4 lists `['workflows','detail',id]` and
 * `['workflows','events',id,cursor]` among the console's query keys. The
 * `cursor` element on the events key is Track A's (Phase 2/3) concern — a
 * paginated "load older history" query this module does not know the shape
 * of. What THIS module writes is the plain, uncursored
 * `['workflows','events',id]` key: the live-tail cache a workflow detail
 * page's live Events view reads from (seeded by an initial `getEvents()`
 * fetch, kept fresh incrementally by `WorkflowTailSource` frames through
 * `applyWorkflowTailFrame`). The two keys serve different purposes and
 * MUST NOT be conflated — flagged explicitly here (and in T1.4's final
 * report) so Track A's own query design lines up with what actually gets
 * written. The key-builder functions below are exported specifically so
 * Track A imports them rather than re-deriving the same array literal by
 * hand, which would silently drift if this module's shape ever changes.
 *
 * **Detail patching is a status-only contract.** `WorkflowSummary` (the
 * real detail/list-row shape, `@lostgradient/weft`) is Track A's to fetch
 * and cache; this module never invents a full one. It patches ONLY
 * `status`/`updatedAt` on whatever is already cached, and only when
 * something is already cached (`setQueryData`'s updater returning the
 * untouched `old` value for a cache-miss is a no-op per TanStack's own
 * `setQueryData` — verified in `@tanstack/query-core`'s source: it never
 * creates a new query entry from an updater's `undefined` result).
 *
 * **Fleet fan-out is invalidation-only, deliberately.** `FleetEventSource`
 * frames never append into the events cache — only `WorkflowTailSource`
 * does. A workflow detail page can have BOTH a tail and (indirectly) the
 * fleet feed observing the same event; writing it through two independent
 * paths risks visible duplicates the tail's own positional dedup can't see.
 * Fleet frames instead invalidate the detail, review, worker, schedule and
 * update-history queries they affect, and the worker, realm, lease, registry and dynamic-source
 * views the engine's state events name (`FLEET_KIND_INVALIDATION`), reusing the exact same key shapes plan
 * §4's mutation invalidation already uses, so live-event invalidation and
 * client-initiated-mutation invalidation stay one convention. The workflow
 * list and aggregate are the exception (plan §5.2's "list-row liveness"
 * belongs to the list's own Live toggle, `workflow-list-live.svelte.ts`):
 * the shell applies every frame, and a list that reflowed under a person
 * mid-read is what that toggle exists to prevent.
 *
 * **Out of scope.** Session-scoped fleet kinds with no persisted list query
 * at this phase — `alert:*`, `constraint:violated`, `checkpoint:size-
 * warning`, `development:warning`, `cleanup:warning`, `storage:size-
 * reported` — are not mapped to any invalidation here. Plan Appendix B
 * frames the alerts/warnings surface as "session-scoped" fed directly by
 * `FleetEventSource.subscribe()`, not by a cache entry this module owns.
 */
import type { WorkflowEvent, WorkflowStatus } from '@lostgradient/weft';
import type { QueryClient, QueryKey } from '@tanstack/svelte-query';

import { isReviewFleetEventKind } from '../../routes/reviews/review-domain.ts';
import { invalidateEmptyViews } from '../empty-views.ts';
import type { FleetEventFrame } from './fleet-event-source.svelte.ts';
import { workflowStatusForEventType } from './workflow-lifecycle-events.ts';

// ---------------------------------------------------------------------------
// Query keys (plan §4). Import these rather than re-deriving the arrays.
// ---------------------------------------------------------------------------

/** The query key of one workflow's detail. */
export function workflowDetailKey(workflowId: string): QueryKey {
  return ['workflows', 'detail', workflowId];
}

/** Matches `finalizerQueryKey(id)` (`../../routes/workflows/detail/workflow-observability.ts`) — kept as a literal here (not an import) for the same reason every other key in this module is. */
export function workflowFinalizerKey(workflowId: string): QueryKey {
  return ['workflows', 'finalizer', workflowId];
}

/** The live-tail events cache — see module doc for how this differs from Track A's cursor-paginated key. */
export function workflowEventsKey(workflowId: string): QueryKey {
  return ['workflows', 'events', workflowId];
}

/** The query-key prefix of every workflow list. */
export const WORKFLOWS_LIST_KEY_PREFIX: QueryKey = ['workflows', 'list'];
/** The query-key prefix of every workflow aggregate. */
export const WORKFLOWS_AGGREGATE_KEY_PREFIX: QueryKey = ['workflows', 'aggregate'];
/** The query-key prefix of every schedule list. */
export const SCHEDULES_LIST_KEY_PREFIX: QueryKey = ['schedules', 'list'];
/** The query-key prefix of every schedule's detail. */
export const SCHEDULES_DETAIL_KEY_PREFIX: QueryKey = ['schedules', 'detail'];
/** The query-key prefix of every schedule's run history. */
export const SCHEDULES_RUN_HISTORY_KEY_PREFIX: QueryKey = ['schedules', 'run-history'];
/** The query-key prefix of every review list. */
export const REVIEWS_LIST_KEY_PREFIX: QueryKey = ['reviews', 'list'];
/** The query key of the worker list. */
export const WORKERS_LIST_KEY: QueryKey = ['workers', 'list'];
/** The query-key prefix of every workflow's detail. */
export const WORKFLOWS_DETAIL_KEY_PREFIX: QueryKey = ['workflows', 'detail'];
/** The query-key prefix of every workflow's finalizer. */
export const WORKFLOWS_FINALIZER_KEY_PREFIX: QueryKey = ['workflows', 'finalizer'];
/** The query-key prefix of every workflow's updates. */
export const WORKFLOWS_UPDATES_KEY_PREFIX: QueryKey = ['workflows', 'updates'];
/** The query-key prefix of every worker's manifests. */
export const WORKERS_MANIFESTS_KEY_PREFIX: QueryKey = ['workers', 'manifests'];
/** The query key of the worker rejections. */
export const WORKERS_REJECTIONS_KEY: QueryKey = ['workers', 'rejections'];
/** The query key of the worker deployments. */
export const WORKERS_DEPLOYMENTS_KEY: QueryKey = ['workers', 'deployments'];
/** The query key of the queue list. */
export const QUEUES_LIST_KEY: QueryKey = ['queues', 'list'];
/** The query-key prefix of every task's detail. */
export const TASKS_DETAIL_KEY_PREFIX: QueryKey = ['tasks', 'detail'];
/** The query-key prefix of every task's deliveries. */
export const TASKS_DELIVERIES_KEY_PREFIX: QueryKey = ['tasks', 'deliveries'];
/** The registry snapshot sits under this prefix (`queryKeys.registrySnapshot`), so one invalidation reads both. */
export const REGISTRY_KEY_PREFIX: QueryKey = ['registry'];
/** The query key of the realms. */
export const REALMS_KEY: QueryKey = ['realms'];
/** The query key of the system lease. */
export const SYSTEM_LEASE_KEY: QueryKey = ['system', 'lease'];
/** The query-key prefix of the catalog's sources. */
export const CATALOG_SOURCES_KEY_PREFIX: QueryKey = ['catalog', 'sources'];
/** The query-key prefix of the catalog's diagnostics. */
export const CATALOG_DIAGNOSTICS_KEY_PREFIX: QueryKey = ['catalog', 'diagnostics'];

/** Matches `updateHistoryQueryKey(id)` (`../../routes/workflows/detail/updates/updates-data.ts`) — a literal here for the same reason every other key in this module is, with a test that keeps the two equal. */
export function workflowUpdatesKey(workflowId: string): QueryKey {
  return ['workflows', 'updates', workflowId];
}

/** Fleet kinds that end a run: the status a schedule's last-run glyph and recent-runs list read. */
const WORKFLOW_SETTLED_KINDS: ReadonlySet<string> = new Set([
  'workflow:completed',
  'workflow:failed',
  'workflow:cancelled',
  'workflow:timed-out',
]);

/** Fleet kinds that move a schedule's own fields: when it last fired and when it fires next. */
const SCHEDULE_FIRE_KINDS: ReadonlySet<string> = new Set([
  'schedule:fired',
  'schedule:missed-fire',
]);

/** Fleet kinds that move a run's update history: an update arrived, or it was answered. */
const WORKFLOW_UPDATE_KINDS: ReadonlySet<string> = new Set(['update:received', 'update:completed']);

/** The fleet kind of a run beginning: the first run of a type fills a runs page that was empty. */
const WORKFLOW_STARTED_KIND = 'workflow:started';

/** The kind of the retention notice a fleet feed sends when a cursor names events it no longer holds (`FleetEventGapEnvelope`). */
const FLEET_GAP_KIND = 'fleet:gap';

const WORKER_FLEET_KEYS: readonly QueryKey[] = [
  WORKERS_LIST_KEY,
  WORKERS_MANIFESTS_KEY_PREFIX,
  // Contract verification compares the manifests with the registry snapshot, so the two are read together (COR-162).
  REGISTRY_KEY_PREFIX,
  // A worker registering records its build, which the deployments list offers for promotion.
  WORKERS_DEPLOYMENTS_KEY,
  // A queue's connected workers are the workers on it, and its in-flight count is theirs.
  QUEUES_LIST_KEY,
];

/**
 * The kinds that change the durable work a deployment build is bound to: each build reports the
 * number of runs that are not terminal and of task-ledger entries that are not terminal that name
 * it (`executionReferences`), which decides whether a draining build can be removed. A run
 * starting or ending, and a task being queued or reaching a result, move that count.
 */
const DEPLOYMENT_REFERENCE_KINDS: readonly string[] = [
  'workflow:started',
  'workflow:completed',
  'workflow:failed',
  'workflow:cancelled',
  'workflow:timed-out',
  'activity:remote-queued',
  'activity:completed',
  'activity:failed',
  'task:dead-lettered',
];

/**
 * The kinds that move a queue's in-flight count, which is the number of tasks its workers hold: an
 * attempt starting, or ending without a result or with one. `queue:depth-changed` reports only the
 * pending count, and a worker connecting or leaving moves the connected count (`WORKER_FLEET_KEYS`).
 */
const QUEUE_LOAD_KINDS: readonly string[] = [
  'activity:started',
  'activity:completed',
  'activity:failed',
  'task:dead-lettered',
];

const CATALOG_SOURCE_FLEET_KEYS: readonly QueryKey[] = [
  CATALOG_SOURCES_KEY_PREFIX,
  CATALOG_DIAGNOSTICS_KEY_PREFIX,
];

/**
 * The entries one fleet kind makes stale, for the kinds that name no run and so map to a list or a
 * panel instead of a workflow (a schedule's own are `applyScheduleFleetFrame`'s, a review's are
 * `isReviewFleetEventKind`'s). A worker that reconnects keeps its id, so the manifests are read by
 * prefix: the key built from the ids would not change. Extend as new views follow the feed.
 */
const FLEET_KIND_INVALIDATION: ReadonlyMap<string, readonly QueryKey[]> = new Map<
  string,
  readonly QueryKey[]
>([
  ['worker:connected', WORKER_FLEET_KEYS],
  ['worker:disconnected', WORKER_FLEET_KEYS],
  ['worker:registration-rejected', [WORKERS_REJECTIONS_KEY]],
  ['worker:deployment-changed', [WORKERS_DEPLOYMENTS_KEY, WORKERS_LIST_KEY]],
  ['queue:depth-changed', [QUEUES_LIST_KEY]],
  // A kind may move both the deployments' references and a queue's in-flight count.
  ...[...new Set([...DEPLOYMENT_REFERENCE_KINDS, ...QUEUE_LOAD_KINDS])].map(
    (kind): [string, readonly QueryKey[]] => [
      kind,
      [
        ...(DEPLOYMENT_REFERENCE_KINDS.includes(kind) ? [WORKERS_DEPLOYMENTS_KEY] : []),
        ...(QUEUE_LOAD_KINDS.includes(kind) ? [QUEUES_LIST_KEY] : []),
      ],
    ],
  ),
  ['workflow:definition-registered', [REGISTRY_KEY_PREFIX]],
  ['realm:state-changed', [REALMS_KEY]],
  ['lease:health-changed', [SYSTEM_LEASE_KEY]],
  ['workflow-source:load-started', CATALOG_SOURCE_FLEET_KEYS],
  ['workflow-source:load-ready', CATALOG_SOURCE_FLEET_KEYS],
  ['workflow-source:load-failed', CATALOG_SOURCE_FLEET_KEYS],
  ['workflow-source:load-cancelled', CATALOG_SOURCE_FLEET_KEYS],
  ['catalog:revision-installed', CATALOG_SOURCE_FLEET_KEYS],
  ['catalog:revision-activated', CATALOG_SOURCE_FLEET_KEYS],
  ['catalog:activation-rejected', CATALOG_SOURCE_FLEET_KEYS],
  ['catalog:revision-draining', CATALOG_SOURCE_FLEET_KEYS],
  ['catalog:revision-removed', CATALOG_SOURCE_FLEET_KEYS],
]);

// ---------------------------------------------------------------------------
// WorkflowTailSource → cache
// ---------------------------------------------------------------------------

interface WorkflowStatusCacheShape {
  readonly status: WorkflowStatus;
  readonly updatedAt: number;
}

function patchWorkflowDetailStatus(
  queryClient: QueryClient,
  workflowId: string,
  status: WorkflowStatus,
  updatedAtMs: number,
): void {
  queryClient.setQueryData<WorkflowStatusCacheShape>(workflowDetailKey(workflowId), (old) =>
    old === undefined ? old : { ...old, status, updatedAt: updatedAtMs },
  );
}

function appendWorkflowEvent(
  queryClient: QueryClient,
  workflowId: string,
  event: WorkflowEvent,
): void {
  queryClient.setQueryData<WorkflowEvent[]>(workflowEventsKey(workflowId), (old) =>
    old === undefined ? [event] : [...old, event],
  );
}

/** Applies one `WorkflowTailSource` frame: appends to the events cache, and patches the detail cache's status when the event represents a lifecycle transition. */
export function applyWorkflowTailFrame(
  queryClient: QueryClient,
  workflowId: string,
  event: WorkflowEvent,
): void {
  appendWorkflowEvent(queryClient, workflowId, event);
  const status = workflowStatusForEventType(event.type);
  if (status !== null) patchWorkflowDetailStatus(queryClient, workflowId, status, event.timestamp);
}

const CHECKPOINT_EVENT_TYPE = 'workflow:checkpoint';

/**
 * Replaces the cached checkpoint entries with a fresh `getEvents()` result and keeps every other
 * cached entry (the lifecycle frames `WorkflowTailSource` appended) the result does not repeat, in
 * timestamp order.
 *
 * The per-workflow `/events/sse` route carries the watch events (`workflow:started`,
 * `activity:completed`, ...), not the durable log's `workflow:checkpoint` entries, so a checkpoint
 * committed after the first fetch reaches the cache only through a refetch.
 */
export function mergeWorkflowCheckpointEvents(
  queryClient: QueryClient,
  workflowId: string,
  fetched: readonly WorkflowEvent[],
): void {
  queryClient.setQueryData<WorkflowEvent[]>(workflowEventsKey(workflowId), (old) =>
    combineCheckpointEvents(old, fetched),
  );
}

function combineCheckpointEvents(
  cached: readonly WorkflowEvent[] | undefined,
  fetched: readonly WorkflowEvent[],
): WorkflowEvent[] {
  const fetchedKeys = new Set(fetched.map(eventKey));
  // Cached checkpoints are replaced by the fetch; every other cached entry stays unless the
  // fetch returned the same entry.
  const kept = (cached ?? []).filter(
    (event) => event.type !== CHECKPOINT_EVENT_TYPE && !fetchedKeys.has(eventKey(event)),
  );
  return [...fetched, ...kept].toSorted((left, right) => left.timestamp - right.timestamp);
}

function eventKey(event: WorkflowEvent): string {
  return `${event.type}\u0000${event.timestamp}\u0000${JSON.stringify(event.data)}`;
}

/**
 * The Events tab's query function: fetches the durable event log and returns it merged with what
 * the cache already holds. TanStack writes a query function's result over the whole cache entry,
 * so returning the raw `getEvents()` list (checkpoints only) on a window-focus or reconnect
 * refetch would drop the lifecycle frames the tail appended, and the tail's cursor has moved past
 * them. The initial fetch and every later one therefore take the same merge.
 */
export async function fetchWorkflowEventsMerged(
  queryClient: QueryClient,
  workflowId: string,
  fetchEvents: (workflowId: string) => Promise<readonly WorkflowEvent[]>,
): Promise<WorkflowEvent[]> {
  const fetched = await fetchEvents(workflowId);
  // Read the cache after the await: frames the tail appended while the fetch ran are kept.
  return combineCheckpointEvents(
    queryClient.getQueryData<WorkflowEvent[]>(workflowEventsKey(workflowId)),
    fetched,
  );
}

/**
 * Builds the refresh the Events tab calls after each tail frame: it refetches the durable event
 * log and merges its checkpoints into the cache. Calls made while a fetch is in flight coalesce
 * into one more fetch started after it, so the last call always sees a result at least as new as
 * itself. A failed fetch leaves the cache as it was; the next frame tries again.
 */
export function createWorkflowCheckpointRefresher(
  queryClient: QueryClient,
  workflowId: string,
  fetchEvents: (workflowId: string) => Promise<readonly WorkflowEvent[]>,
): () => Promise<void> {
  let running: Promise<void> | null = null;
  let again = false;

  async function drain(): Promise<void> {
    do {
      again = false;
      try {
        mergeWorkflowCheckpointEvents(queryClient, workflowId, await fetchEvents(workflowId));
      } catch {
        // Keep the last known rows; a later frame retries.
      }
    } while (again);
    running = null;
  }

  return () => {
    if (running !== null) {
      again = true;
      return running;
    }
    running = drain();
    return running;
  };
}

// ---------------------------------------------------------------------------
// FleetEventSource → cache
// ---------------------------------------------------------------------------

function runHistoryHolds(data: unknown, workflowId: string): boolean {
  if (typeof data !== 'object' || data === null) return false;
  const items: unknown = Reflect.get(data, 'items');
  return (
    Array.isArray(items) &&
    items.some(
      (item: unknown) =>
        typeof item === 'object' && item !== null && Reflect.get(item, 'id') === workflowId,
    )
  );
}

/**
 * Invalidates what a schedule's views derive from its runs, so none of them keeps showing the
 * outcome of an earlier fire next to the time of a later one. A fire moves the schedule itself
 * (its list rows and detail: last and next fire) and adds a run to its history, so all three are
 * refetched. A run settling changes only its own status, so only the run histories that list that
 * run are refetched: the fire that launched it already refreshed the history to hold it.
 */
export function applyScheduleFleetFrame(queryClient: QueryClient, frame: FleetEventFrame): void {
  if (SCHEDULE_FIRE_KINDS.has(frame.kind)) {
    void queryClient.invalidateQueries({ queryKey: SCHEDULES_LIST_KEY_PREFIX });
    void queryClient.invalidateQueries({ queryKey: SCHEDULES_DETAIL_KEY_PREFIX });
    void queryClient.invalidateQueries({ queryKey: SCHEDULES_RUN_HISTORY_KEY_PREFIX });
    return;
  }
  const settledId = frame.workflowId;
  if (settledId !== undefined && WORKFLOW_SETTLED_KINDS.has(frame.kind)) {
    void queryClient.invalidateQueries({
      queryKey: SCHEDULES_RUN_HISTORY_KEY_PREFIX,
      predicate: (query) => runHistoryHolds(query.state.data, settledId),
    });
  }
}

/**
 * Invalidates every entry the fleet feed drives, for a feed that may have missed events (a retention
 * gap, or a replay held back). The workflow lists and aggregates are left out on purpose: they
 * are read at the person's pace (Live is off by default, `workflow-list-live.svelte.ts`), and a
 * missed event is one more thing "Refresh" shows.
 */
export function invalidateFleetDrivenQueries(queryClient: QueryClient): void {
  for (const queryKey of [
    REVIEWS_LIST_KEY_PREFIX,
    SCHEDULES_LIST_KEY_PREFIX,
    SCHEDULES_DETAIL_KEY_PREFIX,
    SCHEDULES_RUN_HISTORY_KEY_PREFIX,
    WORKFLOWS_DETAIL_KEY_PREFIX,
    WORKFLOWS_FINALIZER_KEY_PREFIX,
    WORKFLOWS_UPDATES_KEY_PREFIX,
    ...WORKER_FLEET_KEYS,
    WORKERS_REJECTIONS_KEY,
    WORKERS_DEPLOYMENTS_KEY,
    TASKS_DETAIL_KEY_PREFIX,
    TASKS_DELIVERIES_KEY_PREFIX,
    REALMS_KEY,
    SYSTEM_LEASE_KEY,
    ...CATALOG_SOURCE_FLEET_KEYS,
  ]) {
    void queryClient.invalidateQueries({ queryKey });
  }
  invalidateEmptyViews(queryClient);
}

/**
 * Applies one `FleetEventSource` frame: invalidates the detail, finalizer, update-history, review,
 * worker, realm, lease, registry, dynamic-source and schedule queries it affects. The shell calls it for every frame, so none of it waits for a
 * page to be open on the workflow. The workflow list and aggregate are not invalidated here (see
 * {@link invalidateFleetDrivenQueries}). Never writes into the events append cache — see module doc.
 */
export function applyFleetEventFrame(queryClient: QueryClient, frame: FleetEventFrame): void {
  if (frame.kind === FLEET_GAP_KIND) {
    invalidateFleetDrivenQueries(queryClient);
    return;
  }
  applyScheduleFleetFrame(queryClient, frame);
  // Before the run-scoped branch below, which returns: a kind that maps to a list is read by kind.
  for (const queryKey of FLEET_KIND_INVALIDATION.get(frame.kind) ?? []) {
    void queryClient.invalidateQueries({ queryKey });
  }
  if (frame.kind === WORKFLOW_STARTED_KIND) invalidateEmptyViews(queryClient);
  if (isReviewFleetEventKind(frame.kind)) {
    void queryClient.invalidateQueries({ queryKey: REVIEWS_LIST_KEY_PREFIX });
  }
  if (frame.workflowId !== undefined) {
    void queryClient.invalidateQueries({ queryKey: workflowDetailKey(frame.workflowId) });
    // The durable finalizer field (`weft.workflows.finalizer.get`, weft#732
    // item 4, shipped 0.15.0) only ever changes alongside a lifecycle event
    // naming this workflow — a `workflow:teardown` frame chief among them —
    // so any such frame is a reasonable trigger to refetch it, independent
    // of whether this session's fleet connection actually replayed the
    // specific `workflow:teardown` frame (the durable field is
    // authoritative either way; this is just "refresh sooner").
    void queryClient.invalidateQueries({ queryKey: workflowFinalizerKey(frame.workflowId) });
    // A run that ends takes its open reviews with it without a `human-review:completed`, so the
    // list that held them is asked again.
    if (WORKFLOW_SETTLED_KINDS.has(frame.kind)) {
      void queryClient.invalidateQueries({ queryKey: REVIEWS_LIST_KEY_PREFIX });
    }
    if (WORKFLOW_UPDATE_KINDS.has(frame.kind)) {
      void queryClient.invalidateQueries({ queryKey: workflowUpdatesKey(frame.workflowId) });
    }
  }
}
