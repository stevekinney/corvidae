import type { WorkspaceMembershipOptions } from '../http/workspace-principal.ts';
import type { BureauWorkflows } from '../workflow-runtime';
import type { BureauWorkerDeployments } from '../worker-deployments';
import type {
  EventIteratorOptions,
  EventObservableOptions,
  ObservableLike,
  Observer,
  RuntimeServices,
  Subscription,
} from '@lostgradient/lifecycle';
import type { GovernedMemory } from '@lostgradient/memory';
import type {
  AgentRunEventRegistry,
  PeerCallJournal,
  SessionStore,
  Store,
} from '@lostgradient/operative';
import type { TaskRegistry } from '../task-registry';
import type { InteractiveSurfaces } from '../interactive-surface/store';
import type { BureauAttention } from '../attention-feed';
import type { ConditionalTextValueStore } from '@lostgradient/storage';
import type { RegistryAgnosticEngine } from '@lostgradient/weft';
import type { ToolRequestContext } from 'armorer';
import type { AgentDefinitions, AgentNames } from '../agent-catalog';
import type { AssetService } from '../assets/types';
import type { AuditTrail } from '../audit-trail';
import type { BureauEventFeed } from '../bureau-event-feed.ts';
import type { BureauChildren } from '../child-topology';
import type { BureauEventMap } from '../events';
import type { BureauGoals } from '../goal-types';
import type { BureauDecisions } from '../decisions/types';
import type { BureauSettings } from '../settings/types';
import type { Models } from '../models/create-models';
import type { BureauNotifications } from '../notifications/notification-types';
import type { ScorerSampler } from '../scorers';
import type { WebhookNotifier } from '../webhook-notifier';
import type { BureauHooks } from '../hooks/create-hooks';
import type { BureauEventFormatter } from '../bureau-event-formatting';
import type { BureauPlugins } from '../plugins/plugin-types';
import type { BureauAudit } from './audit';
import type { BureauContexts } from './contexts';
import type { ServerFrame } from './frames';
import type { ExpiredRecordRemoval, RetentionWindowOption } from './options';
import type { BureauReviews } from './reviews';
import type { BureauSchedules } from './schedules';
import type { BureauAgents, BureauTasks } from './tasks';

/**
 * Armorer's cleanup-outcome vocabulary
 * (`packages/armorer/src/execution-lifecycle.ts`'s `ExecutionCleanupOutcome`
 * `status`), reused verbatim per AB-34's vocabulary constraint — the same
 * reuse the other started-work
 * handles make.
 *
 * - `'completed'` — the owner's drain settled normally.
 * - `'failed'` — the owner's drain settled by rejecting; the failure is
 *   diagnosed and teardown continues past it.
 * - `'unresolved'` — a `shutdown({ timeoutMilliseconds })` wait elapsed
 *   before this owner's drain settled. The drain itself is not abandoned —
 *   only `shutdown()`'s wait for it is.
 * - `'not-required'` — this owner had nothing to release.
 */
export type CleanupAcknowledgement = 'not-required' | 'completed' | 'failed' | 'unresolved';
/**
 * Options for {@link Bureau.shutdown}. `policy` defaults to `'abort'` when
 * omitted (including when `options` itself is omitted) — matching
 * `dispose()`'s existing behavior.
 *
 * - `'abort'` aborts caller-owned and catalog runs, including durable runs this process started.
 *   A durable run this process recovered at boot is left recoverable, as under `'detach'`.
 * - `'drain'` waits for caller-owned and catalog runs to finish naturally.
 * - `'detach'` leaves durable caller-owned runs recoverable, aborts process-local and catalog
 *   runs, and waits for errored runs as `'drain'` does. Toolbox cleanup remains abortive.
 */
export interface BureauShutdownOptions {
  readonly policy?: 'abort' | 'drain' | 'detach';
  /**
   * Bounds `shutdown()`'s WAIT only — see {@link Bureau.shutdown}. Omit to
   * wait indefinitely.
   *
   * The wait itself sleeps on this bureau's own resolved
   * `RuntimeServices.timers` (AB-260's deterministic contract) — never a
   * real timer, even under a real-globals bureau. Under a
   * `ManualRuntimeServices`, that means nothing advances this wait on its
   * own: the CALLER owns advancing the clock
   * (`runtime.advance(timeoutMilliseconds)`) far enough for it to elapse,
   * exactly as for any other timer-driven behavior. `bureau/test`'s
   * `BureauTestHarness.close(shutdownOptions)` is the one exception — it
   * owns that advance itself once `shutdown()` has armed the timer, so a
   * test built on the harness never needs to (Coordinator ruling on
   * AB-338).
   */
  readonly timeoutMilliseconds?: number;
}
/** One row of {@link BureauShutdownReport.owners} — one Bureau-composed subsystem's drain outcome. */
export interface BureauShutdownOwnerReport {
  /**
   * Which Bureau-composed subsystem this row reports on. A row is emitted
   * only for a subsystem this bureau actually composes — `'heartbeat'` is
   * reserved for the day Bureau composes one; no row carries it today.
   */
  readonly kind:
    | 'online-evals'
    | 'webhook-notifier'
    | 'audit-trail'
    | 'event-history'
    | 'durable-engine'
    | 'assets'
    | 'heartbeat';
  readonly id?: string;
  readonly outcome: CleanupAcknowledgement;
}
/**
 * Returned by {@link Bureau.shutdown}, modeled on armorer's
 * `ExecutionCleanupReport` shape (`packages/armorer/src/execution-lifecycle.ts`)
 * rather than a new report vocabulary.
 */
