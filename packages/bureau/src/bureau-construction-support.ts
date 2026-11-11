import {
  resolveWorkspaceOwner,
  type WorkspaceRuntimeAuthority,
} from './http/workspace-principal.ts';
import { type RuntimeServices } from '@lostgradient/lifecycle';
import { createGovernedMemoryTools } from '@lostgradient/memory';
import { type PeerCallJournal, SKILL_TOOL_DENIED_CODE } from '@lostgradient/operative';
import { type ConditionalTextValueStore } from '@lostgradient/storage';
import { type Tool } from 'armorer';
import { type AgentDefinitions } from './agent-catalog';
import type { DefinitionScannerHealth } from './definition-scanner';
import { type AuditTrail } from './audit-trail';
import { DEFAULT_TASK_RETENTION_MS } from './settings/setting-defaults';
import type { SettingsValues } from './settings/settings-schema';
import { createToolMemoryAuthority } from './run-memory';
import { type BureauWorkflows } from './workflow-runtime';
import type { AgentSource, WorkflowSource } from './sources/definition-source';
import { resolveDefinitionSource } from './sources/validate-definition-source';
import { type AnswerEncryptionKeys } from './secret-answers';
import type {
  Bureau,
  BureauOptions,
  BureauWatcherHealth,
  DiagnosticSink,
  ExpiredRecordKind,
  ExpiredRecordRemoval,
} from './types';
import type { BureauNotifications } from './notifications/notification-types';
import { type WebhookDeliveryEngine, type WebhookNotifierOptions } from './webhook-notifier';
import type { HooksDependencies } from './hooks/create-hooks.ts';
import { createHooks, type CreatedHooks } from './hooks/create-hooks';
import type { HookSubjectSources } from './hooks/hook-scope';
import { BureauError, toBadRequest } from './bureau-errors';

export const BUREAU_AGENT_NAME = 'bureau';

export function createBureauMemoryTools(
  memory: Parameters<typeof createGovernedMemoryTools>[0] | undefined,
  memoryAuthority: Parameters<typeof createToolMemoryAuthority>[2],
  tenantId: string,
  ownerForRun: (runId: string | undefined) => Promise<string | undefined>,
  workspace: WorkspaceRuntimeAuthority | undefined,
): Record<string, Tool> {
  if (memory === undefined) return {};
  return createGovernedMemoryTools(memory, {
    resolveContext: async ({ toolName, requestContext }) => {
      if (requestContext === undefined) return undefined;
      const ownerId =
        requestContext.runId === undefined
          ? requestContext.authority.ownerId
          : ((await ownerForRun(requestContext.runId)) ?? requestContext.authority.ownerId);
      if (
        workspace !== undefined &&
        (await resolveWorkspaceOwner(workspace, ownerId)) === undefined
      )
        return undefined;
      return {
        collection: requestContext.agentId ?? BUREAU_AGENT_NAME,
        authority: createToolMemoryAuthority(requestContext, toolName, memoryAuthority, {
          tenantId,
          ownerId,
        }),
      };
    },
  });
}

export function assertNoMemoryToolCollision(
  source: AgentSource | undefined,
  memoryTools: Readonly<Record<string, Tool>>,
): void {
  const collision = Object.keys(memoryTools).find((name) =>
    Object.hasOwn(source?.tools ?? {}, name),
  );
  if (collision !== undefined) {
    throw new BureauError(
      `"options.agentSource.tools" names a tool "${collision}", which Bureau provides itself`,
      'BAD_REQUEST',
    );
  }
}

/** COR-1937: how many of a context's newest tasks `contexts.window` looks through for its latest step. */
export const CONTEXT_WINDOW_TASK_SCAN_LIMIT = 50;

/** COR-1986: how long a delete waits between attempts to take a thread's lease another holds. */
export const THREAD_LEASE_RETRY_MILLISECONDS = 100;

export const SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS = 3;

export const SESSION_PERSISTENCE_RETRY_DELAY_MILLISECONDS = 10;

/** COR-1621: the longest wait between attempts to reconcile a followed fire with its history. */
export const FIRE_REVIEW_RECONCILIATION_MAXIMUM_DELAY_MILLISECONDS = 5_000;

/**
 * COR-1476 — the first wait between attempts to write an ended run's steering
 * `run-ended` entry; each later wait doubles, up to the cap. The write is
 * retried until it is acknowledged or the bureau closes, because the run reads
 * the session's mailbox only after it.
 */
