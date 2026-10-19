/**
 * `QueryClient` factory + query-key helpers (plan §4, T1.5). Frozen after the
 * Phase 1 Foundation gate — see PROJECT-BRIEF "Shared contracts".
 *
 * TanStack Query owns all server state (plan §1.5); this module is the one
 * place that decides its defaults so every domain track builds
 * `createQuery`/`createMutation` calls against the same retry/placeholder/
 * error-reporting behavior instead of re-deciding it per call site.
 *
 * ## Where a fault surfaces (three paths, not one)
 *
 * This client intentionally never sets `throwOnError` on queries — a query
 * failure is meant to degrade the surface to its last-known cached state
 * (plan §5), not unmount it — so `<FaultBoundary>` (`src/app/fault-boundary.svelte`)
 * does NOT see query errors; it only catches exceptions thrown while
 * rendering (a rendering bug, not a wire fault). Route components read
 * `$query.error` directly and pass it through `classifyFault`/`faultTreatment`
 * (`./faults.ts`) to render the same six-treatment `FaultDisplay` banner
 * inline. Mutation failures are the one path this module owns end-to-end:
 * the `mutations.onError` default below reports them as a toast via
 * `showFault`. Three distinct delivery mechanisms for the same
 * classification — not competing ones.
 */
import type { ReviewListFilter, ScheduleFilter } from '@lostgradient/weft';

import { keepPreviousData, QueryClient, type QueryKey } from '@tanstack/svelte-query';

import { showFault } from '../app/toast-host.svelte';
import { classifyFault, faultTreatment } from './faults.ts';
import type { WorkflowListQuery } from './filters.ts';

/** `group_by` grammar for `weft.workflows.aggregate` (plan §4, Appendix A) — not a public `@lostgradient/weft` export, so named here. */
export type WorkflowAggregateGroupBy =
  'status' | 'type' | 'failureCategory' | `attribute:${string}`;

/**
 * Query-key builders for every domain (plan §4, list verbatim). Each key is
 * a `readonly` tuple so it hashes stably for TanStack Query's cache and stays
 * assignable wherever a plain `QueryKey` is expected.
 */