export interface BureauShutdownReport {
  readonly admissionClosed: true;
  readonly policy: 'abort' | 'drain' | 'detach';
  /**
   * Number of durable caller-owned runs left running for a later process to recover: every one
   * under `'detach'`, and under `'abort'` the ones this process recovered rather than started.
   */
  readonly detached: number;
  readonly requested: number;
  readonly completed: number;
  readonly failed: number;
  readonly unresolved: number;
  readonly notRequired: number;
  readonly owners: readonly BureauShutdownOwnerReport[];
}
/**
 * Returned by {@link Bureau.recovery}, modeled on
 * {@link BureauShutdownReport}'s shape rather than a new report vocabulary
 * (AB-242's decision record). Aggregates one boot recovery pass's outcome so
 * a caller who wants to know whether recovery actually succeeded has a
 * typed, awaitable answer instead of only a `scope: 'recovery'` diagnostic
 * log line — recovery itself stays diagnostic-only: `createBureau()` never
 * rejects on a `recoverDurableRuns()` failure, in whole or in part.
 */
export interface BureauRecoveryReport {
  /**
   * `'failed'` when {@link BureauRecoveryReport.batchFailure} is set (no
   * handle was classified at all); otherwise `'partial'` when
   * {@link BureauRecoveryReport.sweepFailure} is set,
   * {@link BureauRecoveryReport.perRunFailures} is non-empty, or
   * {@link BureauRecoveryReport.skippedRuns} is non-empty; otherwise
   * `'clean'`. The `'skip'`, `'reattach'`, `'monitor'`, and
   * `'reattach-version-mismatch'` per-run verdicts never change `outcome`.
   */
  readonly outcome: 'clean' | 'partial' | 'failed';
  /** Set when the unconditional scheduler-residue sweep failed before `recoverAll()` ran. */
  readonly sweepFailure?: { readonly message: string };
  /** Set when `durable.engine.recoverAll()` itself threw, so no handle was classified at all. */
  readonly batchFailure?: { readonly message: string };
  /**
   * One entry per handle whose verdict was `'cancel'` (`RecoveryRejectedEvent`),
   * for a caller that wants the aggregate without re-deriving it from the
   * event stream. Empty when every handle recovered, was skipped, or was
   * monitor-only.
   */
  readonly perRunFailures: readonly { readonly runId: string; readonly reason: string }[];
  /**
   * COR-1583 — one entry per stored run that was left untouched because its workflow type is not
   * registered with this Bureau (a Bureau started without `workflowSource`, or a workflow whose
   * file and stored revisions are both gone). A skipped run keeps its state and has no claim taken
   * on it, so a later boot that has registered its type recovers it; no other run is held back by
   * it. Empty when every stored run's type was registered. Each entry is also diagnosed once, as a
   * `scope: 'recovery'` `warn`.
   */
  readonly skippedRuns: readonly { readonly runId: string; readonly type: string }[];
}
/**
 * One definition source's watcher, as {@link BureauDiagnostics.watchers} reports it (COR-1731).
 * Times and the error message only: never a definition's bytes or an error's stack.
 */
export interface BureauWatcherHealth {
  /** Which definition source this watcher reads: the agent directory or the workflow directory. */
  readonly source: 'agents' | 'workflows';
  /**
   * When the watcher's last scan finished, in epoch milliseconds on the Bureau's runtime clock,
   * whether that scan succeeded or failed. `null` before the first scan finishes.
   */
  readonly lastScanAt: number | null;
  /**
   * The message of the error the last scan failed with, which the next successful scan clears.
   * `null` when the last scan succeeded and before any scan finished.
   */
  readonly lastScanError: string | null;
}
/**
 * A point-in-time reading of what a Bureau is holding, from {@link BureauInternals.diagnostics}
 * and the `bureau.diagnostics.get` operation (COR-1731). Counts, statuses, and timestamps only:
 * it names no run, review, agent, message, credential, or stack, so it is safe to serve to a
 * caller that holds the `bureau.diagnostics:read` scope.
 */