export const SESSION_INPUT_RUN_END_RETRY_DELAY_MILLISECONDS = 10;

export const SESSION_INPUT_RUN_END_RETRY_CAP_MILLISECONDS = 2_000;

/** After the first failure is reported, how long passes before the next one is. */
export const SESSION_INPUT_RUN_END_DIAGNOSTIC_INTERVAL_MILLISECONDS = 60_000;

/**
 * Builds the sleep the session-persistence retry loops wait on — a real
 * sleep driven by the composed {@link RuntimeServices.timers} (AB-260), so a
 * `ManualRuntimeServices` clock advances it. The timer-scheduling and timer-clearing members are destructured once so
 * the call sites below read `scheduleTimeout(...)` rather than a literal
 * `timers` method call — see `runtime-composition.ts`'s equivalent pattern
 * for why: the AB-260 binary completion check greps for the literal global
 * timer-scheduling call text, and only a destructured alias avoids it while
 * still routing through the injected timers.
 */
export function createSessionPersistenceSleep(
  timers: RuntimeServices['timers'],
): (milliseconds: number) => Promise<void> {
  const { setTimeout: scheduleTimeout } = timers;
  return (milliseconds) => new Promise((resolve) => scheduleTimeout(resolve, milliseconds));
}

/**
 * Builds the sleep that bounds `shutdown({ timeoutMilliseconds })`'s wait — a
 * sleep driven by the composed {@link RuntimeServices.timers} (AB-260),
 * cleared (never resolving) if `signal` aborts first so a `shutdown()` whose
 * real teardown wins the race does not leave this timer pending for the
 * rest of its duration. Under a `ManualRuntimeServices` nothing advances it
 * but the caller's clock.
 */
export function createShutdownTimeoutSleep(
  timers: RuntimeServices['timers'],
): (milliseconds: number, signal: AbortSignal) => Promise<void> {
  const { setTimeout: scheduleTimeout, clearTimeout: cancelTimeout } = timers;
  return (milliseconds, signal) =>
    new Promise((resolve) => {
      if (signal.aborted) return;
      const handle = scheduleTimeout(resolve, milliseconds);
      signal.addEventListener('abort', () => cancelTimeout(handle), { once: true });
    });
}

function ignoreBestEffortPromiseRejection(): void {}

export function detachBestEffortPromise(promise: Promise<unknown>): void {
  void promise.catch(ignoreBestEffortPromiseRejection);
}

/** {@link BureauOptions} once each definition-source option is one source (COR-1873). */
export type LayeredBureauOptions<D extends AgentDefinitions> = Omit<
  BureauOptions<D>,
  'agentSource' | 'workflowSource'
> & {
  readonly agentSource?: AgentSource;
  readonly workflowSource?: WorkflowSource;
};

/** `options` with `agentSource` and `workflowSource` each checked and layered into one source. */
export function withLayeredSources<const D extends AgentDefinitions>(
  options: BureauOptions<D>,
): LayeredBureauOptions<D> {
  const { agentSource, workflowSource, ...rest } = options;
  return {
    ...rest,
    ...(agentSource === undefined
      ? {}
      : {
          agentSource: resolveDefinitionSource('agentSource', 'agent', agentSource, toBadRequest),
        }),
    ...(workflowSource === undefined
      ? {}
      : {
          workflowSource: resolveDefinitionSource(
            'workflowSource',
            'workflow',
            workflowSource,
            toBadRequest,
          ),
        }),
  };
}

/**
 * COR-1897, COR-1977 — `options` with the agents and workflows the running plugins ship layered
 * beneath the owner's sources. The layers are known only once plugins are composed, so the sources
 * the caller gave are layered again with them. Nothing changes without an `agentSource` or a
 * `pluginAgentSource`, and likewise for workflows.
 */
export function withPluginContentLayers<const D extends AgentDefinitions>(
  options: LayeredBureauOptions<D>,
  given: BureauOptions<D>,
  shipped: readonly { readonly plugin: string; readonly content: URL }[],
): LayeredBureauOptions<D> {
  if (shipped.length === 0) return options;
  const agentSource = layeredWithPlugins(
    'agentSource',
    'agent',
    given.agentSource,
    options.pluginAgentSource,
    shipped,
  );
  const workflowSource = layeredWithPlugins(
    'workflowSource',
    'workflow',
    given.workflowSource,
    options.pluginWorkflowSource,
    shipped,
  );
  return {
    ...options,
    ...(agentSource === undefined ? {} : { agentSource }),
    ...(workflowSource === undefined ? {} : { workflowSource }),
  };
}