export const queryKeys = {
  contexts: {
    /** One chat session, as `bureau.contexts.get` shows it. */
    detail: (contextId: string) => ['contexts', 'detail', contextId] as const,
    /** The caller's sessions, all of them or one agent's. */
    list: (agentName: string | null) => ['contexts', 'list', agentName] as const,
  },
  agents: {
    list: () => ['agents', 'list'] as const,
    /** Every agent definition, invalid files included (`bureau.agents.definitions.list`). */
    definitions: () => ['agents', 'definitions'] as const,
    /** One agent as `bureau.agents.definitions.get` shows it. */
    definition: (id: string) => ['agents', 'definition', id] as const,
    /** The versions of one agent that have run (`bureau.agents.definitions.revisions`). */
    revisions: (id: string) => ['agents', 'revisions', id] as const,
    /** The models and tools an agent may name (`bureau.agents.catalog`). */
    catalog: () => ['agents', 'catalog'] as const,
  },
  /** The Workflows area: the engine's definitions joined with the Bureau's files (`lib/workflow-catalog.ts`). */
  workflowCatalog: {
    list: () => ['workflow-catalog', 'list'] as const,
    /** One type, and what each service says of it. */
    detail: (type: string) => ['workflow-catalog', 'detail', type] as const,
    /** One workflow file as `bureau.workflows.get` shows it, for the editor. */
    file: (type: string) => ['workflow-catalog', 'file', type] as const,
    /** The schedules that start one type (`weft.schedules.list` with `workflowType`). */
    schedules: (type: string) => ['workflow-catalog', 'schedules', type] as const,
    /** The versions of one agent-authored workflow that have run (`bureau.workflows.revisions`). */
    revisions: (type: string) => ['workflow-catalog', 'revisions', type] as const,
  },
  workflows: {
    list: (filter: WorkflowListQuery) => ['workflows', 'list', filter] as const,
    detail: (id: string) => ['workflows', 'detail', id] as const,
    events: (id: string, cursor?: string) => ['workflows', 'events', id, cursor] as const,
    aggregate: (groupBy: WorkflowAggregateGroupBy, filter: WorkflowListQuery) =>
      ['workflows', 'aggregate', groupBy, filter] as const,
  },
  schedules: {
    list: (filter: ScheduleFilter) => ['schedules', 'list', filter] as const,
  },
  workers: {
    list: () => ['workers', 'list'] as const,
    manifests: (workerIds: readonly string[]) => ['workers', 'manifests', workerIds] as const,
    manifest: (workerId: string) => ['workers', 'manifest', workerId] as const,
    rejections: () => ['workers', 'rejections'] as const,
    /** Deployment versions and routing pointers (COR-277). */
    deployments: () => ['workers', 'deployments'] as const,
  },
  queues: {
    list: () => ['queues', 'list'] as const,
  },
  diagnostics: () => ['diagnostics'] as const,
  conformance: {
    /** `weft.conformance.targets` (COR-160): the worker commands the server can run. */
    targets: () => ['conformance', 'targets'] as const,
  },
  /** Diagnostics narrowed by provenance filters; extends `diagnostics()` so one prefix invalidates both. */
  diagnosticsFiltered: (filters: Readonly<Record<string, string | undefined>>) =>
    ['diagnostics', 'filtered', filters] as const,
  tasks: {
    detail: (operationId: string) => ['tasks', 'detail', operationId] as const,
    /** `weft.tasks.deliveries` (COR-284): the server's answers to one task's result submissions. */
    deliveries: (operationId: string) => ['tasks', 'deliveries', operationId] as const,
    /** `weft.tasks.deadletters.get` (COR-284): a dead-lettered attempt's retained result. */
    deadLetter: (operationId: string) => ['tasks', 'dead-letter', operationId] as const,
  },
  reviews: {
    list: (filter: ReviewListFilter) => ['reviews', 'list', filter] as const,
  },
  /** The Bureau's tasks (`bureau.tasks.*`), apart from `tasks`, which is the engine's task ledger. */
  bureauTasks: {
    /** One list: a filter and no page, because the page is the infinite query's own. */
    list: (filter: { agentName?: string; status?: string; contextId?: string }) =>
      ['bureau-tasks', 'list', filter] as const,
    detail: (taskId: string) => ['bureau-tasks', 'detail', taskId] as const,
    /** The tasks of one chat session, read whole. It is apart from `list`, which pages. */
    ofSession: (contextId: string) => ['bureau-tasks', 'session', contextId] as const,
  },
  /** The Bureau's reviews (`bureau.reviews.*`), apart from `reviews`, which is the engine's. */
  bureauReviews: {
    list: () => ['bureau-reviews', 'list'] as const,
    detail: (reviewId: string) => ['bureau-reviews', 'detail', reviewId] as const,
  },
  /** Raw `weft.system.registry` response (and projections of it) for consumers that read it unvalidated. */
  registry: () => ['registry'] as const,
  /**
   * The `parseRegistrySnapshot`-validated snapshot behind contract verification
   * (Worker detail, System → Registry). Its own entry, so a raw response cached
   * under `registry()` never reaches the verification panels unvalidated
   * (COR-162). It sits under the `registry` prefix, so invalidating
   * `registry()` refreshes it too.
   */
  registrySnapshot: () => ['registry', 'snapshot'] as const,
  /** `weft.realms.diagnostics` (COR-243) — host-wide, no query params. */
  realms: () => ['realms'] as const,
  retention: () => ['retention'] as const,
  metrics: () => ['metrics'] as const,
  principal: () => ['principal'] as const,
  /** Where the host keeps what a person may edit by hand (`/host/paths`). */
  hostPaths: () => ['host', 'paths'] as const,
  /** The probe behind a view's loading, empty, error, and forbidden states (`app/view-frame.svelte`). */
  view: (view: string, instance: string | null) => ['view', view, instance] as const,
  /** `weft.system.lease` (COR-124), read only by the System route's Health & lease tab. */
  systemLease: () => ['system', 'lease'] as const,
  /** The five `weft.workflows.revisions.*`/`weft.workflows.active.get` catalog operations (WFT-11/WFT-115) — per-workflow-name keys, additive (WFT-115). */
  catalog: {
    revisions: (name: string) => ['catalog', 'revisions', name] as const,
    /** `weft.workflows.revisions.get` (COR-1464) — extends `revisions(name)`, so invalidating the list invalidates every open detail too. */
    revision: (name: string, revision: string) => ['catalog', 'revisions', name, revision] as const,
    active: (name: string) => ['catalog', 'active', name] as const,
    /** `weft.workflows.refresh.diagnostics` (COR-166) — one workflow's refresh source. */
    refresh: (name: string) => ['catalog', 'refresh', name] as const,
    sources: (pagination: { readonly limit: number; readonly offset: number }) =>
      ['catalog', 'sources', pagination] as const,
    /**
     * `weft.catalog.diagnostics` (WFT-116) — per-`(name, revision)`, since
     * that operation answers for one exact key. The `name` segment sits
     * before `revision` so a mutation touching one workflow can invalidate
     * every revision's diagnostics at once with the
     * `['catalog', 'diagnostics', name]` prefix.
     */
    diagnostics: (name: string, revision: string) =>
      ['catalog', 'diagnostics', name, revision] as const,
  },
} as const;