export interface BureauDiagnostics {
  /** How the boot recovery pass ended. */
  readonly recovery: {
    /**
     * `'pending'` while a deferred recovery (one waiting on
     * {@link Bureau.setRequestAuthorityValidator}) has not finished; otherwise the
     * {@link BureauRecoveryReport.outcome} of the pass.
     */
    readonly status: 'pending' | BureauRecoveryReport['outcome'];
    /** How many handles the pass cancelled: {@link BureauRecoveryReport.perRunFailures}'s length. */
    readonly failedRunCount: number;
  };
  /** {@link Bureau.lifecycle}, as of this reading. */
  readonly lifecycle: Bureau['lifecycle'];
  /** How many {@link Bureau.frames} listeners are subscribed, one still being replayed boot frames included. */
  readonly liveFrameSubscriberCount: number;
  /** How many live subscriptions {@link BureauInternals.eventFeed} holds, `bureau.events` clients among them. */
  readonly eventFeedSubscriberCount: number;
  /** One entry per configured definition source (`agentSource`, `workflowSource`), in that order. */
  readonly watchers: readonly BureauWatcherHealth[];
  /** The model catalog's `revision`: `1` at boot, plus one for each `bureau.models.replace`. */
  readonly modelCatalogRevision: number;
  /** How many bureau-owned runs and `bureau.run()` catalog runs this process is executing; durable goal attempts and workflow steps are not counted. */
  readonly runningRunCount: number;
  /** How many runs have a requested cancellation that has not settled ({@link BureauInternals.abortingTasks}). */
  readonly abortingRunCount: number;
  /** How many reviews await a human decision, as {@link BureauReviews.list} would return them. */
  readonly pendingReviewCount: number;
}
/**
 * The seam between a Bureau and the code that serves or tests it: `createBureauHandler` reads
 * these members to serve the operations, and the test harness reads them to inspect what the
 * Bureau holds. An application builds on the other members of {@link Bureau}; none of these
 * is part of its surface, and the project may reshape them without a deprecation period.
 */
export interface BureauInternals {
  /**
   * Whether {@link BureauOptions.id} was supplied. `false` means {@link Bureau.id}
   * is a generated identifier that changes on every restart, which
   * `createBureauHandler` refuses to serve over persistent storage because it
   * would orphan whatever that storage holds.
   */
  readonly hasExplicitId: boolean;

  /**
   * How long a settled task stays addressable: {@link BureauRetentionOptions.tasks}, or its
   * 30-day default when none was given.
   */
  readonly taskRetention: RetentionWindowOption;

  /**
   * Whether this bureau has storage and a durable engine. Only such a bureau
   * keeps run-creation receipts and human-wait parks across a restart, so an
   * adapter that promises either (the AG-UI mount of `createBureauHandler`)
   * refuses a bureau without one.
   */
  readonly hasDurableEngine: boolean;

  /**
   * This bureau's own events, as a replay-plus-live feed.
   *
   * The same events `addEventListener`/`subscribe` deliver, but recorded with
   * cursors, so a client that reconnects resumes where it stopped instead of
   * missing whatever happened while it was away. Serve it as `bureau.events`
   * by registering this bureau's id against it — see
   * `createBureauEventRegistry`.
   *
   * Shutdown ends every subscriber rather than leaving it hanging, but does
   * not promise a final `bureau.disposed` envelope — see Weft's
   * `bindFeedLifetime` for why. A client treats the stream ending as the
   * signal.
   *
   * Named `eventFeed` because `events` is already this interface's
   * async-iterator method.
   */
  readonly eventFeed: BureauEventFeed;

  /**
   * The event feeds of the runs this bureau owns, keyed by run id.
   *
   * A bureau owns its operatives' events as well as their lifecycles: it
   * creates each run's feed before registering the run, pumps the run into
   * it, and reaps it when the run is removed. Pass this as the
   * `operative.runs.events` engine's `runFeeds` and a client can watch any
   * run this bureau started.
   *
   * A feed outlives its run's completion and is reaped when the run's task
   * expires under {@link BureauRetentionOptions.tasks}, so a client that
   * subscribes on hearing `run.completed` still gets the whole history. A
   * host that keeps `retention.tasks` at `'forever'` retains them.
   *
   * Read-only: entries are bureau's to create and remove.
   */
  readonly runEventFeeds: AgentRunEventRegistry;

  readonly store: Store;

  readonly sessionStore: SessionStore | undefined;

  /** COR-2381 — how many taints scheduled fires hold for sessions they have not yet created. */
  pendingScheduledTaintCount(): number;

  readonly kv: ConditionalTextValueStore | undefined;

  /**
   * The durable audit trail (Layer B glass-box).
   *
   * Present when the bureau has a KV store configured (`storage`). `undefined`
   * when the bureau is ephemeral (no `storage`).
   *
   * The audit trail sinks `tool.*`, `run.*`, and `step.completed` events into
   * the KV store as an append-only log. Use `auditTrail.query()` to read them
   * back with optional `since`, `runId`, and `type` filters.
   *
   * Layer A (live) = `store.getState()` + `memory.list()` + `getSession()`.
   * Layer B (durable) = `auditTrail.query()`.
   */
  readonly auditTrail: AuditTrail | undefined;