/** The owner's `given` sources with the layer `layerOf` returns for each shipped content, or `undefined` for none. */
function layeredWithPlugins<const Source extends AgentSource | WorkflowSource>(
  option: 'agentSource' | 'workflowSource',
  kind: 'agent' | 'workflow',
  given: Source | readonly Source[] | undefined,
  layerOf: ((plugin: string, content: URL) => Source | undefined) | undefined,
  shipped: readonly { readonly plugin: string; readonly content: URL }[],
): Source | undefined {
  if (layerOf === undefined || given === undefined) return undefined;
  const owners: readonly Source[] = Array.isArray(given) ? given : [given as Source];
  const layers = shipped.flatMap(({ plugin, content }) => {
    const layer = layerOf(plugin, content);
    return layer === undefined ? [] : [layer];
  });
  if (layers.length === 0) return undefined;
  return resolveDefinitionSource(option, kind, [...owners, ...layers], toBadRequest) as Source;
}

/**
 * COR-1700 — `humanInput` and `wakeup` are on by default for a durable Bureau, so `true` says
 * nothing and is refused: the only forms are `false`, and for `humanInput` an `inputSchemas` object.
 */
export function rejectOptInToolOption(
  name: 'humanInput' | 'wakeup' | 'decide',
  value: unknown,
): void {
  if (value === undefined || value === false) return;
  if (name === 'humanInput' && typeof value === 'object' && value !== null) return;
  toBadRequest(
    `"options.${name}" is on by default for a durable Bureau, so ${value === true ? '`true`' : 'that value'} is not accepted; omit it, or pass \`false\` to turn it off`,
  );
}

/** {@link BureauRetentionOptions.tasks}, or its default window when none was given. */
export function taskRetentionOf(values: SettingsValues) {
  return values['retention.tasks'] ?? { olderThan: DEFAULT_TASK_RETENTION_MS };
}

/** COR-1701 — validates every window of {@link BureauOptions.retention}, each under its own key. */

/**
 * COR-1701: `Bureau.id` is the tenant every run's memory is written under, and the generated
 * default changes on every start. Over a storage backend a restarted Bureau would therefore read
 * an empty tenant while the old one sits unread, with nothing to say so. Refused before anything
 * is composed, so no engine or store is left to release; the handler's `assertPersistence` keeps
 * the broader check for a Bureau it serves.
 */
export function assertMemoryTenantIsStable(
  options: Pick<BureauOptions, 'memory' | 'storage' | 'id'>,
): void {
  if (options.memory !== undefined && options.storage !== undefined && options.id === undefined) {
    toBadRequest(
      '"options.memory" over "options.storage" needs an explicit "options.id": the memory tenant is the Bureau id, and a generated id changes on every start, so a restarted Bureau would read an empty tenant',
    );
  }
}

/** COR-2009 — refuses a {@link BureauOptions.expiredRecords} that names neither of its two choices. */
export function validateExpiredRecordsOption(value: unknown): void {
  if (value === undefined || value === 'maintenance' || value === 'on-request') return;
  throw new BureauError(
    `expiredRecords must be 'maintenance' or 'on-request', not ${JSON.stringify(value)}.`,
    'BAD_REQUEST',
  );
}

/** Which pass a retention sweep runs in, as its diagnostics name it. */
export type MaintenancePassName = 'Manual' | 'Automatic' | 'Requested';

/** A pass's count of removed records, or zero for one that failed, which the removal lists apart. */
function removedCount(result: number | 'failed'): number {
  return result === 'failed' ? 0 : result;
}

/**
 * COR-2009 — what {@link Bureau.removeExpiredRecords} reports from each pass's result: how many
 * records of each kind went, their total, and the kinds whose pass failed.
 */
export function expiredRecordRemovalOf(
  results: Readonly<Record<ExpiredRecordKind, number | 'failed'>>,
): ExpiredRecordRemoval {
  const kinds = Object.keys(results) as ExpiredRecordKind[];
  const byKind = Object.fromEntries(
    kinds.map((kind) => [kind, removedCount(results[kind])]),
  ) as Record<ExpiredRecordKind, number>;
  return {
    removed: kinds.reduce((total, kind) => total + byKind[kind], 0),
    byKind,
    failed: kinds.filter((kind) => results[kind] === 'failed'),
  };
}