/**
 * The instance a view frame keys its probe under for one workflow type's route, so the page that
 * finds the type gone can ask the frame to look again (`queryKeys.view('workflows', instance)`).
 */
export function workflowViewInstance(pattern: string, type: string): string {
  return `${pattern}:${type}`;
}

/**
 * Query-key prefixes that identify a paginated/filtered list (plan §4:
 * "keepPreviousData placeholder for lists"). `workers.list`/`queues.list`
 * take no filter argument (Appendix A has no query params for either
 * endpoint) so there is nothing for `keepPreviousData` to smooth over — a
 * refetch of an unparameterized key isn't a "switched page/filter" the user
 * is waiting through. `diagnostics`/`registry`/`retention`/`metrics`/
 * `principal` are single-resource fetches, not lists, for the same reason.
 */
const LIST_QUERY_KEY_PREFIXES: readonly QueryKey[] = [
  ['workflows', 'list'],
  ['schedules', 'list'],
  ['reviews', 'list'],
  ['catalog', 'sources'],
];

const MAX_QUERY_RETRIES = 3;

/**
 * Retry predicate shared by every query (plan §4: "retry policy that never
 * retries 4xx faults"). `classifyFault` returning `null` means the error
 * never crossed the Weft fault wire — a network blip, a dropped connection —
 * which is transient and worth retrying. Of the six wire treatments, only
 * `internal` is: the other five describe the CURRENT state of the resource
 * or request (missing, conflicting, invalid, unauthorized, unsupported) and
 * retrying with the same input reproduces the identical fault. `Timeout`
 * (`FaultCode`) is bucketed under `internal` in `faults.ts` specifically so
 * it retries here — see that module's comment.
 */
function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_QUERY_RETRIES) return false;

  const treatment = classifyFault(error);
  return treatment === null || treatment.kind === 'internal';
}

/**
 * Builds the app's single `QueryClient` (plan §4). Defaults:
 *   - queries never retry a classified 4xx-shaped fault (`shouldRetryQuery`).
 *   - list queries (`LIST_QUERY_KEY_PREFIXES`) keep the previous page's data
 *     visible while refetching, instead of flashing to a loading state.
 *   - any mutation error is reported as a toast via the fault mapping
 *     (`showFault`) — call sites needing a different/additional treatment
 *     pass their own `onError` to `createMutation`, which runs alongside
 *     this default (TanStack Query calls both).
 *   - `notifyOnChangeProps: 'all'` disables TanStack Query's default
 *     "tracked properties" optimization, which only notifies subscribers
 *     when a result property that was actually READ on the previous render
 *     changes. Several route components derive booleans like `isLoading`
 *     from short-circuited expressions (`scopeGranted && query.isPending`)
 *     — once the left side goes false, the right side stops being read, so
 *     the tracked-properties set silently drops `isPending` and a later
 *     settle never notifies the component (confirmed empirically: the
 *     dashboard's critical-alerts band hangs on its loading skeleton
 *     forever after a query resolves, and stops hanging the moment
 *     anything else in the component unconditionally reads the same
 *     property). `'all'` trades a small amount of over-notification for
 *     correctness independent of which properties a given render happens
 *     to touch.
 */
export function createQueryClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: shouldRetryQuery,
        notifyOnChangeProps: 'all',
      },
      mutations: {
        onError: (error) => {
          showFault(faultTreatment(error));
        },
      },
    },
  });

  for (const prefix of LIST_QUERY_KEY_PREFIXES) {
    client.setQueryDefaults(prefix, { placeholderData: keepPreviousData });
  }

  return client;
}