  /**
   * The webhook notifier (AB-21). Present whenever `options.webhooks.targets`
   * is non-empty; `undefined` when no webhooks are configured (the default).
   * Use `webhookNotifier.listDeliveries()` to inspect durable delivery state.
   */
  readonly webhookNotifier: WebhookNotifier | undefined;

  /**
   * The online eval sampler (AB-53). Present whenever `options.scorers`
   * configures at least one judge with a positive `sampleRate`; `undefined`
   * when online evals are disabled (the default). Use
   * `scorerSampler.sampledCount()`/`observedCount()` to inspect sampling
   * state and `scorerSampler.flush()` to await in-flight judge
   * evaluations deterministically.
   */
  readonly scorerSampler: ScorerSampler | undefined;

  /**
   * AB-369: every run whose cancellation `tasks.cancel` or a task handle's `abort` has requested
   * but whose `activeRun.closed()` has not yet settled, read from the abort bookkeeping rather
   * than inferred. `since` is the {@link RuntimeServices.clock} timestamp of the first request
   * for that run.
   * A run still listed here long after its abort should have settled is a
   * genuine leak — {@link BureauQuiescenceReport} (`bureau/test`) surfaces
   * it as a non-quiescent row.
   */
  abortingTasks(): readonly AbortingRun[];

  /**
   * COR-1490 — resolves once the session has recorded the end of the run `runId`, however long
   * its save takes (it waits on the save itself, never on a count of turns), and at once for a run
   * whose end is already recorded or that this process does not hold (so a reader in another
   * process can read a session that does not yet hold the run's final rows).
   *
   * Rejects when the run ended without this process saving its end: the engine lost a checkpoint
   * compare-and-swap or was disposed and abandoned the run to whoever owns it, or the Bureau shut
   * down first. The rejection comes when the run's own result settles, never at a deadline. A save
   * that starts and keeps failing does not reject: it is diagnosed after its last attempt and this
   * resolves, so a reader should check that the session holds what it needs. A reader that needs
   * the thread as the run left it, such as the AG-UI mount's end-of-run snapshot, waits here before
   * it reads the session.
   */
  whenTaskRecorded(runId: string): Promise<void>;

  /**
   * COR-1481 — the task registry behind `bureau.tasks.*`: the durable record of
   * each top-level run (its owner, context, originating message, and how it ended),
   * and the reads and cancellation the management plane serves over it. See
   * `task-registry.ts`.
   */
  readonly taskRegistry: TaskRegistry;

  /**
   * COR-1731 — what this Bureau is holding right now: the recovery outcome, the lifecycle, the
   * live-frame and event-feed subscriber counts, each definition watcher's last scan, the model
   * catalog revision, and the running, aborting, and pending-review counts. Synchronous: it reads
   * what the Bureau already records and awaits nothing, so a watcher's health is what its scans
   * recorded as they happened. Counts, statuses, and timestamps only (see
   * {@link BureauDiagnostics}); `bureau.diagnostics.get` serves the same reading.
   */
  diagnostics(): BureauDiagnostics;
}
export interface Bureau<D extends AgentDefinitions = AgentDefinitions> {
  /** Immutable construction binding shared with the transport handler; directory results stay live. */
  readonly workspaceBinding: Readonly<WorkspaceMembershipOptions> | undefined;
  /** This bureau's identity — {@link BureauOptions.id}, or a generated one. */
  readonly id: string;