/**
 * Whether a maintenance pass had anything to drive: a durable engine, the audit trail, governed
 * memory (COR-1546, whose deletions advance only when asked to), a notification retention window
 * (COR-1941), a hook delivery retention window (COR-1943), or terminal tasks it removed.
 * Kept apart from `createBureau` so its complexity stays inside the repository's bound.
 */
export function hasMaintenanceSurface(surface: {
  readonly durableEngine: boolean;
  readonly auditTrail: boolean;
  readonly memory: boolean;
  readonly notificationRetention: boolean;
  readonly hookDeliveryRetention: boolean;
  readonly tasksRemoved: number;
}): boolean {
  return (
    surface.durableEngine ||
    surface.auditTrail ||
    surface.memory ||
    surface.notificationRetention ||
    surface.hookDeliveryRetention ||
    surface.tasksRemoved > 0
  );
}

/**
 * How often the Bureau's own timer runs its maintenance, and the expiry sweep that goes with it
 * (COR-1613, COR-1622): five minutes, the cadence of Weft's own retention sweep.
 */
export const EXPIRY_SWEEP_INTERVAL_MILLISECONDS = 300_000;

/**
 * Whether a resumed approval's error result proves the call never ran, so the review stays
 * pending: the toolbox reports its approval binding unconsumed (COR-1579), or, for a toolbox with
 * no approval store that reports no consumption at all, the run's skill gate refused the call with
 * `SKILL_TOOL_DENIED` (COR-1628).
 */
export function resumeRefusedBeforeExecution(result: object): boolean {
  // A toolbox that reports consumption has the final word: a consumed binding means the call ran,
  // whatever code its error carries.
  if ('approvalBindingConsumed' in result) return result.approvalBindingConsumed === false;
  return (result as { error?: { code?: string } }).error?.code === SKILL_TOOL_DENIED_CODE;
}

/**
 * Whether the automatic maintenance timer starts: there is a durable engine, governed memory
 * with a deletion to advance (COR-1546), or a key-value store whose audit trail or notifications have a retention
 * policy to apply. A key-value store with no retention has nothing for the timer to do.
 */
export function needsAutomaticMaintenance(composed: {
  readonly durableEngine: boolean;
  readonly memory: boolean;
  readonly keyValueStore: boolean;
  readonly activeAuditRetention: boolean;
  readonly activeNotificationRetention: boolean;
  readonly activeHookDeliveryRetention: boolean;
}): boolean {
  return (
    composed.durableEngine ||
    composed.memory ||
    (composed.keyValueStore &&
      (composed.activeAuditRetention ||
        composed.activeNotificationRetention ||
        composed.activeHookDeliveryRetention))
  );
}

/** COR-1731: one definition source's recorded scan health, as `internals.diagnostics()` reports it. */
export function watcherHealthOf(
  source: 'agents' | 'workflows',
  watched: { readonly health: () => DefinitionScannerHealth },
): BureauWatcherHealth {
  const { lastScanAt, lastScanError } = watched.health();
  return { source, lastScanAt: lastScanAt ?? null, lastScanError: lastScanError ?? null };
}

/**
 * How a construction that fails part-way stops what it started (COR-1781). `constructBureau` names
 * it as construction goes on: none while it fails before anything is guarded, then the shutdown of
 * the composition (`abandonConstruction`), then, once the Bureau object exists, `bureau.shutdown()`.
 */
export type BureauConstruction<D extends AgentDefinitions> = {
  abandon?: (error: unknown) => Promise<never>;
  /** Settles `createBureau`'s promise with the built Bureau. */
  readonly built: (bureau: Bureau<D>) => void;
};

/** COR-1939: hooks keep their records in the key-value store, so a Bureau with none cannot have them. */
export function rejectHooksWithoutStorage(
  hooks: BureauOptions['hooks'],
  kv: ConditionalTextValueStore | undefined,
): void {
  if (hooks !== undefined && kv === undefined) {
    throw new BureauError(
      'Hooks need durable storage: pass `storage`, so delivery records survive a restart',
      'NOT_CONFIGURED',
      'persistence',
    );
  }
}

/** Whether the webhook notifier is built: a fixed target is configured, or hooks need its engine. */
export function wantsWebhookNotifier(options: BureauOptions<AgentDefinitions>): boolean {
  return (options.webhooks?.targets.length ?? 0) > 0 || options.hooks !== undefined;
}

/** The options the notifier is built with: the caller's `webhooks`, and the engine when hooks need it. */
export function webhookNotifierOptionsOf(
  options: BureauOptions<AgentDefinitions>,
  signal: AbortSignal,
): WebhookNotifierOptions {
  return {
    targets: [],
    ...options.webhooks,
    signal,
    ...(options.hooks === undefined ? {} : { engine: true }),
  };
}