  /**
   * COR-1879 — the plugins {@link BureauOptions.plugins} named, in load order: `list()` reports
   * each one's descriptor, status, problems and contributions, with what names each contribution
   * counted afresh, `registered()` names the plugins whose contributions are registered, and
   * `ready()` settles once every running plugin's `start` has. Empty without plugins.
   */
  readonly plugins: BureauPlugins;
  /**
   * The reviews awaiting a human decision, and the decision (`list`, `get`, `resolve`,
   * `pendingOf`). See {@link BureauReviews}.
   */
  readonly reviews: BureauReviews;
  /**
   * The durable schedules: `create`, `get`, `list`, `pause`, `resume`, `cancel`, `update`, the
   * `agentName` and `inputPreview` of an agent schedule, and the schedule definition's event
   * history (`events`, `subscribeEvents`). See {@link BureauSchedules}.
   */
  readonly schedules: BureauSchedules;
  /**
   * The contexts (sessions): `list`, `get`, `delete`, `signal`, `input`, `retract`, `forgetGrants`, `inputsDeliveredBy`,
   * `steer`, `steering`, `fork`, and the context's event history (`events`, `subscribeEvents`).
   * See {@link BureauContexts}.
   */
  readonly contexts: BureauContexts;
  /**
   * The tasks: `start` one, and `detail`, `get`, `list`, `cancel`, `receipt`, `workflow`,
   * `workflows`, `wait`, `snapshot`, `events`, `subscribeEvents`, and `inspect`. See
   * {@link BureauTasks}.
   */
  readonly tasks: BureauTasks<D>;
  /**
   * The audit trail read as redacted metadata: `query(filter, options?)`. See {@link BureauAudit}.
   */
  readonly audit: BureauAudit;
  /**
   * COR-1941 — the owner's notifications: what Bureau tells them needs their attention (a failed
   * run, a review waiting, a budget exceeded) and whatever else the host writes through
   * `notifications.create`. Persisted and owner-scoped. See {@link BureauNotifications}.
   */
  readonly notifications: BureauNotifications;
  /**
   * The seam the handler and the test harness read: stores, event feeds, and the task registry.
   * It is not part of the surface an application builds on. See {@link BureauInternals}.
   */
  readonly internals: BureauInternals;
  /**
   * The runtime this bureau runs on: {@link BureauOptions.runtime}, or the process's own services
   * when none was given. An adapter that compares a deadline or schedules a timer for the
   * bureau (the A2A mount of `createBureauHandler`) reads it here, so a custom runtime governs
   * the adapter too and not only the bureau.
   */
  readonly runtimeServices: RuntimeServices;
  readonly memory: GovernedMemory | undefined;
  /**
   * The model namespace: the catalog the deployment offers (`catalog()`, `replace(rows)`), the
   * `generate` for a row, and `plan(request)`, which builds the `SelectionPlan` a request would be
   * given against the current catalog and {@link BureauOptions.modelPolicy} without starting a
   * run. Present regardless of `D`, matching the rule that Bureau's administrative surface does
   * not depend on the registered agent set.
   */
  readonly models: Models;
  /**
   * COR-1709 — ask a model a typed question: `decide(request, options?)`. See
   * {@link BureauDecisions}.
   */
  readonly decisions: BureauDecisions;
  /**
   * COR-1710 — the deployment's runtime settings: `get`, `schema`, `update`, and `subscribe` over
   * the revisioned `settings` record. See {@link BureauSettings}.
   */
  readonly settings: BureauSettings;

  /**
   * The typed agent catalog (AB-15, AB-22) — the immutable, read-only view
   * over `BureauOptions.agents`. `bureau.agents.has(name)` narrows a literal
   * string to a known agent name where TypeScript permits it. `bureau.agents.try` (COR-1911)
   * starts a throwaway context with an agent definition that is not saved.
   */
  readonly agents: BureauAgents<D>;
  /**
   * COR-1527 — the workflow files in {@link BureauOptions.workflowSource}, or `undefined` when
   * the Bureau has none. Every workflow belongs to the deployment's owner of record.
   */
  readonly workflows: BureauWorkflows | undefined;
  /**
   * COR-1813 — the worker rollouts: `get` a deployment's routing pointer, and `ramp`, `promote`,
   * and `rollBack` its builds. `undefined` when the Bureau has no {@link
   * BureauOptions.workerDeployments}. See {@link BureauWorkerDeployments}.
   */
  readonly deployments: BureauWorkerDeployments | undefined;
  /**
   * COR-1939 — user-defined hooks over the Bureau's published events: `create`, `update`, `delete`,
   * `get`, `list`, `test` and `deliveries`. `undefined` when the Bureau has no {@link
   * BureauOptions.hooks}. A hook belongs to the principal that created it; the in-process calls
   * leave authorization to the caller, as `Bureau.goals` does. See {@link BureauHooks}.
   */
  readonly hooks: BureauHooks | undefined;
  /**
   * COR-2009 — what needs attention now: firing alerts, schedules that missed runs, hooks whose last
   * delivery failed or gave up, plugins that did not load, and what {@link BureauOptions.attention}
   * adds, as one list, most recent first, with the same items counted by area as its checks.
   * Reviews waiting on a person are never on it. See {@link BureauAttention}.
   */
  attention(): Promise<BureauAttention>;
  /**
   * COR-1876 — an event as a person reads it: a contributed formatter's sentence for its kind, or
   * the raw kind and the run link for an event no formatter claims. Pure; it never throws for a
   * formatter that does.
   */
  readonly formatEvent: BureauEventFormatter;

  /**
   * COR-772 — Bureau's durable parent-child topology: dispatch a catalog
   * agent as the child of a run this bureau knows (a task, or another child),
   * then list, get, wait on,
   * signal, and cancel it by its stable identifier — including after a
   * process restart. Every operation names the owning parent; naming an
   * unrelated parent reads as `not-found`. A child never shares its
   * parent's abort signal: cancelling a parent through `tasks.cancel`,
   * its own `TaskHandle`, or `children.cancel`
   * applies each child's recorded `parentCancellation` policy instead. See
   * `child-topology.ts`.
   */
  readonly children: BureauChildren<AgentNames<D>>;

  /**
   * COR-1670 — the journal that makes a peer call survive a restart: hand it to
   * `createPeerCallTool({ durable })`. A durable run's tool call records the A2A task it started
   * here, keyed by the run and the call's operation key, and the replay of that call after a
   * restart follows the recorded task instead of sending again. Each record carries a digest of
   * its request, so a replay that makes a different request at the same position is refused.
   * Records are deleted when the run's task is removed (`run.removed` of a non-catalog run, or
   * retention expiring its task). A run that has no task record, such as a child, a goal attempt
   * or a workflow step, keeps its records, and so does a run deleted while its call was in flight:
   * a record written after the deletion is never read. Agents are built before the Bureau, so the
   * tool reaches the journal through a reference set once the Bureau exists (see the README). A
   * write for a run this Bureau never knew is refused.
   */
  readonly peerCalls: PeerCallJournal;

  /**
   * COR-851 — durable goals: create a goal, read and list it, see what it has
   * in flight, cancel it, close it once it has ended, and recover every
   * unfinished one after a restart. A goal's record, its controller, and each
   * attempt's run all survive the process. Needs a durable engine and the
   * validators named in {@link BureauOptions.validators}. See `goal-types.ts`.
   */
  readonly goals: BureauGoals<AgentNames<D>>;

  /**
   * The owner of record of a resource (COR-718), or `undefined` when no such
   * resource exists. The owner is the principal that created the resource,
   * stored once at creation and unchanged afterward; a service principal such as
   * `system:scheduler` is only ever the actor on an audit entry, never an owner.
   * A resource created with no stated principal, and a record persisted before
   * owners existed, read as `anonymous:local`.
   *
   * - `run`: the principal the run was created with (`CreateRunRequest.principal`,
   *   or its schedule's owner for a schedule fire, or its parent's for a child).
   * - `session`: the owner of the run that created it.
   * - `goal`: the goal request's `principal`.
   * - `schedule`: `DurableScheduleDefinition.principal`.
   * - `review`: its run's owner.
   * - `audit`: derived from the entry, never stored on it as a field of its own: a
   *   run id gives that run's owner, `schedule:<id>` the schedule's, and
   *   `session:<id>` (a `session.deleted` entry) the `owner` its `detail` records.
   *   Bureau captures that owner at deletion, so the answer never depends on the
   *   live session, which may be gone or recreated under another owner. An entry
   *   without one, such as a deletion that bypassed Bureau, has no owner.
   */
  ownerOf(resource: OwnedResource): Promise<string | undefined>;

  /**
   * The durable Weft engine this bureau composed, or `undefined` when none is composed. It is the
   * engine that checkpoints and owns this bureau's runs, so a host that serves Weft's own API or
   * console over the same runs hands out this one rather than building a second engine over the
   * same storage: a second engine holds no lease on these runs, so its cancel is not fenced by
   * their owner and its live feed does not see them. The bureau still owns it. The host must not
   * dispose it, and must not register workflows on it or start its own background tasks.
   *
   * This is an admin surface for one local principal. Every operation on the engine, a cancel, a
   * signal, a start, bypasses the checks `tasks.start` and the session verbs make on the caller's
   * ownership of a session or run, so a host that serves it must authenticate its callers
   * itself. Hand it only to a host that answers to a single trusted caller, such as a local
   * console.
   */
  durableEngine(): RegistryAgnosticEngine | undefined;

  /**
   * Run one host-driven durable-engine maintenance cycle. This fires due
   * timers and schedules and performs Weft's cleanup, retention, and alert
   * maintenance. Intended for `maintenance: 'manual'` hosts.
   *
   * Also prunes a session's `lastRunOwningPrincipals` entries (AB-359) once
   * a run's entire durable event history has fallen below the fleet feed's
   * retention floor (AB-363) — never on a run's terminal transition, and
   * never on a count. AB-388: also prunes the durable audit trail per
   * `BureauRetentionOptions.audit` (default `'forever'`, a no-op) — see
   * that option's own doc comment. COR-424: also deletes run-creation
   * receipts whose `retention.receipts` window has passed, with
   * their conflict records; the automatic profile does the same on its own
   * maintenance interval.
   *
   * AB-388 (Codex review, PR #597, "Document the KV-only maintenance
   * return value"): resolves `true` whenever there was ANY maintenance
   * surface to drive — a composed durable engine, OR just a KV-backed
   * audit trail with no durable engine at all (a persistent backend with
   * `durable: false`). This
   * used to document `undefined` for "no durable engine is composed",
   * which was accurate before this issue but is no longer: a KV-only
   * bureau now genuinely has maintenance to run (audit retention) even
   * with no engine, and this method returns `true` for that case, not
   * `undefined`. `undefined` is reserved for the fully ephemeral case —
   * no durable engine AND no KV-backed audit trail — where there is
   * nothing at all for this method to do.
   *
   * COR-1477: task retention is part of that surface. A pass that removed
   * terminal tasks past `BureauRetentionOptions.tasks` resolves `true` even in
   * a fully ephemeral bureau, because it did maintain something; one that
   * removed none there still resolves `undefined`.
   */
  maintain(now?: number): Promise<true | undefined>;