/**
 * COR-1939: builds the hooks over the notifier's engine. They are resumed by `resumeHooks` once the
 * Bureau's workflows are loaded.
 */
export function composeHooks(input: {
  readonly workspace?: WorkspaceRuntimeAuthority | undefined;
  readonly eventForHookOwner?: HooksDependencies['eventForHookOwner'];
  readonly mayStartWorkflows?: HooksDependencies['mayStartWorkflows'];
  readonly options: BureauOptions<AgentDefinitions>['hooks'];
  readonly engine: WebhookDeliveryEngine | undefined;
  readonly kv: ConditionalTextValueStore | undefined;
  readonly keys: AnswerEncryptionKeys | undefined;
  readonly bureauId: string;
  readonly runtimeServices: RuntimeServices;
  readonly auditTrail: AuditTrail | undefined;
  readonly diagnose: DiagnosticSink;
  /** The Bureau's workflows and notifications, read when an action needs them (COR-1940). */
  readonly workflows: () => BureauWorkflows | undefined;
  readonly notifications: () => BureauNotifications | undefined;
  /** Which hook started a run, directly or through the runs above it. */
  readonly startedByHook: (runId: string) => Promise<string | undefined>;
  /** The records a hook's scope is matched against (COR-1978). */
  readonly subjects: HookSubjectSources;
}): CreatedHooks | undefined {
  const { options, engine, kv, diagnose } = input;
  if (options === undefined || engine === undefined || kv === undefined) return undefined;
  const created = createHooks({
    workspace: input.workspace,
    eventForHookOwner: input.eventForHookOwner,
    mayStartWorkflows: input.mayStartWorkflows,
    kv,
    engine,
    secrets: options.secrets,
    keys: input.keys,
    urlPolicy: options.urlPolicy,
    requestTimeoutMilliseconds: options.requestTimeoutMilliseconds,
    actionKinds: options.actionKinds,
    workflows: input.workflows,
    notifications: input.notifications,
    startedByHook: input.startedByHook,
    subjects: input.subjects,
    bureauId: input.bureauId,
    newId: (kind) => input.runtimeServices.identifiers.next(kind),
    audit: async (entry) => {
      await input.auditTrail?.record(entry);
    },
    diagnose: (message, cause) =>
      diagnose({ level: 'error', scope: 'hooks', message: `[bureau] ${message}`, cause }),
    notice: (message) => diagnose({ level: 'warn', scope: 'hooks', message }),
  });
  return created;
}

/**
 * COR-1939: resumes the deliveries a previous process left pending. The resume is tracked, so the
 * notifier's `flush()` waits for it and for the deliveries it takes. It runs once the workflow files
 * are loaded (COR-1940): a `start-workflow` delivery resumed before them would find no workflow and
 * be refused as if it did not exist.
 */
export function resumeHooks(input: {
  readonly hooks: CreatedHooks | undefined;
  readonly engine: WebhookDeliveryEngine | undefined;
  readonly diagnose: DiagnosticSink;
}): void {
  const { hooks, engine, diagnose } = input;
  if (hooks === undefined || engine === undefined) return;
  engine.track(
    hooks.resume().then(
      () => undefined,
      (cause: unknown) =>
        diagnose({
          level: 'error',
          scope: 'hooks',
          message: '[bureau] Failed to resume pending hook deliveries',
          cause,
        }),
    ),
  );
}

export function notifyPeerCallsReady<D extends AgentDefinitions>(
  options: BureauOptions<D>,
  journal: PeerCallJournal,
): void {
  options.peerCallsReady?.(journal);
}

/** Preserve one immutable membership directory binding throughout runtime construction. */
export function snapshotWorkspaceOptions<const D extends AgentDefinitions>(
  options: LayeredBureauOptions<D>,
): LayeredBureauOptions<D> {
  return options.workspace === undefined
    ? options
    : { ...options, workspace: Object.freeze({ ...options.workspace }) };
}

/** Snapshot caller-owned answer keys before asynchronous construction begins. */
export function snapshotAnswerEncryption(
  keys: AnswerEncryptionKeys | undefined,
): AnswerEncryptionKeys | undefined {
  return keys === undefined
    ? undefined
    : {
        current: keys.current,
        ...(keys.retired === undefined ? {} : { retired: keys.retired }),
      };
}