  /**
   * COR-2009 — removes every record past its retention window now, and says how many went: audit
   * records and the resolved reviews they describe (`retention.audit`), expired memories
   * (`retention.memory`, or the memory policy), finished runs' log lines (`retention.logs`),
   * notifications (`retention.notifications`) and settled hook deliveries
   * (`retention.hookDeliveries`). The windows are read afresh first. A kind whose pass fails is
   * diagnosed and listed in {@link ExpiredRecordRemoval.failed}, and the other kinds still go. It
   * is how a Bureau created with `expiredRecords: 'on-request'` removes them; under the default it
   * removes what the next maintenance pass would. Rejects with `CONFLICT` once shutdown has begun.
   */
  removeExpiredRecords(): Promise<ExpiredRecordRemoval>;

  /**
   * Installs the host-owned authority freshness check used immediately before
   * a delayed tool approval is resumed. Transports that issue revocable
   * credentials should configure this when they attach to the bureau.
   */
  setRequestAuthorityValidator(
    validator: ((context: ToolRequestContext) => boolean | Promise<boolean>) | undefined,
  ): void;

  /**
   * Waits for boot durable recovery to finish and resolves a typed
   * {@link BureauRecoveryReport} describing its outcome. A Bureau with no durable engine has
   * no runs to recover, so with nothing recorded to sweep this resolves
   * `{ outcome: 'clean', perRunFailures: [], skippedRuns: [] }` immediately.
   *
   * `createBureau()` returns once boot recovery has STARTED — `recoverAll()`
   * has begun resuming recovered handles and each owned run has been
   * registered — not once recovery, or the resumed runs themselves, have
   * completed. A recovered run's first step can dispatch tool calls before a
   * caller's own post-boot dependency wiring (webhook targets, event
   * listeners, and the like) is ready.
   *
   * That timing is DIFFERENT on the two paths this method covers, so what
   * `await recovery()` buys a caller is different too:
   *
   * - **Recovery not deferred** (the common case: `requestAuthorityValidator`
   *   is set in `BureauOptions`, or no persisted session has an in-flight run
   *   under transport-issued authority). `createBureau()` itself already
   *   awaits this same barrier before resolving, so by the time a caller HAS
   *   a `bureau` to call `recovery()` on, recovery classification is
   *   already done and any recovered run may already be advancing. Calling
   *   `recovery()` here reports that (already-settled) fact; it
   *   cannot retroactively delay a recovered run's already-dispatched first
   *   step. A caller with post-boot dependency wiring that a recovered run
   *   will need must finish that wiring BEFORE calling `createBureau()` (or
   *   supply it via `BureauOptions` at construction) — there is no
   *   after-the-fact seam on this path.
   * - **Recovery deferred** (a host that calls `createBureau()` without
   *   `requestAuthorityValidator` and attaches one later with
   *   `setRequestAuthorityValidator()`, when durable execution finds a
   *   persisted session whose in-flight run carries transport-issued
   *   authority — an `authorizationRevision` other than Bureau's own — or
   *   cannot read the sessions to check). `createBureau()` resolves without
   *   starting recovery, and recovery does not start at all until
   *   `setRequestAuthorityValidator()` is called with a validator, so a
   *   caller that finishes its dependency wiring before or immediately after
   *   that call, then `await`s `recovery()`, genuinely gates on
   *   recovery's classification/reattachment pass completing.
   *   `recovery()` is the only way to observe when that deferred pass
   *   finishes.
   */
  recovery(): Promise<BureauRecoveryReport>;

  /**
   * Subscribe to every live frame. The FIRST subscriber is also replayed, in
   * emission order, the frames emitted during boot recovery and by the runs it recovered (at
   * most the newest 1024), so a recovered run that emitted while `createBureau()` was
   * still awaiting is not lost to a caller that can only subscribe after it
   * returns. The replay runs in a microtask, after this call has returned its unsubscribe
   * handle, so a listener may unsubscribe itself from inside it. Later
   * subscribers receive only new frames. Emitter listeners get
   * no such replay; register them through {@link BureauOptions.onEvent}.
   */
  frames(listener: (frame: ServerFrame) => void): () => void;

  addEventListener<K extends keyof BureauEventMap & string>(
    type: K,
    listener: (event: BureauEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;

  removeEventListener<K extends keyof BureauEventMap & string>(
    type: K,
    listener: (event: BureauEventMap[K]) => void,
    options?: boolean | EventListenerOptions,
  ): void;

  on<K extends keyof BureauEventMap & string>(
    type: K,
    options?: EventObservableOptions,
  ): ObservableLike<BureauEventMap[K]>;

  once<K extends keyof BureauEventMap & string>(
    type: K,
    listener: (event: BureauEventMap[K]) => void,
  ): void;

  subscribe<K extends keyof BureauEventMap & string>(
    type: K,
    observerOrNext?: Observer<BureauEventMap[K]> | ((value: BureauEventMap[K]) => void),
    error?: (err: unknown) => void,
    complete?: () => void,
  ): Subscription;

  toObservable(): ObservableLike<BureauEventMap[keyof BureauEventMap]>;

  events<K extends keyof BureauEventMap & string>(
    type: K,
    options?: EventIteratorOptions,
  ): AsyncIterableIterator<BureauEventMap[K]>;

  complete(): void;
  readonly completed: boolean;
  readonly signal: AbortSignal;

  dispose(): Promise<void>;

  /**
   * Awaited drain of everything Bureau owns (AB-207/AB-37). `dispose()` is a
   * thin wrapper — `shutdown({ policy: 'abort' })` awaited to completion —
   * kept for the existing `Promise<void>` external shape; prefer `shutdown()`
   * directly when the report is useful.
   *
   * `'abort'` (the default when `policy` is omitted) aborts every active run
   * this process started immediately, then awaits every drain. A durable run this process
   * recovered at boot is left running for the next process to recover, as `'detach'` leaves it,
   * and is counted in the report's `detached`. `'drain'` closes admission
   * identically but lets every already-active caller-owned agent run
   * (task-owned) reach its own natural terminal result while
   * Bureau-owned background work (online-evals, webhook notifier,
   * audit trail) is stopped/awaited exactly as under `'abort'`.
   * `'detach'` closes admission identically, leaves durable caller-owned runs recoverable,
   * aborts process-local and catalog runs, waits errored runs, and stops/awaits Bureau-owned
   * background work exactly as under `'abort'`. Toolbox cleanup is always abortive for detach.
   *
   * `timeoutMilliseconds` bounds the WAIT only: on elapse, `shutdown()`
   * resolves (never rejects) with every already-settled owner's real outcome
   * and every still-outstanding owner reported `'unresolved'` — the
   * underlying teardown keeps running to completion in the background, it is
   * never abandoned. Omitting it waits indefinitely, matching today's
   * `dispose()`. That wait sleeps on the RESOLVED runtime
   * (`RuntimeServices.timers`, never a real timer directly — see
   * {@link BureauShutdownOptions.timeoutMilliseconds}), so under a manual
   * runtime the caller owns advancing the clock far enough for a bounded
   * wait to elapse — `bureau/test`'s `BureauTestHarness.close()` is the one
   * built-in exception, owning that advance itself (Coordinator ruling on
   * AB-338).
   *
   * Calling `shutdown()` (or `dispose()`) more than once is idempotent: every
   * call after the first returns the same cached report promise, regardless
   * of the policy passed to the later call.
   */
  shutdown(options?: BureauShutdownOptions): Promise<BureauShutdownReport>;
  /**
   * COR-1631 — the task's interactive surfaces: create, compare-and-swap update,
   * snapshot, action admission, close, owner abort, and cleanup, kept in the
   * task's durable history (see `documentation/interactive-surface.md`).
   * `undefined` for a Bureau without persistent durable execution
   * (`durable` over persistent storage), which keeps no durable history.
   */
  readonly surfaces: InteractiveSurfaces | undefined;
  /**
   * COR-1481 — where the Bureau is in its life: `ready`, `draining` once
   * `shutdown()` has closed admission, `stopped` once it has completed.
   */
  readonly lifecycle: 'ready' | 'draining' | 'stopped';

  /**
   * The managed-asset service (COR-794). Present whenever `options.assets`
   * is configured; `undefined` otherwise (the default). `shutdown()` aborts
   * its in-flight asset work and awaits every cleanup acknowledgement.
   */
  readonly assets: AssetService | undefined;
}
// ── API Request / Response Types ─────────────────────────────────────

/**
 * AB-369: a run `abortRun` requested cancellation for whose cleanup has not
 * yet settled — one row per entry `abortRun`'s own `abortingRunIds`
 * bookkeeping holds. See {@link Bureau.internals.abortingTasks}.
 */
export interface AbortingRun {
  readonly runId: string;
  readonly since: number;
}
/** A resource whose owner of record {@link Bureau.ownerOf} reads. */
export type OwnedResource =
  | { readonly kind: 'run' | 'session' | 'goal' | 'schedule' | 'review'; readonly id: string }
  | {
      readonly kind: 'audit';
      readonly runId: string;
      /** The audit entry's `detail`. A `session.deleted` entry's owner is `detail.owner`. */
      readonly detail?: unknown;
    };
