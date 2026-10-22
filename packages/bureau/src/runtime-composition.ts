import type { EventMap, HookReplayPolicy, RuntimeServices } from '@lostgradient/lifecycle';
import {
  createDefaultRuntimeServices,
  HookRegistry,
  mergeHookRegistries,
  TypedEventTarget,
} from '@lostgradient/lifecycle';
import type {
  GovernedMemory,
  MemoryAuthority,
  MemoryCapability,
  MemoryWriteReceipt,
} from '@lostgradient/memory';
import { createMemoryAuthority, MEMORY_CAPABILITIES, requestPrincipal } from '@lostgradient/memory';
import type {
  AgentInput,
  AgentRunContext,
  AgentSession,
  CheckpointStore,
  ContentSourceResolver,
  GeneratedMediaAdmitter,
  DurableRunDeps,
  GenerateFunction,
  GuardrailHooks,
  GuardrailsOptions,
  JSONValue,
  OnStepHook,
  OperativeHookMap,
  PrepareStepHook,
  RegistryAgnosticEngine,
  RequestHumanInputContext,
  RequestHumanInputInput,
  RunEngineObservability,
  RunOptions,
  ScheduledAgentRunInput,
  Scheduler,
  ScheduleWakeupContext,
  ScheduleWakeupInput,
  SessionStore,
  SessionSummary,
  StepRecord,
  StreamEventMap,
} from '@lostgradient/operative';
import {
  appendAgentInput,
  createAgentSession,
  createAnthropicProvider,
  createAnthropicProviderStream,
  createCheckpointStore,
  createComplexityStrategy,
  createCostAwareStrategy,
  createDefaultGuardrailsPreset,
  createFalloverGenerate,
  createGeminiProvider,
  createGeminiProviderStream,
  createGuardrails,
  createIdentityHook,
  createOpenAIProvider,
  createOpenAIProviderStream,
  createRequestHumanInputTool,
  createRoutingGenerate,
  createRunEngine,
  createRunWorkflow,
  createScheduler,
  createScheduleWakeupTool,
  createSessionStore,
  createStepBasedStrategy,
  DEFAULT_MAXIMUM_STEPS,
  isAgentRunWorkflowInput,
  isScheduledAgentRunInput,
  isSessionInputPayload,
  payloadText,
  readBackendDescriptors,
  reservedIdentifierReason,
  ScheduleAttemptedEvent,
  ScheduleCompletedEvent,
  ScheduleFailedEvent,
  SCHEDULER_ORIGIN_TAG,
  SCHEDULER_RUN_ID_PREFIX,
  ScheduleSkippedEvent,
  withActiveSkillToolPolicy,
  withBackendDescriptors,
  withCache,
  withEnhancedStreaming,
  WorkflowVersionMismatchEvent,
  SESSION_OWNER_METADATA_KEY,
} from '@lostgradient/operative';
import {
  createSkillArtifactLoader,
  createSkillClient,
  createSkillClientToolbox,
  DEFAULT_SOURCE_PRECEDENCE,
  discoverSkills,
  renderActiveSkillInstructions,
  renderClientCatalog,
  type SkillActivationRecord,
  type SkillCatalogRevision,
  type SkillEventMap,
  type ToolPolicy,
} from './skills';
import {
  type AnyWorkflowDefinition,
  type ConditionalTextValueStore,
  decode,
  deserializeCheckpoint,
  encode,
  KEYS,
  type RecoverAllOptions,
  resolveStorage,
  type Storage,
  storageConditionalBatch,
  type StorageConfiguration,
  type TextValueStore,
  textValueStore,
  WorkflowCancelledEvent,
  WorkflowTimedOutEvent,
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
  type WorkflowServicesResolution,
  type WorkflowServicesResolverInfo,
} from '@lostgradient/weft';
import {
  type AnyToolbox,
  combineToolboxes,
  createTool,
  createToolbox,
  type ToolboxExecuteOptions,
  type ToolCallInput,
  type ToolRequestContext,
} from 'armorer';
import {
  Conversation,
  type ConversationHistory,
  createConversationHistory,
  getFirstSystemMessage,
  messageText,
} from 'conversationalist';

import type { FileAgentBinding } from './agent-file-catalog';
import { createSkillGuardrailOptions } from './agent-skills';
import {
  type GoalAttemptFence,
  type GoalAttemptTarget,
  registerGoalAttemptFence,
} from './goal-attempt-fence';
import {
  type GoalAttemptCostEstimation,
  isGoalAttemptCostEstimation,
} from './goal-cost-estimation';
import { MEMORY_EVIDENCE_METADATA_KEY } from './memory-evidence-metadata';
import { ownerOrLocal, SCHEDULER_ACTOR } from './owner-of-record';
import { resolveDiagnosticSink, serializeUnknownError } from './serialization';
import {
  isPlainAuthorityRecord,
  isSessionAuthorityAuthorized,
  resolveRunMemoryOwner,
  resolveSessionOwner,
  SessionOwnerConflictError,
} from './session-authority';
import { committedFireApprovalIds } from './scheduled-fire-review-state';
import { copyAgentOwnedRunOptions, sessionExecuteOptions } from './session-agent-options';
import type {
  BureauMemoryAuthorityOptions,
  BureauOptions,
  CacheConfiguration,
  CreateRunRequest,
  PersistenceOptions,
  ProviderConfiguration,
  RedactedProviderConfiguration,
  RedactedProviderRouteConfiguration,
  RoutingConfiguration,
  ToolSummary,
} from './types';

export type BureauToolbox = AnyToolbox;

export function createHumanWaitContext(
  servicesRef: { current?: DurableRunDeps },
  runId: string,
): RequestHumanInputContext {
  return {
    get pendingHumanWait() {
      return servicesRef.current?.pendingHumanWait;
    },
    set pendingHumanWait(value) {
      if (servicesRef.current) {
        servicesRef.current.pendingHumanWait = value;
      }
    },
    // COR-1578 — read-only: a wakeup already requested in this step refuses a human-input request.
    get pendingWakeup() {
      return servicesRef.current?.pendingWakeup;
    },
    runId,
    // Only ever constructed inside the `options.humanInput && runtime.durable`
    // guard below, so this context always backs a real durable run
    // (AB-41 / AB-43 — the durability signal threaded into the tool's context).
    durable: true,
  };
}

/**
 * AB-201 — the `scheduleWakeup` analog of {@link createHumanWaitContext}: forwards
 * reads/writes onto the run's REAL `ctx.services` object (via the same
 * `servicesRef` capture) rather than spreading it, so the tool's `pendingWakeup`
 * writes land where the durable `agentRun` workflow actually reads them.
 * `ScheduleWakeupContext` carries no `runId` field (unlike
 * `RequestHumanInputContext`), so this takes only the shared `servicesRef`. It also forwards a
 * read-only view of the human-wait slot, so a wakeup request made after a human-input request in the
 * same step is refused (COR-1578).
 */
export function createWakeupContext(servicesRef: {
  current?: DurableRunDeps;
}): ScheduleWakeupContext {
  return {
    get pendingWakeup() {
      return servicesRef.current?.pendingWakeup;
    },
    set pendingWakeup(value) {
      if (servicesRef.current) {
        servicesRef.current.pendingWakeup = value;
      }
    },
    // COR-1578 — read-only: a human-input request already made in this step refuses a wakeup.
    get pendingHumanWait() {
      return servicesRef.current?.pendingHumanWait;
    },
    // Only ever constructed inside the `options.wakeup && runtime.durable`
    // guard (below, in `createBureau`'s run composition — same placement as
    // `createHumanWaitContext`'s own guard), so this context always backs a
    // real durable run (AB-41 / AB-43 — the durability signal threaded into
    // the tool's context).
    durable: true,
  };
}

/**
 * The narrow surface `requestHumanInput` needs to dispatch its
 * `HumanWaitParkedEvent` (matches `create-request-human-input-tool.ts`'s own
 * private `HumanInputEventDispatcher` structurally, without importing it).
 */
export interface HumanWaitEventDispatcher {
  dispatchEvent(event: Event): boolean;
}

/**
 * Type guard, not a cast: `DurableRunDeps.emitter`'s own `EventDispatcher`
 * type declares only `dispatch`, never the DOM-style `dispatchEvent` every
 * real emitter (a `CompletableEventTarget`) also carries — see
 * `buildRunDepsFromSession`'s lazy `humanInputEmitter` forwarder.
 */
export function hasDispatchEvent(value: unknown): value is HumanWaitEventDispatcher {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { dispatchEvent?: unknown }).dispatchEvent === 'function'
  );
}

export interface WireDurableOptInToolsOptions {
  /** Wires `requestHumanInput` in when true (AB-13/AB-41/AB-43). */
  readonly humanInput?: boolean;
  /** Wires `scheduleWakeup` in when true (AB-201). */
  readonly wakeup?: boolean;
  readonly runId: string;
  /**
   * Where `requestHumanInput`'s `HumanWaitParkedEvent` dispatches. Ignored
   * when `humanInput` is falsy. A caller whose real emitter is not yet
   * assigned at wiring time (AB-336 — recovery's `services.emitter` is set
   * by `createRecoveredRunEventSurface` AFTER `buildRunDepsFromSession`
   * returns, but this wiring happens INSIDE it) passes a lazy forwarder
   * instead of the emitter itself; the tool only calls `dispatchEvent` at
   * actual tool-call time, by which point a lazy forwarder's target has
   * settled.
   */
  readonly humanInputEmitter?: HumanWaitEventDispatcher;
}

/**
 * AB-336 — the ONE place both the fresh-dispatch (`createRunFromRequest`)
 * and recovery (`buildRunDepsFromSession`) paths wire `requestHumanInput`/
 * `scheduleWakeup` into a run's toolbox, per the repository's No Duplicated
 * Code rule. Root cause this closes: `buildRunDepsFromSession` used to
 * return `runRuntime.toolbox` bare — the opt-in durable-park tools existed
 * ONLY on the fresh path. A run recovered mid-step whose replay reached a
 * `requestHumanInput` call found no such tool: armorer settled the call
 * with a tool-not-found error result, `pendingHumanWait` never got set, the
 * durable park never fired, and the step loop simply continued to the next
 * step — the exact "looped instead of parking" symptom this issue names,
 * observable only on a RECOVERED run whose replay reaches the call (a run
 * killed AFTER the call's step already committed is a different case,
 * covered by `create-bureau.ts`'s `reconstructHumanWaitReviewIfParked`).
 *
 * `servicesRef` is supplied by the caller, not created here: the tools'
 * mutable `pendingHumanWait`/`pendingWakeup` slots must be the EXACT
 * `ctx.services` object Weft hands back, and each caller has a different
 * point at which that object becomes available (a later `onServices` hook
 * for a fresh run; the object under construction, synchronously, for a
 * recovered one) — see each call site's own comment.
 */
export function wireDurableOptInTools(
  baseToolbox: BureauToolbox,
  servicesRef: { current?: DurableRunDeps },
  options: WireDurableOptInToolsOptions,
): BureauToolbox {
  let toolbox = baseToolbox;

  if (options.humanInput) {
    const humanWaitContext = createHumanWaitContext(servicesRef, options.runId);
    const rawHumanInputTool = createRequestHumanInputTool({
      context: humanWaitContext,
      ...(options.humanInputEmitter ? { emitter: options.humanInputEmitter } : {}),
    });
    const humanInputToolbox = createToolbox([
      createTool({
        ...rawHumanInputTool,
        // armorer's `execute` contract is async; the raw tool factory's
        // `execute` is synchronous (it only mutates `context` and returns a
        // plain result), so wrap it rather than changing its public shape.
        // Must stay `async` so a synchronous throw from `execute` is
        // converted into a rejected Promise instead of escaping
        // synchronously (Copilot review PRRT_kwDORvupsc6P7_8H) — awaiting
        // `Promise.resolve(...)` (a genuine thenable) keeps both
        // require-await and await-thenable satisfied.
        execute: async (input: RequestHumanInputInput) =>
          await Promise.resolve(rawHumanInputTool.execute(input)),
      }),
    ]);
    toolbox = combineToolboxes(toolbox, humanInputToolbox);
  }

  if (options.wakeup) {
    // Unlike `requestHumanInput`, `scheduleWakeup` dispatches no event on
    // park — `ctx.sleep` is itself the durable checkpoint, and recovery
    // re-arms it with no live wiring needed (AB-41's decision record) — so
    // no emitter is threaded here.
    const wakeupContext = createWakeupContext(servicesRef);
    const rawWakeupTool = createScheduleWakeupTool({ context: wakeupContext });
    const wakeupToolbox = createToolbox([
      createTool({
        ...rawWakeupTool,
        // Same async-wrap rationale as `requestHumanInput` above: the raw
        // tool's `execute` is synchronous and can throw synchronously
        // (`DurableCapabilityUnavailableError`); armorer's contract is
        // async, so wrapping converts a synchronous throw into a rejected
        // Promise instead of letting it escape synchronously.
        execute: async (input: ScheduleWakeupInput) =>
          await Promise.resolve(rawWakeupTool.execute(input)),
      }),
    ]);
    toolbox = combineToolboxes(toolbox, wakeupToolbox);
  }

  return toolbox;
}

const requestAuthorityMetadataKey = 'lastRequestAuthority';
const requestAuthoritiesMetadataKey = 'lastRequestAuthorities';
const defaultBureauAgentName = 'bureau';
/**
 * How long a settled scheduler task outcome stays resolvable when the caller
 * sets no `scheduler.retentionWindowMs`: one hour, bounding memory in a
 * long-lived Bureau. Bureau offers no unbounded opt-out.
 */
const DEFAULT_SCHEDULER_RETENTION_WINDOW_MS = 3_600_000;
const schedulerServicePrincipalId = SCHEDULER_ACTOR;
const schedulerServiceAuthorizationRevision = 'bureau:scheduler:1';
const toolExecutionCapability = 'tools:execute';

function isJsonRecord(value: JSONValue | undefined): value is Record<string, JSONValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requestContextFromAuthorityValue(
  value: JSONValue | undefined,
  runId: string | undefined,
  sessionId: string | undefined,
  agentName: string | undefined,
  now: () => number,
): ToolRequestContext | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const authority = value as Record<string, JSONValue>;
  const capabilities = authority['capabilities'];
  const audience = authority['audience'];
  const deadline = authority['deadline'];
  if (
    typeof authority['principalId'] !== 'string' ||
    typeof authority['tenantId'] !== 'string' ||
    typeof authority['ownerId'] !== 'string' ||
    typeof authority['authorizationRevision'] !== 'string' ||
    !Array.isArray(capabilities) ||
    !capabilities.every((capability) => typeof capability === 'string') ||
    (audience !== undefined &&
      audience !== 'public' &&
      audience !== 'tenant' &&
      audience !== 'operator') ||
    (deadline !== undefined && (typeof deadline !== 'number' || !Number.isFinite(deadline)))
  ) {
    return undefined;
  }
  if (typeof deadline === 'number' && deadline <= now()) return undefined;
  return {
    authority: {
      principalId: authority['principalId'],
      tenantId: authority['tenantId'],
      ownerId: authority['ownerId'],
      capabilities: Object.freeze([...capabilities] as string[]),
      authorizationRevision: authority['authorizationRevision'],
    },
    ...(audience !== undefined ? { audience } : {}),
    ...(typeof deadline === 'number' ? { deadline } : {}),
    ...(agentName !== undefined ? { agentId: agentName } : {}),
    ...(runId !== undefined ? { runId } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
}

/**
 * AB-260: exported directly rather than through the retired
 * `RuntimeCompositionTestingSeams` grouping — a genuine injection seam, not
 * introspection, since its only non-pure dependency was the wall clock
 * consulted for `requestContextFromAuthorityValue`'s deadline check. A test
 * calls this directly with a manual `now`, exactly as `createRuntimeComposition`
 * itself does with the bureau's composed `RuntimeServices.clock.now`.
 */
export function recoveredRequestContext(
  metadata: Record<string, JSONValue>,
  runId: string | undefined,
  sessionId: string | undefined,
  agentName: string | undefined,
  now: () => number,
): ToolRequestContext | undefined {
  const authorities = metadata[requestAuthoritiesMetadataKey];
  if (isJsonRecord(authorities)) {
    return requestContextFromAuthorityValue(
      runId === undefined ? undefined : authorities[runId],
      runId,
      sessionId,
      agentName,
      now,
    );
  }
  return requestContextFromAuthorityValue(
    metadata[requestAuthorityMetadataKey],
    runId,
    sessionId,
    agentName,
    now,
  );
}

function normalizedServiceAgentName(agentName: string | undefined): string {
  const trimmed = agentName?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : defaultBureauAgentName;
}

export function createSchedulerServiceRequestContext(
  runId: string,
  agentName: string | undefined,
  sessionId?: string,
) {
  const ownerId = normalizedServiceAgentName(agentName);
  return {
    authority: {
      principalId: schedulerServicePrincipalId,
      tenantId: 'bureau',
      ownerId,
      capabilities: Object.freeze([toolExecutionCapability]),
      authorizationRevision: schedulerServiceAuthorizationRevision,
    },
    audience: 'operator',
    agentId: ownerId,
    runId,
    // AB-364 review finding (chatgpt-codex-connector): stamped for
    // consistency with every other request context this module builds —
    // NOT a fix for scheduled-fire grant matching, which the fixed
    // `principalId` above (always `schedulerServicePrincipalId`, never the
    // triggering user's own principal) already blocks unconditionally,
    // independent of scope or sessionId.
    ...(sessionId !== undefined ? { sessionId } : {}),
  } satisfies ToolRequestContext;
}

function withDefaultToolboxRequestContext(
  toolbox: AnyToolbox,
  requestContext: ToolRequestContext | undefined,
  requestAuthorityValidator: () =>
    ((context: ToolRequestContext) => boolean | Promise<boolean>) | undefined,
  runtimeServices: RuntimeServices,
): AnyToolbox {
  if (!requestContext) return toolbox;

  const executeWithDefaultRequestContext = (async (
    input: ToolCallInput | ToolCallInput[],
    executeOptions?: ToolboxExecuteOptions,
  ) => {
    const options =
      executeOptions?.requestContext === undefined
        ? { ...executeOptions, requestContext }
        : executeOptions;
    const executionRequestContext = options.requestContext;
    const authorizationRevision = executionRequestContext?.authority.authorizationRevision;
    const requiresTransportValidation =
      authorizationRevision !== undefined &&
      authorizationRevision !== 'bureau:1' &&
      authorizationRevision !== 'bureau:scheduler:1';
    if (requiresTransportValidation && executionRequestContext) {
      const validator = requestAuthorityValidator();
      if (
        !validator ||
        !(await raceRequestAuthorityValidation(
          validator(executionRequestContext),
          options,
          runtimeServices,
        ))
      ) {
        throw new Error('Request authority is no longer current.');
      }
    }
    return Array.isArray(input) ? toolbox.execute(input, options) : toolbox.execute(input, options);
  }) as AnyToolbox['execute'];

  return new Proxy(toolbox, {
    get(target, property, receiver) {
      if (property === 'execute') return executeWithDefaultRequestContext;
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

function raceRequestAuthorityValidation(
  validation: boolean | Promise<boolean>,
  options: ToolboxExecuteOptions,
  runtimeServices: RuntimeServices,
): Promise<boolean> {
  const signal = options.signal;
  const deadline = options.requestContext?.deadline;
  const now = options.now ?? runtimeServices.clock.now;
  if (signal?.aborted) {
    return Promise.reject(new Error(String(signal.reason ?? 'Cancelled')));
  }
  if (deadline !== undefined && deadline <= now()) {
    return Promise.reject(new Error('Execution deadline exceeded'));
  }
  if (!signal && deadline === undefined) return Promise.resolve(validation);

  const maximumTimerDelay = 2_147_483_647;
  // AB-260: the timer-scheduling/clearing members are destructured once so
  // the call sites below read `scheduleTimeout(...)`/`clearTimeoutFunction(...)`
  // rather than a literal `timers` method call — see `create-bureau.ts`'s
  // equivalent pattern for why.
  const { setTimeout: defaultScheduleTimeout, clearTimeout: defaultCancelTimeout } =
    runtimeServices.timers;
  const setTimeoutFunction =
    options.setTimeoutFunction ??
    ((callback: () => void, milliseconds: number) =>
      defaultScheduleTimeout(callback, milliseconds));
  const clearTimeoutFunction = options.clearTimeoutFunction ?? defaultCancelTimeout;
  let timer: unknown;
  let onAbort: (() => void) | undefined;
  const interruption = new Promise<boolean>((_resolve, reject) => {
    onAbort = () => reject(new Error(String(signal?.reason ?? 'Cancelled')));
    signal?.addEventListener('abort', onAbort, { once: true });
    const scheduleDeadline = () => {
      if (deadline === undefined) return;
      const remaining = deadline - now();
      if (remaining <= 0) {
        reject(new Error('Execution deadline exceeded'));
        return;
      }
      timer = setTimeoutFunction(scheduleDeadline, Math.min(remaining, maximumTimerDelay));
    };
    scheduleDeadline();
  });
  return Promise.race([Promise.resolve(validation), interruption]).finally(() => {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    if (timer !== undefined) clearTimeoutFunction(timer);
  });
}

/**
 * Discriminate a {@link PersistenceOptions} object from a bare
 * `StorageConfiguration` or `ConditionalTextValueStore`. A `PersistenceOptions` is
 * identified by the presence of a `store` field that is itself a
 * `StorageConfiguration` object (has a `type` string discriminant).
 */
function isPersistenceOptions(value: BureauOptions['persistence']): value is PersistenceOptions {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    'store' in candidate &&
    typeof candidate['store'] === 'object' &&
    candidate['store'] !== null &&
    'type' in (candidate['store'] as Record<string, unknown>)
  );
}

/**
 * Discriminate a `StorageConfiguration` object from a `ConditionalTextValueStore`.
 * `StorageConfiguration` always carries a `type` string discriminant; a
 * `ConditionalTextValueStore` has callable `get`/`set` methods instead.
 */
function isStorageConfiguration(
  value: StorageConfiguration | Storage | ConditionalTextValueStore,
): value is StorageConfiguration {
  const candidate = value as Record<string, unknown>;
  return typeof candidate['type'] === 'string';
}

/**
 * Resolve the persistence options into a normalized `StorageConfiguration` (or
 * `undefined`) and any operational knobs for the durable engine.
 *
 * - `PersistenceOptions` → extracts `store` plus `history`/`observability`/`onLog`.
 * - Bare `StorageConfiguration` → `store` only, no extra knobs.
 * - `ConditionalTextValueStore` → KV-only, no durable storage config.
 * - `undefined` → no persistence.
 */
function resolvePersistenceOptions(options: RuntimeCompositionOptions): {
  storageConfig: StorageConfiguration | undefined;
  kvStore: ConditionalTextValueStore | undefined;
  persistenceHistory: PersistenceOptions['history'];
  persistenceObservability: PersistenceOptions['observability'];
  persistenceOnLog: PersistenceOptions['onLog'];
} {
  const { persistence } = options;

  if (persistence === undefined) {
    return {
      storageConfig: undefined,
      kvStore: undefined,
      persistenceHistory: undefined,
      persistenceObservability: undefined,
      persistenceOnLog: undefined,
    };
  }

  if (isPersistenceOptions(persistence)) {
    return {
      storageConfig: persistence.store,
      kvStore: undefined,
      persistenceHistory: persistence.history,
      persistenceObservability: persistence.observability,
      persistenceOnLog: persistence.onLog,
    };
  }

  if (isStorageConfiguration(persistence)) {
    // Bare StorageConfiguration: same as { store: persistence }
    return {
      storageConfig: persistence,
      kvStore: undefined,
      persistenceHistory: undefined,
      persistenceObservability: undefined,
      persistenceOnLog: undefined,
    };
  }

  // ConditionalTextValueStore: KV-only, no durable storage
  return {
    storageConfig: undefined,
    kvStore: persistence,
    persistenceHistory: undefined,
    persistenceObservability: undefined,
    persistenceOnLog: undefined,
  };
}

/**
 * Whether a `RunResult.finishReason` (or a Weft `WorkflowCompletedEvent.result`
 * carrying one) represents a failure outcome rather than a clean stop. Shared
 * by `monitorRecoveredScheduledFire` (create-bureau.ts, diagnostic logging for
 * a recovered fire) and the fire-terminal `schedule.completed`/`schedule.failed`
 * dispatch below (AB-223) — both must agree on what "failed" means for a
 * scheduled fire, so this lives in exactly one place.
 */
export function isRunFailureFinishReason(finishReason: unknown): boolean {
  return (
    finishReason === 'error' ||
    finishReason === 'tripwire' ||
    finishReason === 'maximum-steps' ||
    finishReason === 'elicitation-denied' ||
    finishReason === 'budget-exceeded'
  );
}

/** COR-41 — what Bureau delegates to a run when the deployment configures nothing else. */
export const DEFAULT_RUN_MEMORY_CAPABILITIES: readonly MemoryCapability[] = Object.freeze([
  'memory:search',
  'memory:write',
]);

/**
 * COR-1546 — who a run's memory belongs to. Memory is partitioned by the Bureau's deployment
 * (`tenantId`) and the run's owner of record (`ownerId`), the same pair `bureau.memory.*` builds
 * its authority from, so what a chat run remembers is what its owner's own operations list. It is
 * never the request authority's `tenantId` and `ownerId`: those are the tool-execution authority,
 * and a run that states none gets the agent's name as its owner (`normalizeRunRequestContext`).
 */
export type RunMemoryIdentity = {
  readonly runId: string;
  /** The Bureau's identifier, which is the tenant memory is partitioned under. */
  readonly tenantId: string;
  /** The run's owner of record: `anonymous:local` when none was recorded. */
  readonly ownerId: string;
};

/**
 * COR-1546 — where a run's memory is kept: the agent's identifier is the collection, so an agent
 * remembers across every chat its owner has with it, and the session that produced a record is
 * written into the record's `metadata`.
 */
export type RunMemoryTarget = {
  /** The agent's identifier. */
  readonly collection: string;
  readonly sessionId: string;
};

/**
 * COR-41 — the memory authority a run acts under, derived from its persisted
 * request authority. The delegation chain runs from Bureau (holding the
 * deployment's `runCapabilities`) through the request principal to the run, so
 * every memory record and receipt names who acted, for whom, and under which
 * authorization revision. Explicit `memory:*` capabilities on the request can
 * only narrow the deployment grant; a request that names none receives it.
 */
export function createRunMemoryAuthority(
  requestContext: ToolRequestContext,
  run: RunMemoryIdentity,
  options: BureauMemoryAuthorityOptions = {},
): MemoryAuthority {
  const deployment = options.runCapabilities ?? DEFAULT_RUN_MEMORY_CAPABILITIES;
  const known = new Set<string>(MEMORY_CAPABILITIES);
  const requested = requestContext.authority.capabilities.filter((capability) =>
    known.has(capability),
  );
  const granted =
    requested.length === 0
      ? deployment
      : deployment.filter((capability) => requested.includes(capability));
  return createMemoryAuthority({
    principal: { kind: 'run', id: run.runId },
    tenantId: run.tenantId,
    ownerId: run.ownerId,
    purpose: options.purpose ?? 'conversation-memory',
    capabilities: granted,
    policyRevision: requestContext.authority.authorizationRevision,
    projection: 'bureau',
    delegatedBy: [
      { principal: { kind: 'service', id: 'bureau' }, capabilities: deployment },
      {
        principal: memoryPrincipalFor(requestContext.authority.principalId),
        capabilities: granted,
      },
    ],
  });
}

/**
 * The memory principal behind a request authority's `principalId`. Memory
 * classifies a `service:` identity as a service, but Bureau's own service
 * principals (`system:scheduler`) live in the reserved `system:` namespace, so
 * they are named here rather than read as users.
 */
function memoryPrincipalFor(principalId: string) {
  return principalId.startsWith('system:')
    ? ({ kind: 'service', id: principalId } as const)
    : requestPrincipal(principalId);
}

function persistedScheduleMarker(input: ScheduledAgentRunInput): string | undefined {
  if (typeof input.scheduleId !== 'string') return undefined;
  const scheduleId = input.scheduleId.trim();
  return scheduleId.length > 0 ? scheduleId : undefined;
}

function hasPersistedScheduleMarker(input: ScheduledAgentRunInput): boolean {
  return persistedScheduleMarker(input) !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Weft 0.10+ native `KEYS.scheduleRun(...)` marker: an object of shape
 * `{ id, occurrence? }` written by `encodeScheduleRunMetadata` (see weft's
 * `src/core/engine/schedule-run-metadata.ts`). Pre-0.10 stores may still hold
 * the legacy plain-string marker, handled separately in
 * {@link decodeScheduleRunMarker}.
 */
function isScheduleRunMarkerObject(value: unknown): value is { id: string; occurrence?: number } {
  if (!isRecord(value)) return false;
  const { id, occurrence } = value;
  return typeof id === 'string' && (occurrence === undefined || typeof occurrence === 'number');
}

/**
 * Decode a `KEYS.scheduleRun(...)` storage value (already `decode()`d from
 * bytes) into its schedule id, accepting both the legacy plain-string marker
 * and Weft 0.10+'s `{ id, occurrence? }` metadata object. Returns `undefined`
 * when the value is neither shape, or the id is blank. The returned id is
 * always trimmed, so accidental whitespace never propagates into downstream
 * equality checks or embedded session ids.
 */
export function decodeScheduleRunMarker(decoded: unknown): string | undefined {
  if (typeof decoded === 'string') {
    const trimmed = decoded.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (isScheduleRunMarkerObject(decoded)) {
    const trimmed = decoded.id.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

/**
 * AB-240: the recovery record `bureau.run()`'s durable catalog dispatch
 * persists BEFORE starting the durable engine, keyed by the run's workflow
 * id — a marker entirely separate from (and never correlated with)
 * `sessionStore`'s `lastRunId`/`lastRunStatus`, because a catalog run never
 * owns a bureau session. `definitionRevision` is `AgentGenerationProfile.revision`
 * (operative's existing per-agent stable-revision field, read via
 * `readGenerationProfile`) at dispatch time — the closest existing "has this
 * catalog agent's definition changed" signal, reused rather than inventing a
 * new one. `input` is the ORIGINAL `AgentInput` `bureau.run(name, input)` was
 * called with: `AgentRunWorkflowInput.prompt` is NOT a substitute (it is a
 * seed-only field the durable workflow itself ignores on resume — see its own
 * doc comment), and `OPERATIVE_RESOLVE_RUN_OPTIONS` must be re-invoked with the
 * real input to rebuild `RunOptions` fresh each boot, the same way
 * `buildRunDepsFromSession` rebuilds session-owned deps from config rather
 * than a stored blob.
 */
export type CatalogRunRecoveryLoad =
  | { status: 'found'; record: CatalogRunRecoveryRecord }
  | { status: 'missing' }
  /**
   * A value is stored at the key but is not a recovery record (it does not
   * decodes but fails shape validation). It is present, so goal ownership must
   * never read it as absent; every other consumer treats it as it always did,
   * as `missing`.
   */
  | { status: 'corrupt' }
  | { status: 'read-error'; error: unknown };

/** Who a goal attempt's claim must belong to for the goal to tombstone it. */
export interface GoalAttemptClaimOwner {
  readonly goalRunId: string;
  readonly attemptIndex: number;
  readonly agentName: string;
  readonly principal: string | undefined;
}

export type GoalAttemptClaimFence = 'fenced' | 'foreign';

export interface CatalogRunRecoveryRecord {
  readonly schemaVersion: 1;
  readonly agentName: string;
  readonly definitionRevision: number;
  readonly input: AgentInput;
  /**
   * AB-241 review finding: the attributing principal `bureau.run(name, input,
   * { principal })` recorded in the live, pre-crash `runAttribution` map —
   * persisted here too so a durable catalog run that crosses a process
   * restart keeps its attribution. Without this, a resumed run's rebuilt
   * `AgentRunContext` carried no `principal` at all, so `eventHistory`'s
   * principal gate would fail closed for a run recovery re-resolves.
   * Absent when the original dispatch supplied no principal.
   */
  readonly principal?: string;
  /**
   * COR-851 — set only on the run a durable goal started for one of its
   * attempts: which goal and which attempt it was started for. A goal's run id
   * is a deterministic function of the goal, so the id alone does not prove the
   * run is the goal's; this marker, written by the goal's own start, does. A
   * goal adopts or stops an existing run only when it carries its own marker.
   */
  readonly goalAttempt?: {
    readonly goalRunId: string;
    readonly attemptIndex: number;
    /**
     * COR-851 — set when the goal ended, closed, or was canceled over this
     * attempt: the claim is tombstoned and no run may start from it or take a
     * step under it. Written only by compare-and-swap from the claim's exact
     * bytes (or created whole, where no claim existed), so a start that races
     * the tombstone either wins the claim first, and is stopped by the run's own
     * fence, or finds the tombstone and starts nothing. See `goal-attempt-fence.ts`.
     */
    readonly tombstonedAt?: string;
  };
  /**
   * COR-851 — set with `goalAttempt` and only then: the cost estimator the
   * attempt's run was started with (`null` when it declared none), written in
   * the same conditional batch as the claim. A completed attempt is priced from
   * this alone, never by resolving the agent again, so a catalog that has since
   * moved to another revision or dropped the agent cannot change what the run
   * cost. See `goal-cost-estimation.ts`.
   */
  readonly costEstimation?: GoalAttemptCostEstimation;
  /**
   * COR-1527 — set only on the run an `agent` step of a workflow file started: which instance and
   * which step it was started for. The run's id is a function of the pair, so the id alone does
   * not prove the run is the step's; this marker, written by the step's own start, does. Like a
   * goal attempt, the run is not a task.
   */
  readonly workflowStep?: {
    readonly workflowId: string;
    readonly step: number;
  };
  /**
   * COR-1524 — set only when the run is of a file-based agent: the SHA-256 of the agent file's
   * bytes the run started with. Recovery builds the agent from the snapshot stored under that
   * hash (`agent-snapshot-store.ts`), never from the file, so a run resumed after the file was
   * edited or deleted is the run that began. Absent for a code-defined agent.
   *
   * The record stays at `schemaVersion` 1, the way COR-716 widened its input: the field is
   * additive, a reader that predates it ignores it, and nothing is deployed.
   */
  readonly agentDefinitionHash?: string;
  /**
   * COR-1481 — set only when the dispatch named a context (`bureau.run(..., { sessionId })`): the
   * task's `contextId`, so a task rebuilt from this record after a crash that lost its admission
   * write is in the context the live admission would have put it in. Absent for a dispatch that
   * named none, and for a record written before the field existed; the task is then in its own
   * run's context.
   *
   * The record stays at `schemaVersion` 1, as `agentDefinitionHash` did: additive, and a reader
   * that predates it ignores it.
   */
  readonly contextId?: string;
}

// Exported for tests only — lets `runtime-composition.test.ts` construct the
// exact storage key to exercise `loadCatalogRunRecoveryRecord`'s read-error
// branch by writing malformed raw bytes directly through the durable engine's
// own `Storage` (`runtime.durable.engine.storage`), the only way to inject a
// genuine decode failure rather than a merely-absent or malformed-but-decodable
// record.
export const CATALOG_RUN_RECOVERY_KEY_PREFIX = 'bureau-catalog-run:';

function catalogRunRecoveryKey(runId: string): string {
  return `${CATALOG_RUN_RECOVERY_KEY_PREFIX}${runId}`;
}

/**
 * The input a catalog run's recovery record may hold: text, a non-empty list of
 * user text and media parts (checked with the media schemas), or `{ conversation }`.
 *
 * COR-716 widened this from text and `{ conversation }` without changing the
 * record's `schemaVersion`. The decision is that the record stays at version 1: its
 * writer and reader ship together, nothing is deployed, the project is pre-release,
 * and a widened input is additive for a reader (every record an earlier writer made
 * still passes).
 */
function isCatalogAgentInput(value: unknown): value is AgentInput {
  if (typeof value === 'string') return true;
  if (Array.isArray(value)) return isSessionInputPayload(value);
  return isRecord(value) && isRecord(value['conversation']);
}

function isCatalogRunRecoveryRecord(value: unknown): value is CatalogRunRecoveryRecord {
  if (!isRecord(value)) return false;
  if (value['schemaVersion'] !== 1) return false;
  const agentName = value['agentName'];
  if (typeof agentName !== 'string' || agentName.length === 0) return false;
  if (typeof value['definitionRevision'] !== 'number') return false;
  const principal = value['principal'];
  if (principal !== undefined && typeof principal !== 'string') return false;
  const agentDefinitionHash = value['agentDefinitionHash'];
  if (agentDefinitionHash !== undefined && typeof agentDefinitionHash !== 'string') return false;
  const contextId = value['contextId'];
  if (contextId !== undefined && typeof contextId !== 'string') return false;
  const goalAttempt = value['goalAttempt'];
  if (
    goalAttempt !== undefined &&
    !(
      isRecord(goalAttempt) &&
      typeof goalAttempt['goalRunId'] === 'string' &&
      typeof goalAttempt['attemptIndex'] === 'number' &&
      Number.isSafeInteger(goalAttempt['attemptIndex']) &&
      goalAttempt['attemptIndex'] >= 0 &&
      (goalAttempt['tombstonedAt'] === undefined || typeof goalAttempt['tombstonedAt'] === 'string')
    )
  ) {
    return false;
  }
  const workflowStep = value['workflowStep'];
  if (
    workflowStep !== undefined &&
    !(
      isRecord(workflowStep) &&
      typeof workflowStep['workflowId'] === 'string' &&
      typeof workflowStep['step'] === 'number' &&
      Number.isSafeInteger(workflowStep['step']) &&
      workflowStep['step'] >= 0
    )
  ) {
    return false;
  }
  // The estimator selection belongs to a goal attempt's record and to nothing
  // else; a goal attempt's record without one cannot be priced, so it is not valid.
  const costEstimation = value['costEstimation'];
  if (
    goalAttempt === undefined
      ? costEstimation !== undefined
      : !isGoalAttemptCostEstimation(costEstimation)
  ) {
    return false;
  }
  return isCatalogAgentInput(value['input']);
}

/**
 * The outcome of re-resolving a catalog agent's `RunOptions` during boot
 * recovery — `resolveRunServices`'s catalog branch consults
 * `catalogAgentRunOptionsResolver` (wired by `createBureau` from its own
 * agent catalog, which `createRuntimeComposition` deliberately does not know
 * about — see this file's own `RuntimeCompositionOptions` doc comment) rather
 * than reaching into the catalog directly.
 */
export type CatalogAgentRunOptionsResolution =
  | {
      status: 'resolved';
      options: RunOptions;
      definitionRevision: number;
      /**
       * COR-1367 — the agent resolved its own guardrails (`resolvesOwnGuardrails`),
       * so recovery registers no Bureau guardrail invariant on top, exactly as
       * the run's fresh dispatch did not.
       */
      agentResolvesGuardrails?: boolean;
      /**
       * COR-1577 — the run is a recovered child of another run (its resolver found a topology
       * record), which is never offered `requestHumanInput`.
       */
      recoveredChild?: boolean;
      /**
       * COR-1524 — set when the agent is file-based: the definition the options were resolved
       * from, which is the snapshot a recorded run asked for, or the file's current definition
       * for a run that is starting.
       */
      agentBinding?: FileAgentBinding;
    }
  | { status: 'missing-agent' }
  /**
   * The named agent exists in the catalog but does not (or no longer)
   * expose AB-21's `OPERATIVE_RESOLVE_RUN_OPTIONS` — distinct from
   * `'missing-agent'` (review finding: conflating the two produced the
   * misleading "is no longer in the catalog" reason for an agent that
   * genuinely IS still there, just not durable-resolution-capable). This is
   * reachable at recovery even though live dispatch only reaches the
   * durable branch for a resolver-exposing agent: the catalog can be
   * reconfigured between restarts to swap the same name to a different
   * `RunnableAgent` that lacks the capability.
   */
  | { status: 'not-durable-capable' }
  | { status: 'resolver-failed'; error: unknown };

export type CatalogAgentRunOptionsResolver = (
  agentName: string,
  input: AgentInput,
  context: AgentRunContext,
  /**
   * COR-772 — the recovered workflow's run identifier, so a resolver can
   * restore run-scoped context the recovery record does not carry (a
   * recovered child's parent-signal port and correlation).
   */
  runId: string,
  /**
   * COR-1524 — present when the run already started and is being resumed: the definition hash it
   * recorded, or `undefined` for a code-defined agent. A hash makes the resolver build the agent
   * from the run's snapshot; absent altogether means a run that is starting, which resolves the
   * agent as it is now.
   */
  recorded?: CatalogRunRecordedDefinition,
) => Promise<CatalogAgentRunOptionsResolution>;

/**
 * COR-1577 — a catalog agent resolved for a session run: the run options its own definition
 * resolves, which a session run reads its `generate`, toolbox, hooks, stop conditions and step
 * and token caps from, and the system prompt its definition would seed a new conversation with.
 */
export interface SessionAgentRun {
  readonly agentName: string;
  readonly options: RunOptions;
  readonly definitionRevision: number;
  /** COR-1524 — the file definition the run is built from, when the agent is file-based. */
  readonly agentBinding?: FileAgentBinding;
  readonly agentResolvesGuardrails: boolean;
  /** The agent's own system prompt, or `undefined` when its definition declares none. */
  readonly instructions: string | undefined;
}

export type SessionAgentRunResolution =
  | { status: 'resolved'; run: SessionAgentRun }
  | Exclude<CatalogAgentRunOptionsResolution, { status: 'resolved' }>;

/** The text of the first system message `options.conversation` carries, or `undefined`. */
function agentInstructionsFromRunOptions(options: RunOptions): string | undefined {
  const history =
    options.conversation instanceof Conversation
      ? options.conversation.current
      : options.conversation;
  const content = getFirstSystemMessage(history)?.content;
  if (typeof content === 'string') return content;
  if (content === undefined) return undefined;
  const text = content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
    .trim();
  return text.length === 0 ? undefined : text;
}

/** The input a session run resolves its agent with; the run's own conversation replaces it. */
const SESSION_AGENT_PLACEHOLDER_INPUT = 'session run';

/** The default agent a run with no `agentName` belongs to; it has no catalog entry. */
const BUREAU_AGENT_NAME = 'bureau';

/** Session metadata: the definition revision of the named agent the latest run started under. */
export const SESSION_AGENT_REVISION_METADATA_KEY = 'lastAgentRevision';

/**
 * COR-1524 — where a session run records the SHA-256 of the agent file it started with (`null`
 * for a code-defined agent), so a recovered run builds from its snapshot.
 */
export const SESSION_AGENT_DEFINITION_HASH_METADATA_KEY = 'lastAgentDefinitionHash';

/**
 * COR-1524, COR-1584 — the definition a run being resumed recorded: the hash of the agent file it
 * started with (`undefined` for a code-defined agent), and the definition revision it started at
 * (`undefined` when its record names none). The resolver rebuilds a file agent from the snapshot
 * under the hash, and the rebuilt agent reports the revision, not the revision the file has
 * reached since: one snapshot is keyed by content, so it can have been several revisions.
 */
export interface CatalogRunRecordedDefinition {
  readonly agentDefinitionHash: string | undefined;
  readonly definitionRevision?: number | undefined;
}

/**
 * COR-1584 — the definition revision a session's metadata recorded for the definition at `hash`.
 * A session's metadata names its latest run's definition only, so the revision is the run's own
 * only when the hash is the one the metadata names; any other run's revision is not recorded
 * there, and the caller gets `undefined`.
 */
export function sessionRecordedRevision(
  metadata: Readonly<Record<string, unknown>>,
  hash: unknown,
): number | undefined {
  const revision = metadata[SESSION_AGENT_REVISION_METADATA_KEY];
  return typeof hash === 'string' &&
    metadata[SESSION_AGENT_DEFINITION_HASH_METADATA_KEY] === hash &&
    typeof revision === 'number'
    ? revision
    : undefined;
}

type RecoveredScheduleMarker =
  | { status: 'found'; scheduleId: string }
  | { status: 'missing'; sessionId?: string }
  | { status: 'read-error'; error: unknown; sessionId?: string };

function recoveredMarkerSessionId(marker: RecoveredScheduleMarker | undefined): string | undefined {
  return marker?.status === 'found' ? undefined : marker?.sessionId;
}

function lastScheduledFirePromptIndex(history: ConversationHistory, runId: string): number {
  for (let index = history.ids.length - 1; index >= 0; index -= 1) {
    const message = history.messages[history.ids[index]!];
    if (message?.role === 'user' && message.metadata['scheduledFireRunId'] === runId) {
      return index;
    }
  }
  return -1;
}

function removeConversationIndexRange(
  history: ConversationHistory,
  startIndex: number,
  endIndex: number,
): ConversationHistory {
  const ids = history.ids.filter((_, index) => index < startIndex || index > endIndex);
  const messages: Record<string, ConversationHistory['messages'][string]> = {};
  for (const [position, id] of ids.entries()) {
    const message = history.messages[id];
    if (message) messages[id] = { ...message, position };
  }
  return { ...history, ids, messages };
}

export function removeLastScheduledFireTranscript(
  history: ConversationHistory,
  runId: string,
): ConversationHistory {
  const promptIndex = lastScheduledFirePromptIndex(history, runId);
  if (promptIndex === -1) return history;
  const nextUserIndex = history.ids.findIndex((id, index) => {
    if (index <= promptIndex) return false;
    return history.messages[id]?.role === 'user';
  });
  const endIndex = nextUserIndex === -1 ? history.ids.length - 1 : nextUserIndex - 1;
  return removeConversationIndexRange(history, promptIndex, endIndex);
}

function redactProvider(provider: ProviderConfiguration): RedactedProviderConfiguration {
  const { apiKey: _apiKey, ...safeProvider } = provider;
  return safeProvider;
}

/**
 * Inject recalled memory on step 0 through governed memory's mandatory recall
 * admission (COR-41). Only records the run's authority may search, whose trust
 * meets the policy minimum for their class, and that pass the recall detectors
 * reach the conversation, and they arrive inside a labeled evidence envelope
 * whose content cannot close the envelope or claim authority. A record a
 * detector trips on is quarantined instead.
 *
 * Replay classification (seam #11): `effectful`, because recall admission
 * writes to the governance ledger and can quarantine a poisoned record. Both
 * effects are idempotent under a recovery re-fire: the durable workflow
 * rehydrates a fresh `Conversation.from(snapshot)` per step, so the re-fire
 * re-injects into that step's conversation, a record quarantined the first
 * time is simply absent the second, and the ledger records the second recall
 * that genuinely happened.
 */
export function createMemoryRecallHook(
  memory: GovernedMemory,
  authority: MemoryAuthority,
  target: RunMemoryTarget,
): PrepareStepHook {
  return async (context) => {
    if (context.step !== 0) {
      return;
    }

    // The current prompt, whatever its shape: a string, or the text parts of a
    // part array (COR-716). Recall never runs against an older message because
    // the current one carries media, and a prompt with no text recalls nothing.
    const messages = context.conversation.getMessages();
    const latestUserMessage = messages.findLast((message) => message.role === 'user');
    const query = latestUserMessage === undefined ? '' : messageText(latestUserMessage);
    if (query.trim() === '') {
      return;
    }

    const bundle = await memory.recallForModel(authority, query, {
      collection: target.collection,
      limit: 5,
      contextId: authority.principal.id,
    });

    if (bundle.evidence.length === 0) {
      return;
    }

    context.conversation.appendSystemMessage(bundle.rendered, {
      [MEMORY_EVIDENCE_METADATA_KEY]: {
        sessionId: target.sessionId,
        recordIds: bundle.evidence.map((item) => item.id),
        withheld: bundle.withheld,
      },
    });
  };
}

/**
 * Persist the final assistant content of a step as governed memory (COR-41).
 * Assistant output is ordinary conversation, so it is admitted as an untrusted
 * `conversation` write under the run's memory authority: it is scanned, quota
 * checked, and quarantined when poisoned, and its record carries the run's full
 * attribution. A refused or quarantined write is recorded in the governance
 * ledger, not surfaced to the run.
 *
 * EFFECTFUL hook (seam #11): a step can run more than once, so this hook can
 * fire AGAIN for the same step. A durable recovery re-runs the crashed in-flight
 * step from its boundary, and a requeued scheduler task either resumes from its
 * last completed step (durable engine) or starts again (no engine). The
 * mitigation is IDEMPOTENCY, not suppression-on-replay — suppressing the hook
 * would drop the write for a step whose work (generate + tools) did re-execute,
 * leaving memory out of sync with a step that ran.
 *
 * Idempotency is enforced by a DETERMINISTIC operation key, not by content: a
 * replayed step may produce non-byte-identical content (its `generate` re-runs).
 * The write uses a stable `dedupeKey` of `${runId}:${step}` (the operation's
 * identity — same run, same step index across a replay), so a re-fire is an
 * atomic no-op regardless of content drift.
 *
 * Every run Bureau composes passes a `runId`: the run id for `createRun` runs,
 * schedule fires, and recovered runs, and the task id for a
 * `submitSchedulerTask` task, which stays the same across preemption and
 * requeue. Without a `runId` the write carries no dedupe key and a repeated step
 * stores its answer again, so omit it only for a step that cannot run twice.
 *
 * `replay: 'effectful'` ({@link HookReplayPolicy}) is recorded on the write for
 * diagnostics; it documents the contract and never gates execution.
 */
export function createMemoryPersistHook(
  memory: GovernedMemory,
  authority: MemoryAuthority,
  target: RunMemoryTarget,
  runId?: string,
  /**
   * Told of a write governed memory rejected (a quota, a content rule, a missing capability), which
   * stores no record and so leaves nothing else to say the answer was not remembered (COR-1546).
   * Receives the receipt, which names a reason and never the content.
   */
  onRejected?: (receipt: MemoryWriteReceipt) => void,
): OnStepHook {
  return async (context) => {
    if (!context.final || !context.content.trim()) {
      return;
    }

    // Deterministic identity of THIS durable operation: same run + same step
    // index on a replay. Content-independent, so a divergent regenerate cannot
    // produce a second record.
    const dedupeKey = runId === undefined ? undefined : `${runId}:${context.step}`;

    const receipt = await memory.write(authority, context.content, {
      collection: target.collection,
      source: 'conversation',
      memoryClass: 'episodic',
      // Replay classification (seam #11): an external write → `effectful`, kept
      // safe across a recovery re-fire by the atomic dedupeKey write. Metadata
      // only; never gates execution. The collection is the agent, so no record or
      // event names the chat that produced it any more (COR-1546): `sessionId` is how
      // the Memory page shows where a memory came from.
      metadata: {
        step: context.step,
        replay: 'effectful' satisfies HookReplayPolicy,
        sessionId: target.sessionId,
      },
      ...(dedupeKey === undefined ? {} : { dedupeKey }),
    });
    if (receipt.status === 'rejected') onRejected?.(receipt);
  };
}

export function resolveProviderGenerate(
  provider: ProviderConfiguration,
  streamEventTarget: TypedEventTarget<StreamEventMap> | undefined,
  streamingConfiguration: BureauOptions['streaming'],
): GenerateFunction {
  if (streamEventTarget) {
    switch (provider.provider) {
      case 'anthropic':
        return withEnhancedStreaming(createAnthropicProviderStream(provider), {
          eventTarget: streamEventTarget,
          onTextDelta: streamingConfiguration?.onTextDelta,
        });
      case 'openai':
        return withEnhancedStreaming(createOpenAIProviderStream(provider), {
          eventTarget: streamEventTarget,
          onTextDelta: streamingConfiguration?.onTextDelta,
        });
      case 'gemini':
        return withEnhancedStreaming(createGeminiProviderStream(provider), {
          eventTarget: streamEventTarget,
          onTextDelta: streamingConfiguration?.onTextDelta,
        });
      default:
        break;
    }
  }

  switch (provider.provider) {
    case 'anthropic':
      return createAnthropicProvider(provider);
    case 'openai':
      return createOpenAIProvider(provider);
    case 'gemini':
      return createGeminiProvider(provider);
    default:
      throw new Error(`Unknown provider: ${String(provider.provider)}`);
  }
}

type RoutingResult =
  | { kind: 'direct'; strategy: ReturnType<typeof createStepBasedStrategy> }
  | {
      kind: 'cost-aware';
      strategy: ReturnType<typeof createCostAwareStrategy>;
      onUsage: (usage: { total: number } | undefined) => void;
    };

function createCostAwareRoutingStrategy(
  configuration: Extract<RoutingConfiguration, { type: 'cost-aware' }>,
): RoutingResult {
  let spent = 0;
  return {
    kind: 'cost-aware',
    strategy: createCostAwareStrategy({
      cheap: configuration.cheap,
      expensive: configuration.expensive,
      thresholdRatio: configuration.thresholdRatio ?? 0.8,
      getBudgetState: () => ({ spent, budget: configuration.budget }),
    }),
    onUsage(usage: { total: number } | undefined) {
      spent += usage?.total ?? 0;
    },
  };
}

export function createRoutingStrategy(configuration: RoutingConfiguration): RoutingResult {
  switch (configuration.type) {
    case 'step-based':
      return {
        kind: 'direct',
        strategy: createStepBasedStrategy({
          first: configuration.first,
          middle: configuration.middle,
          last: configuration.last,
          middleAfterStep: configuration.middleAfterStep,
        }),
      };
    case 'complexity':
      return {
        kind: 'direct',
        strategy: createComplexityStrategy({
          simple: configuration.simple,
          complex: configuration.complex,
          frontier: configuration.frontier,
          scorer(signals) {
            const useSimple =
              signals.toolCount <= (configuration.simpleMaxTools ?? 2) &&
              signals.lastMessageLength <= (configuration.simpleMaxLength ?? 500);
            if (useSimple) return 'simple';

            const useFrontier =
              configuration.frontier !== undefined &&
              configuration.frontier !== '' &&
              signals.conversationDepth > 20;
            return useFrontier ? 'frontier' : 'complex';
          },
        }),
      };
    case 'cost-aware':
      return createCostAwareRoutingStrategy(configuration);
  }
}

/**
 * Reports each response's usage to `onUsage`. The wrapper carries the inner
 * function's backend descriptors (COR-716): media admission costs parts against
 * them, and a wrapper that dropped them would refuse every part as `no-estimator`.
 */
export function withUsageTracking(
  generate: GenerateFunction,
  onUsage: (usage: { total: number } | undefined) => void,
): GenerateFunction {
  const tracked: GenerateFunction = async (context) => {
    const response = await generate(context);
    onUsage(response.usage);
    return response;
  };
  return withBackendDescriptors(tracked, readBackendDescriptors(generate));
}

export function applyCache(
  generate: GenerateFunction,
  configuration: CacheConfiguration | undefined,
  store: TextValueStore | undefined,
): GenerateFunction {
  if (!configuration) {
    return generate;
  }

  const cacheStore = configuration.store ?? store;
  if (configuration.enabled === false || !cacheStore) {
    return generate;
  }

  return withCache(generate, {
    ...configuration,
    store: cacheStore,
  });
}

/**
 * Who keeps the managed assets a run's rows reference (COR-1581): the session the run writes into,
 * or, for a run with no session, the run itself.
 */
export type MediaRowHolder = 'session' | 'run';

export type RuntimeCompositionDependencies = {
  resolveProviderGenerate: typeof resolveProviderGenerate;
  /**
   * Builds the session store this composition uses over its resolved KV
   * view. Defaults to operative's own `createSessionStore` — the real
   * production wiring. A caller (test or platform package) that supplies a
   * different `SessionStore` implementation here does so through the SAME
   * non-test-gated dependency-injection parameter `resolveProviderGenerate`
   * already establishes, not a retired test-only seam: this package's own
   * test suite uses it to exercise `resolveRunServices`' failure-handling
   * branches (a store whose `load`/`updateMetadata` fails) without a
   * private mutation backdoor.
   */
  createSessionStore?: typeof createSessionStore;
  /**
   * COR-718 — `CreateSessionStoreOptions.beforeCleanup` for the session store this
   * composition builds: told which sessions `cleanup()` is about to expire, before
   * they are removed, and able to keep them by rejecting. `createBureau` records
   * each one's owner for its deletion's audit entry.
   */
  beforeSessionCleanup?: ((sessions: readonly AgentSession[]) => Promise<void>) | undefined;
  /**
   * COR-851 — the durable `goalRun` workflow, registered on the durable engine
   * beside `agentRun`. `createBureau` supplies it; the engine is built before
   * the goal store and the agent catalog exist, so the workflow's ports are
   * bound after composition (see `createGoalWorkflowHost`).
   */
  goalWorkflow?: AnyWorkflowDefinition;
  /**
   * COR-851 — the self-fence a goal attempt's run is registered with, on a fresh
   * start and on recovery alike. `createBureau` supplies a late-bound one, since
   * the goal store it reads does not exist yet; a composition with none runs
   * goal attempts unfenced and has no goals to overtake them.
   */
  goalAttemptFence?: GoalAttemptFence;
  /**
   * COR-1586 — the caller will wire the catalog agent run options resolver
   * (`setCatalogAgentRunOptionsResolver`) once it has built the catalog the resolver reads, which
   * is after this composition exists and after the engine has started reclaiming runs. Set, every
   * reader of the resolver waits while it is unset, instead of answering that it is not
   * configured: that answer is a terminal failure for a run, or a resume under the wrong agent.
   * A caller that wires the resolver itself, or none, leaves this unset and gets the answer at once.
   * `createBureau` sets it, and calls `abandonCatalogAgentRunOptionsResolver` if it will never wire
   * the resolver.
   */
  awaitsCatalogAgentRunOptionsResolver?: boolean;
  /**
   * COR-1510 — the engine's recovery hook, installed when the engine is created. The engine
   * reclaims and resumes runs whose claim has lapsed on its own interval, which can be before
   * `createBureau` calls `recoverAll()` with its hook; a run resumed that way must reach the same
   * hook before its first step, or the bureau never sees that step. `createBureau` supplies a
   * late-bound one that waits until its recovery has started.
   */
  onRecoveredWorkflow?: RecoverAllOptions['onRecoveredWorkflow'];
  /**
   * COR-718 — called when a schedule fire's services are built, with the fire's
   * run, its schedule, and the schedule's owner. `createBureau` records the
   * fire's owner and its `schedule.fired` audit entry here. A fire is rebuilt on
   * recovery, so this can run more than once for one fire; the hook is
   * responsible for recording once.
   */
  onScheduledFire?: (fire: ScheduledFireNotice) => void | Promise<void>;
  /**
   * COR-1482 — called once a schedule fire's run has ended, however it ended: completed, failed,
   * or canceled. `createBureau` settles the fire's task here.
   */
  onScheduledFireSettled?: (settlement: ScheduledFireSettlement) => void | Promise<void>;
  /**
   * COR-1482 — called when a fire's session is known: found when the fire's services are built,
   * or saved by the fire's first step, which is when a fresh session first gets its incarnation.
   * `createBureau` binds the fire's task to it, so the task is found by its context.
   */
  onScheduledSessionKnown?: (session: ScheduledSessionNotice) => void | Promise<void>;
  /**
   * COR-1596 — called once a schedule fire's services are built and before the fire runs, with
   * the services themselves: on a live tick and on a recovered fire alike, because the engine
   * rebuilds a fire's services the same way for both. `createBureau` registers the fire's human
   * waits and tool approvals as pending reviews here, which needs the services' emitter and
   * toolbox. A host that cannot register them is diagnosed and the fire still runs.
   */
  onScheduledFireServices?: (
    fire: ScheduledFireServicesNotice,
    services: DurableRunDeps,
  ) => void | Promise<void>;
  /**
   * COR-1527 — whether `type` is a workflow Bureau registered from a workflow file. An instance of
   * one needs no services: its steps are the host's activities, and its fire or its recovery must
   * not be answered "unrecognized workflow type". Late-bound by the caller, since the workflow
   * files are read after the composition exists.
   */
  isWorkflowFileType?: (type: string) => boolean;
  /**
   * COR-716 — the {@link ContentSourceResolver} a run owned by `principalId` is
   * given, so a managed asset in its input reaches a provider as bytes or a
   * provider-fetched URL. `createBureau` supplies one over its asset service; a
   * composition with none leaves such a part to fail admission, typed, before any
   * provider call. Late-bound by the caller: the asset service is built after this
   * composition, and a run resolves it only when it starts.
   */
  contentSourceResolverFor?: (principalId: string | undefined) => ContentSourceResolver | undefined;
  /**
   * COR-713: the media-admission port of a run's owning principal, built from the asset service
   * like {@link RuntimeCompositionDependencies.contentSourceResolverFor}. Without an asset service
   * a run has no port, and a generated media part fails typed at its admission point.
   */
  generatedMediaAdmitterFor?: (
    principalId: string | undefined,
    rowHolder: MediaRowHolder,
  ) => GeneratedMediaAdmitter | undefined;
};

/** What {@link RuntimeCompositionDependencies.onScheduledFire} is told about one fire. */
export type ScheduledFireNotice = {
  readonly runId: string;
  readonly scheduleId: string | undefined;
  readonly sessionId: string;
  readonly agentName: string;
  /** The schedule's owner of record, which also owns this fire's run and, if it creates one, its session. */
  readonly owner: string;
  /** The text the fire delivers to its agent: the originating message of the fire's task. */
  readonly message: string;
};

/** What {@link RuntimeCompositionDependencies.onScheduledFireSettled} is told about one fire. */
export type ScheduledFireSettlement = {
  readonly runId: string;
  readonly status: 'completed' | 'failed' | 'canceled';
  readonly finishReason: string | undefined;
  /** Why the fire failed, when it did and the engine said. */
  readonly error: string | undefined;
  /** The fire's answer, when it completed with one. */
  readonly content: string | undefined;
};

/** What {@link RuntimeCompositionDependencies.onScheduledFireServices} is told about one fire. */
export type ScheduledFireServicesNotice = {
  readonly runId: string;
  readonly sessionId: string;
  readonly agentName: string;
  /** The request context the fire runs under, which a later approval of its tool resumes under. */
  readonly requestContext: ReturnType<typeof createSchedulerServiceRequestContext>;
};

/** What {@link RuntimeCompositionDependencies.onScheduledSessionKnown} is told. */
export type ScheduledSessionNotice = {
  readonly runId: string;
  readonly sessionId: string;
  readonly incarnation: string;
};

const defaultRuntimeCompositionDependencies: RuntimeCompositionDependencies = {
  resolveProviderGenerate,
  createSessionStore,
};

/** The run options through which Bureau governs the media a run carries (COR-716). */
export type MediaRunOptions = Pick<
  RunOptions,
  'contentSourceResolver' | 'assetSafety' | 'generatedMediaAdmitter'
>;

/**
 * The media options Bureau contributes to a run that already has its own: whichever of
 * the two the run left unset. An agent that supplied its own resolver or its own
 * unverified-asset policy keeps it.
 */
export function unsetMediaOptions(run: MediaRunOptions, bureau: MediaRunOptions): MediaRunOptions {
  return {
    ...(run.contentSourceResolver === undefined && bureau.contentSourceResolver !== undefined
      ? { contentSourceResolver: bureau.contentSourceResolver }
      : {}),
    ...(run.assetSafety === undefined && bureau.assetSafety !== undefined
      ? { assetSafety: bureau.assetSafety }
      : {}),
    ...(run.generatedMediaAdmitter === undefined && bureau.generatedMediaAdmitter !== undefined
      ? { generatedMediaAdmitter: bureau.generatedMediaAdmitter }
      : {}),
  };
}

/**
 * COR-1577 — the media options of a session run: Bureau's for the run's owner, except where the
 * named agent supplied its own resolver or unverified-asset policy, as on a catalog dispatch.
 */
export function sessionRunMediaOptions(
  sessionAgent: SessionAgentRun | undefined,
  bureau: MediaRunOptions,
): MediaRunOptions {
  if (sessionAgent === undefined) return bureau;
  const { contentSourceResolver, assetSafety, generatedMediaAdmitter } = sessionAgent.options;
  return {
    ...(contentSourceResolver === undefined ? {} : { contentSourceResolver }),
    ...(assetSafety === undefined ? {} : { assetSafety }),
    ...(generatedMediaAdmitter === undefined ? {} : { generatedMediaAdmitter }),
    ...unsetMediaOptions(sessionAgent.options, bureau),
  };
}

function messagesAreEqual(
  left: ConversationHistory['messages'][string],
  right: ConversationHistory['messages'][string],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function appendConversationMessages(
  current: ConversationHistory,
  candidate: ConversationHistory,
  base: ConversationHistory,
): ConversationHistory {
  const baseIds = new Set(base.ids);
  const candidateIds = new Set(candidate.ids);
  const currentIds = new Set(current.ids);
  const currentPreservedIds = current.ids.filter((id) => candidateIds.has(id) || !baseIds.has(id));
  const candidateOnlyIds = candidate.ids.filter((id) => !currentIds.has(id));
  const ids = [...currentPreservedIds, ...candidateOnlyIds];
  const messages: Record<string, ConversationHistory['messages'][string]> = {};

  for (const id of ids) {
    const candidateMessage = candidate.messages[id];
    const baseMessage = base.messages[id];
    const message =
      candidateMessage &&
      (!baseMessage || !messagesAreEqual(candidateMessage, baseMessage) || !current.messages[id])
        ? candidateMessage
        : (current.messages[id] ?? candidateMessage);
    if (message) messages[id] = message;
  }

  for (const [position, id] of ids.entries()) {
    const message = messages[id];
    if (message) messages[id] = { ...message, position };
  }

  return {
    ...current,
    metadata: {
      ...current.metadata,
      ...candidate.metadata,
    },
    ids,
    messages,
    updatedAt: candidate.updatedAt,
  };
}

const activeSkillsStepMetadataKey = '__bureauActiveSkills';
const activeSkillsStepMetadataVersion = 2;

function activeSkillsStepMetadata(records: readonly SkillActivationRecord[]): JSONValue {
  return {
    version: activeSkillsStepMetadataVersion,
    entries: records as unknown as JSONValue,
  };
}

export function activeSkillsFromStepMetadata(
  metadata: StepRecord['metadata'],
): SkillActivationRecord[] | undefined {
  const raw = metadata?.[activeSkillsStepMetadataKey];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const snapshot = raw as Record<string, unknown>;
  if (snapshot['version'] !== activeSkillsStepMetadataVersion) return undefined;
  const entries = snapshot['entries'];
  return isSkillActivationRecordArray(entries) ? entries : undefined;
}

/**
 * Validates a value read back out of session or step metadata as activation records.
 *
 * Every digest field is required, not optional. A record missing one would recover a skill by name
 * with nothing to check the content against, which is the failure the records exist to prevent —
 * so a malformed snapshot recovers nothing rather than recovering unverifiably.
 */
export function isSkillActivationRecordArray(value: unknown): value is SkillActivationRecord[] {
  if (!Array.isArray(value)) return false;
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return false;
    const candidate = item as Record<string, unknown>;
    for (const field of [
      'name',
      'sourceId',
      'sourceKind',
      'trust',
      'artifactDigest',
      'instructionsDigest',
      'activatedAt',
    ]) {
      if (typeof candidate[field] !== 'string') return false;
    }
    if (typeof candidate['catalogRevision'] !== 'number') return false;
    if (!Array.isArray(candidate['requestedTools'])) return false;
    if (candidate['requestedTools'].some((tool) => typeof tool !== 'string')) return false;
  }
  return true;
}

/**
 * The session-metadata keys a step boundary writes.
 *
 * The same keys {@link createSkillRecordSnapshotHook} writes, deliberately: one snapshot
 * mechanism, one set of keys, one thing for recovery to read. Two parallel snapshots is how a
 * recovered run ends up restoring whichever of them the reader happened to know about.
 */
function activeSkillSessionMetadataForStep(
  records: readonly SkillActivationRecord[],
  step: number,
  runId?: string,
): Record<string, JSONValue> {
  return {
    activeSkillRecords: records as unknown as JSONValue,
    ...(runId !== undefined
      ? {
          activeSkillRecordsRunId: runId,
          activeSkillRecordsStep: step,
        }
      : {}),
  };
}

/**
 * What the active-skill snapshot of a run says (COR-1620). `verified` with no records is a
 * verified absence of skills. `unverifiable` is the snapshot failing to be read or deserialized,
 * or naming another run: the policy that governed the run is not known.
 */
export type SkillSnapshot =
  | { readonly status: 'verified'; readonly records: SkillActivationRecord[] | undefined }
  | { readonly status: 'unverifiable'; readonly reason: string };

/** The outcome of re-validating stored skill records against the live catalog. */
export interface SkillRecoveryOutcome {
  readonly recovered: readonly string[];
  readonly refused: readonly string[];
}

/** A snapshot field named in a reason: its string, or what the field holds instead. */
function describe(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : value === null ? 'null' : 'nothing';
}

/**
 * What a recovered run's toolbox was rebuilt with (COR-1620), kept with the toolbox that was
 * built. A restored approval, a replayed fire and a reattached session run are all built by
 * recovery, and each is decided under the snapshot read again at approve time, never under the
 * toolbox as it was built.
 */
export interface RecoveredSkillPolicy {
  readonly scheduledFire: boolean;
  readonly agentName: string;
  readonly sessionAgent: SessionAgentRun | undefined;
  /** The records the toolbox was built with, as JSON. */
  readonly recordsKey: string;
  /** Whether the snapshot was verified and every stored skill recovered. */
  readonly recoveredCleanly: boolean;
}

const recoveredSkillPolicies = new WeakMap<object, RecoveredSkillPolicy>();

/** Records what recovery built `toolbox` with. */
export function recordRecoveredSkillPolicy(toolbox: object, policy: RecoveredSkillPolicy): void {
  recoveredSkillPolicies.set(toolbox, policy);
}

/** What recovery built `toolbox` with, or `undefined` for a toolbox it did not build. */
export function recoveredSkillPolicyOf(toolbox: object): RecoveredSkillPolicy | undefined {
  return recoveredSkillPolicies.get(toolbox);
}

export function recordedAgentStep(value: unknown): StepRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate['conversationSnapshot'] !== 'object' ||
    candidate['conversationSnapshot'] === null
  ) {
    return undefined;
  }
  if (typeof candidate['nextAccumulators'] !== 'object' || candidate['nextAccumulators'] === null) {
    return undefined;
  }
  const record = candidate['record'];
  if (typeof record !== 'object' || record === null) return undefined;
  const stepRecord = record as Record<string, unknown>;
  const step = stepRecord['step'];
  if (!Number.isInteger(step) || (step as number) < 0) return undefined;
  if (typeof stepRecord['content'] !== 'string') return undefined;
  // COR-713: only a current-version step record counts; an older one carries no parts.
  if (stepRecord['schemaVersion'] !== 2 || !Array.isArray(stepRecord['parts'])) return undefined;
  if (!Array.isArray(stepRecord['toolCalls'])) return undefined;
  if (!Array.isArray(stepRecord['results'])) return undefined;
  if (typeof stepRecord['final'] !== 'boolean') return undefined;
  if (
    stepRecord['metadata'] !== undefined &&
    (typeof stepRecord['metadata'] !== 'object' ||
      stepRecord['metadata'] === null ||
      Array.isArray(stepRecord['metadata']))
  ) {
    return undefined;
  }
  return record as StepRecord;
}

/**
 * Snapshot the active skill set to session metadata after each completed step.
 *
 * EFFECTFUL hook (seam #11): on a durable recovery the crashed in-flight step
 * re-runs from its boundary, so this hook can fire AGAIN for the same step. The
 * write is IDEMPOTENT — a re-fire for step N overwrites `activeSkillRecords` with the
 * same value (completed steps do not re-run their tool executions, so the active-skill
 * set is unchanged on replay). This is a state snapshot, NOT an append — the last
 * writer wins (matching the single-source-of-truth model for `activeSkillRecords`).
 *
 * Replay classification: `effectful` (writes to external storage) but SAFE across
 * recovery re-fires because the payload is deterministic for a given step boundary
 * (completed steps replay identically, producing the same active-skill set).
 */
/**
 * Snapshots the catalog revision and every activation record after each step.
 *
 * The provider-backed snapshot carries a name and a tool policy. That is enough to re-activate
 * something with the same name and nothing at all to prove it is the same skill — COR-752 named
 * exactly this gap ("neither carries source, trust decision, digest, or admitted instructions").
 * These records carry the source, the trust decision, the artifact digest and the instructions
 * digest, which is what lets recovery refuse a skill whose content drifted rather than silently
 * resurrecting different text under a reviewed name.
 */
function createSkillRecordSnapshotHook(
  client: { activationRecords(): readonly SkillActivationRecord[] },
  catalog: { revision: number; digest: string },
  sessionId: string,
  store: SessionStore,
  runId?: string,
): OnStepHook {
  return async (context) => {
    try {
      await store.updateMetadata(sessionId, {
        activeSkillRecords: client.activationRecords() as unknown as JSONValue,
        skillCatalogRevision: catalog.revision,
        skillCatalogDigest: catalog.digest,
        ...(runId === undefined
          ? {}
          : { activeSkillRecordsRunId: runId, activeSkillRecordsStep: context.step }),
      });
    } catch {
      // Non-fatal, same as the entry-based hook: a failed snapshot must not abort the step. The
      // cost is that recovery starts from an empty active set, which is the safe direction.
    }
  };
}

function createUnavailableToolbox(): BureauToolbox {
  const emptyToolbox = createToolbox([], { context: {} });
  const execute = ((
    toolCalls: ToolCallInput | ToolCallInput[],
    executionOptions?: Parameters<BureauToolbox['execute']>[1],
  ) => {
    const normalizedToolCalls = Array.isArray(toolCalls) ? toolCalls : [toolCalls];
    if (normalizedToolCalls.length > 0) {
      throw new Error('No toolbox configured but tool calls were received');
    }

    return emptyToolbox.execute([], executionOptions);
  }) as unknown as BureauToolbox['execute'];

  return {
    ...emptyToolbox,
    execute,
  };
}

/**
 * The durable run engine + checkpoint store, plus the optional observability
 * handle. `observability` is present only when `BureauOptions.observability` was
 * enabled; its `dispose` MUST be called before `engine[Symbol.dispose]()` so the
 * engine's terminal lifecycle events still reach the span-closing listeners.
 */
export interface DurableComposition {
  engine: RegistryAgnosticEngine;
  checkpointStore: CheckpointStore;
  observability?: RunEngineObservability | undefined;
}

/**
 * The schedule-fire events dispatched onto
 * {@link RuntimeComposition.scheduleFireEvents}: the two fire-terminal
 * outcomes (AB-223) and the two per-tick observation signals (COR-660) that
 * report an occurrence the overlap policy attempted and, when it collided,
 * dropped.
 */
export interface ScheduleFireEventMap extends EventMap {
  [ScheduleCompletedEvent.type]: ScheduleCompletedEvent;
  [ScheduleFailedEvent.type]: ScheduleFailedEvent;
  [ScheduleAttemptedEvent.type]: ScheduleAttemptedEvent;
  [ScheduleSkippedEvent.type]: ScheduleSkippedEvent;
}

export interface RuntimeComposition {
  kv: ConditionalTextValueStore | undefined;
  /**
   * The durable run engine + checkpoint store, present whenever durable
   * execution resolves on (by default: a persistent `storage` backend is
   * configured and `durableExecution` is not explicitly `false`). When present,
   * `createBureau` routes every `createRun()` through it transparently — the run
   * surface is unchanged, but the run is checkpointed and resumes after a crash.
   */
  durable: DurableComposition | undefined;
  /**
   * Dispatches `ScheduleCompletedEvent`/`ScheduleFailedEvent` (AB-223) for
   * every scheduled fire's terminal outcome, live or recovered. Populated by a
   * `durable.engine` `workflow:completed`/`workflow:failed` listener,
   * correlated against the `scheduleId` recorded in `buildScheduledRunServices`
   * when that fire's deps were built — the map entry it reads is deleted the
   * instant this fires, so exactly one event dispatches per fire regardless of
   * whether it settled as a live tick or was recovered on boot (both routes
   * settle through this same Weft engine terminal event). `createBureau`
   * forwards each event onto the bureau's own `emitter` (scheduled fires are
   * headless — there is no per-run emitter to dispatch onto instead). A run
   * with no correlated `scheduleId` (every ordinary, non-scheduled run) is
   * silently ignored.
   */
  scheduleFireEvents: TypedEventTarget<ScheduleFireEventMap>;
  /**
   * Skill lifecycle events (COR-767), dispatched by the `@lostgradient/bureau/skills`
   * tool factories each run's toolbox is built from. One bureau-level target
   * rather than one per run, matching `scheduleFireEvents`: each event carries
   * its own `runId`/`sessionId` correlation, so a shared target loses nothing
   * and `createBureau` forwards from exactly one place.
   */
  skillEvents: TypedEventTarget<SkillEventMap>;
  /**
   * Run ids the durable engine flagged, during boot recovery, as resuming
   * under a DIFFERENT workflow version than the one they were checkpointed
   * with (AB-10 — workflow versioning for in-flight durable runs). Populated
   * by the `onWorkflowVersionMismatch` callback wired into `createRunEngine`,
   * which fires once per recovered run BEFORE `engine.recoverAll()` returns —
   * so this map is fully populated by the time the bureau's recovery loop
   * calls `classifyRecoveredRun`. Never cleared: entries are read exactly once
   * per boot recovery pass and the map is rebuilt fresh on the next boot.
   *
   * Keyed by runId, valued with the stored/registered version strings (AB-12
   * run inspector — `reattachRecoveredRun` reads these to stamp a
   * `workflow.reattached` timeline marker with the mismatch detail, not just
   * the boolean `classifyRecoveredRun` needs).
   */
  workflowVersionMismatches: Map<string, { storedVersion: string; registeredVersion: string }>;
  /**
   * Disposes the raw `Storage` backend this composition resolved from
   * `options.storage`, if any. The KV/checkpoint views are created with
   * `disposeUnderlyingStorage: false` (they share one backend), and Weft's
   * `engine[Symbol.dispose]()` does NOT close the storage either — so the owner
   * (the bureau) must call this on teardown to release the SQLite/LMDB handle.
   * `undefined` when the caller supplied their own `persistence` (we did not
   * resolve a backend and do not own its lifecycle).
   */
  disposeStorage: (() => void) | undefined;
  /**
   * The resolved durable `Storage` backend itself, when one exists.
   *
   * Distinct from `kv`, which is a `ConditionalTextValueStore` *view* over
   * this same backend: a `Mailbox` needs the raw `Storage` because it
   * commits its own state transitions through `conditionalBatch`, which
   * the text-value view does not expose. Distinct from `disposeStorage`,
   * which closes the handle without lending it out.
   *
   * `undefined` when no persistent backend resolved — the caller is then
   * genuinely non-durable and must not pretend otherwise.
   *
   * Lifecycle stays with this composition: a borrower uses the handle and
   * never disposes it, because `disposeStorage` above is what owns that.
   */
  durableStorage: Storage | undefined;
  memory: GovernedMemory | undefined;
  sessionStore: SessionStore | undefined;
  scheduler: Scheduler | undefined;
  /**
   * The bureau's canonical toolbox (`options.toolbox`, or an internally
   * created one). `resolveReview` calls `resumeApproval()` on this instance to
   * resume a signed pending tool approval — `resumeApproval` re-invokes the
   * tool by name/callId, so any toolbox sharing the original `approvalSecret`
   * and tool set can resume it, not only the specific per-run `.extend()` clone
   * that produced the pending approval.
   */
  baseToolbox: BureauToolbox;
  setRequestAuthorityValidator(
    validator: ((context: ToolRequestContext) => boolean | Promise<boolean>) | undefined,
  ): void;
  /**
   * AB-240: wired by `createBureau` once its agent catalog exists, so boot
   * recovery can resolve a catalog-dispatched run's deps through the
   * catalog agent's OWN `OPERATIVE_RESOLVE_RUN_OPTIONS` rather than the
   * Bureau's default runtime composition.
   */
  setCatalogAgentRunOptionsResolver(resolver: CatalogAgentRunOptionsResolver | undefined): void;
  /**
   * COR-1586 — the resolver will never be wired, because the Bureau failed while it was being
   * built. Every reader waiting for it, and every later one, is answered as unavailable with
   * `reason`. A no-op for a composition built without `awaitsCatalogAgentRunOptionsResolver`.
   */
  abandonCatalogAgentRunOptionsResolver(reason: string): void;
  /**
   * Persist the catalog-run recovery record `resolveRunServices` consults
   * on the next boot. Called from `bureau.run()`'s durable dispatch branch
   * before the durable engine starts. A no-op when this composition has no
   * durable storage.
   */
  persistCatalogRunRecoveryRecord(
    runId: string,
    record: Omit<CatalogRunRecoveryRecord, 'schemaVersion'>,
  ): Promise<void>;
  /**
   * COR-772 — {@link persistCatalogRunRecoveryRecord}, but create-if-absent:
   * `false`, writing nothing, when a record already exists for `runId`. A
   * child run's identifier is chosen by its caller rather than minted here,
   * so its record must never replace the one another run already holds.
   * `true` with no durable storage, where there is nothing to claim.
   */
  claimCatalogRunRecoveryRecord(
    runId: string,
    record: Omit<CatalogRunRecoveryRecord, 'schemaVersion'>,
  ): Promise<boolean>;
  /**
   * COR-851 — the persisted catalog-run recovery record for `runId`, as
   * stored. A goal reads it to verify that a run at one of its deterministic
   * ids is the goal's own before adopting or stopping it.
   */
  loadCatalogRunRecoveryRecord(runId: string): Promise<CatalogRunRecoveryLoad>;
  /**
   * COR-851 — tombstones the claim of a goal attempt's run, so that no start can
   * begin from it and no run under it takes a step (see `goal-attempt-fence.ts`).
   * The claim the goal's own start wrote is changed by compare-and-swap from the
   * exact bytes read; where no claim exists a tombstoned one is created
   * whole, create-if-absent, so a start that claims later finds it. `'fenced'`
   * once the claim is tombstoned (by this call or an earlier one), `'foreign'`
   * when the record at the id is not this goal attempt's, which is left alone.
   * Rejects when the record cannot be read or is not valid, or when concurrent
   * writers keep winning; the caller treats that as work still owed.
   */
  fenceGoalAttemptRecoveryRecord(
    runId: string,
    owner: GoalAttemptClaimOwner,
    tombstonedAt: string,
  ): Promise<GoalAttemptClaimFence>;
  /**
   * Whether `runId` has a persisted catalog-run recovery record — used by
   * `createBureau`'s boot-recovery classification to route a catalog run to
   * a headless monitor instead of the session-ownership classification.
   */
  isCatalogRecoveredRun(runId: string): Promise<boolean>;
  /**
   * AB-241 review finding: the combined catalog-run classification AND
   * attribution read `createBureau`'s `onRecoveredWorkflow` uses, backed by
   * exactly ONE `loadCatalogRunRecoveryRecord` call — deliberately NOT two
   * separate calls (one to `isCatalogRecoveredRun`, one to a
   * would-be `getCatalogRunAttribution`), because a transient storage read
   * failure on a SECOND, independent read could then classify a workflow as
   * catalog territory (the first read succeeded) while losing its
   * attribution (the second read hit the transient failure) — silently
   * demoting an attributed run to unattributed for the rest of this
   * process's lifetime, since `eventHistory`'s principal gate fails closed
   * on an absent `runAttribution` entry. `isCatalogRun` is `true` for
   * `'read-error'` as well as `'found'` (matching `isCatalogRecoveredRun`'s
   * own read-error handling), so a corrupt (not absent) record still routes
   * to the headless catalog monitor rather than falling through to the
   * session-ownership classification; `attribution` is populated only for
   * `'found'`, since a corrupt record has nothing decoded to offer.
   */
  classifyCatalogRecoveredRun(runId: string): Promise<{
    isCatalogRun: boolean;
    attribution?: { agentName: string; principal?: string };
  }>;
  /**
   * AB-241 review finding: releases every entry `catalogRunRecoveryCache`
   * accumulated during the current boot recovery pass. `createBureau`'s
   * `recoverDurableRuns` calls this exactly once, after its post-recovery
   * loop (the last consumer of the cache) has finished — see the cache's
   * own doc comment for why entries are retained rather than evicted
   * per-read.
   */
  clearCatalogRunRecoveryCache(): void;
  /**
   * COR-1577 — resolve the catalog agent a session run names, through the same resolver a
   * catalog dispatch and boot recovery use. The caller checks `agentName` is not the default
   * agent first: `bureau` has no catalog entry and runs the Bureau-wide runtime.
   */
  resolveSessionAgentRun(
    agentName: string,
    runId: string,
    principal?: string,
    recorded?: CatalogRunRecordedDefinition,
  ): Promise<SessionAgentRunResolution>;
  /**
   * COR-716 — how a run owned by `principalId` handles the media it carries: the
   * resolver that projects a managed asset to something a provider takes (absent when no
   * asset service is composed), and the policy for an asset no safety gate verified,
   * taken from this bureau's input guardrail. Every path that starts or resumes a run
   * spreads it into the run's options, so a managed-asset part resolves, and is judged,
   * the same on a fresh start, a recovery, and a scheduled fire.
   *
   * `rowHolder` says who keeps the managed assets the run's rows reference (COR-1581): `'session'`
   * for a run that writes into a session, whose claim pass takes them, and `'run'` for a run with
   * no session, which holds them itself. A catalog dispatch (`bureau.run()`, a child, a goal
   * attempt, a workflow step) and its recovery have no session.
   */
  mediaOptionsFor(principalId: string | undefined, rowHolder: MediaRowHolder): MediaRunOptions;
  ready: boolean;
  provider: RedactedProviderConfiguration | undefined;
  providers: RedactedProviderRouteConfiguration[];
  maximumSteps: number;
  systemPrompt: string | undefined;
  getToolSummaries(): ToolSummary[];
  createRunRuntime(
    request: CreateRunRequest & { sessionId: string; runId?: string },
    options?: {
      liveStreaming?: boolean;
      /**
       * The pre-crash active set, as provenance-carrying activation records.
       *
       * Recovery re-validates these against the live catalog and re-checks each digest, so a skill
       * whose source was revoked or whose content drifted while the run was away does not come
       * back under a name somebody once reviewed.
       */
      initialActiveSkillRecords?: ReadonlyArray<SkillActivationRecord> | undefined;
      /**
       * COR-1577 — run the named catalog agent's `generate` and toolbox in place of the
       * Bureau-wide ones. The Bureau tier (memory, skills, identity, guardrails, opt-in tools)
       * is composed around them exactly as it is around the Bureau-wide runtime.
       */
      sessionAgent?: SessionAgentRun | undefined;
      /** COR-1546 — the run's owner of record, which its memory is partitioned under. */
      memoryOwner?: string | undefined;
      /**
       * COR-1620 — the skill policy that governs the run cannot be verified, so the run is
       * offered no tool and writes no skill snapshot. This is a filter on what the model sees, not
       * a gate on what runs: a call the model makes anyway still reaches its approval, which is
       * refused at approve under the snapshot read again.
       */
      skillPolicyUnverifiable?: boolean | undefined;
    },
  ): Promise<{
    generate: GenerateFunction;
    toolbox: AnyToolbox;
    /**
     * The run's hook plan (COR-567). Bureau's own hooks were seven pushes into
     * three legacy arrays until this became a registry; they are registered
     * here, under stable ids, in the order those arrays ran.
     *
     * A registry rather than arrays because `RunOptions.hooks` is the only
     * hook surface that carries registration identity, priority and plan
     * observation — and bureau composing one is what makes those real for a
     * production run instead of a capability nothing reaches.
     */
    hooks: HookRegistry<OperativeHookMap>;
    streamEventTarget: TypedEventTarget<StreamEventMap> | undefined;
    getActiveSkillRecords: () => readonly SkillActivationRecord[];
    /**
     * Settles once the active skills the run was given have been re-validated against the live
     * catalog (COR-1613). A run waits for it before its first step; a caller that decides a tool
     * call outside a step, as the restore of a pending approval does, waits for it itself.
     */
    skillsRecovered: Promise<SkillRecoveryOutcome>;
    /**
     * COR-1620 — whether the skill policy is held unverified: the snapshot could not be
     * verified, or a stored skill was refused on recovery. Such a run is offered no tool and
     * writes no skill snapshot, so what it persisted before is kept. Settles with
     * {@link skillsRecovered}.
     */
    skillPolicyUnverified: () => boolean;
  }>;
  /**
   * AB-260 — folded onto this interface directly rather than reached through
   * the retired `RuntimeCompositionTestingSeams` WeakMap: this is Weft's
   * literal `resolveWorkflowServices` resolver, already wired into
   * `durable.engine` at construction whenever one is composed (production
   * invokes it automatically on every recovered run) — a genuine capability
   * of this returned object, not a test-only backdoor, so every caller (test
   * or production) reaches it the same way. Callable even without a durable
   * engine composed — it resolves `{ status: 'unavailable' }` for every
   * input in that case, matching what an uncomposed resolver would report.
   */
  resolveRunServices(info: WorkflowServicesResolverInfo): Promise<WorkflowServicesResolution>;
  /**
   * AB-260 — folded onto this interface directly for the same reason as
   * {@link RuntimeComposition.resolveRunServices}: the native-scheduled-fire
   * branch of that same resolver, callable standalone for a caller (test or
   * production) that already holds a `SessionStore` and wants to build a
   * scheduled fire's deps without going through the full resolver dispatch.
   */
  buildScheduledRunServices(
    info: WorkflowServicesResolverInfo,
    store: SessionStore,
    recoveredScheduleMarker?: RecoveredScheduleMarker,
  ): Promise<WorkflowServicesResolution>;
  /**
   * COR-1620 — the active-skill snapshot of a scheduled fire under recovery, which a restored
   * approval and a replayed fire are decided under. It tells a verified absence of skills from a
   * snapshot that cannot be verified: the read or deserialization failed, or the session names
   * another fire.
   */
  readCommittedScheduledSkillSnapshot(
    session: { readonly metadata: Record<string, JSONValue> } | undefined,
    runId: string,
    recovering: boolean,
  ): Promise<SkillSnapshot>;
  /**
   * COR-1620 — the same for a session run: the records its session holds, a verified absence
   * when the Bureau has no skills, and unverifiable when they do not deserialize or a later run
   * cleared or replaced them.
   */
  readSessionSkillSnapshot(
    session: { readonly metadata: Record<string, JSONValue> } | undefined,
    runId: string,
  ): SkillSnapshot;
  /**
   * COR-1265 criterion 3b — a fresh registry holding only the Bureau invariants
   * that close over nothing run-specific, for a dispatch path that resolves its
   * run options through a catalog agent rather than through
   * {@link RuntimeComposition.createRunRuntime}. Merged as the first tier so
   * Bureau's policy still applies to those runs.
   */
  createBureauInvariantHooks(
    goalAttempt?: GoalAttemptTarget,
    options?: BureauInvariantOptions,
  ): HookRegistry<OperativeHookMap>;
}

/** COR-1367 — per-dispatch options for {@link RuntimeComposition.createBureauInvariantHooks}. */
export interface BureauInvariantOptions {
  /**
   * The dispatched agent resolves its own guardrails from its declaration and
   * its inherited policy (`resolvesOwnGuardrails`), so Bureau registers no
   * guardrail invariant of its own for the run.
   */
  agentResolvesGuardrails?: boolean;
}

/**
 * `createRuntimeComposition` builds bureau-level generate/toolbox/
 * persistence/durability composition — entirely orthogonal to the typed
 * `agents` catalog (AB-22), which `createBureau` wires separately. Omitting
 * `agents` here means every existing caller (including the 100+ direct
 * `createRuntimeComposition({...})` calls in this package's own test suite)
 * keeps working unchanged; it is not part of this function's contract.
 */
/**
 * Priority pinning a Bureau registration behind every other tier's entries on
 * the same hook point (COR-1265, criteria 9 and 10).
 *
 * Two dispatch shapes let a later handler decide the outcome: `runLast`
 * returns the last defined result, and the waterfall feeds each handler the
 * previous one's return value. On both, "runs last" means "wins", so a Bureau
 * registration that narrows — today `bureau:guardrails-validate-response` — has
 * to sort behind whatever an agent or a direct caller registered. The trailing
 * `onStep` hooks take the same value for the ordering reason rather than the
 * authority one: they persist the session once the step's mutations settle, and
 * an agent-tier `onStep` handler is one of those mutations.
 *
 * The tier band works against Bureau here. `mergeHookRegistries` offsets each
 * participant by `(participants - 1 - index) * 1000` and Bureau is always the
 * first participant, so it receives the LARGEST offset — `+2000` with the three
 * tiers a composition can reach. The constant sits that far above
 * `Number.MIN_SAFE_INTEGER` so adding the offset back cannot leave the
 * safe-integer range, and so a merged Bureau entry still lands below anything
 * registered at a priority a caller would plausibly write.
 *
 * The residual, stated rather than implied: a lower tier that deliberately
 * registers at or below `Number.MIN_SAFE_INTEGER + 2000` sorts after this
 * anyway. No finite constant closes that, because a priority is a plain number
 * with no floor, and `-Infinity` closes it only until a second entry carries it
 * — the registry's `b.priority - a.priority` comparator would then return
 * `NaN`. A tier deliberately reaching for the bottom of the number line is not
 * the threat this is defending against; an ordinary registration that happens
 * to outrank Bureau is.
 */
const BUREAU_PINNED_LAST_PRIORITY = Number.MIN_SAFE_INTEGER + 2000;

/**
 * The ownership tier every registration Bureau makes belongs to (COR-1265) —
 * set once on a registry, stamped by `on()` onto each entry so it survives
 * `mergeHookRegistries`.
 */
export const BUREAU_HOOK_TIER = 'bureau';

/**
 * Registers the identity invariant. Shared by the per-run composition and by
 * {@link RuntimeComposition.createBureauInvariantHooks}, which is the whole
 * reason it is a function: the two register at different points in their own
 * registries and must not drift into two different registrations.
 */
function registerIdentityInvariant(
  registry: HookRegistry<OperativeHookMap>,
  identity: NonNullable<RuntimeCompositionOptions['identity']>,
): void {
  registry.on('prepareStep', createIdentityHook(identity), {
    id: 'bureau:identity',
    // Appends a system message to the step's conversation and touches nothing
    // outside it; a replayed step rebuilds that conversation from persisted
    // history, so re-running this reproduces state rather than repeating an
    // external effect.
    replay: 'safe',
  });
}

/**
 * Registers both guardrail invariants, in the order the legacy arrays ran them.
 *
 * The caller decides WHEN — the per-run composition registers `prepareStep`
 * last of all its `prepareStep` hooks on purpose, so the input guardrail scans a
 * step context every earlier hook has already contributed to.
 */
function registerGuardrailInvariants(
  registry: HookRegistry<OperativeHookMap>,
  guardrails: GuardrailHooks,
): void {
  registry.on('prepareStep', guardrails.prepareStep, {
    id: 'bureau:guardrails-prepare-step',
    // Scans and may taint in-process session state; no external write.
    replay: 'safe',
  });
  registry.on('validateResponse', guardrails.validateResponse, {
    id: 'bureau:guardrails-validate-response',
    // COR-1265 criterion 10. `validateResponse` is dispatched as a waterfall,
    // so the LAST handler to answer hands its response to the run — an agent-
    // or direct-tier handler running after this one would decide what the
    // guardrail's narrowing was worth. Pinned last so it does not.
    priority: BUREAU_PINNED_LAST_PRIORITY,
    replay: 'safe',
  });
}

/**
 * Priority placing a hook after every hook bureau's own composition registered.
 *
 * The same value as {@link BUREAU_PINNED_LAST_PRIORITY}, and deliberately not a
 * separate band: COR-1265's criterion 9 makes the two trailing hooks outrank
 * every tier's `onStep` handlers, not merely Bureau's own, and a value chosen
 * relative to Bureau's default `0` could not do that once a second tier exists.
 */
const TRAILING_HOOK_PRIORITY = BUREAU_PINNED_LAST_PRIORITY;

/**
 * Registers a per-call `onStep` hook that must run AFTER the run runtime's own
 * — the session write-back on a scheduled fire, the pending-approval persist on
 * an interactive run. Both were array spreads (`[...runRuntime.onStep, extra]`)
 * whose ordering came from their position in the literal; the priority states
 * it instead, so it survives the hook moving.
 *
 * This mutates the run's registry and returns it, rather than merging into a
 * fresh one, because the registry is created per run inside `createRunRuntime`
 * and the caller here owns that run outright.
 *
 * COR-1265: every caller now merges the result before handing it to a run, so
 * the completed Bureau tier is what becomes `mergeHookRegistries`' first
 * argument. That ordering is the point — registering here AFTER the merge would
 * put the trailing hook in the merged registry at its raw priority while every
 * other Bureau entry had already been offset, which is precisely the renumbering
 * this function used to avoid by refusing to merge at all.
 */
export function registerTrailingOnStep(
  hooks: HookRegistry<OperativeHookMap>,
  id: string,
  handler: OnStepHook,
): HookRegistry<OperativeHookMap> {
  hooks.on('onStep', handler, {
    id,
    priority: TRAILING_HOOK_PRIORITY,
    // Writes a session record.
    replay: 'effectful',
  });
  return hooks;
}

/**
 * COR-1596 — the field of a persisted request authority that says it is a schedule fire's.
 */
export const SCHEDULED_FIRE_AUTHORITY_MARKER = 'scheduledFire';

/**
 * COR-1596 — whether the authority a session recorded for `runId` is a schedule fire's. A fire
 * runs on the Bureau-wide runtime and its agent name is a label, not a catalog entry, so what
 * resumes its approval after a restart must not look the name up in the catalog the way a session
 * run's does.
 */
export function isScheduledFireAuthority(
  metadata: Record<string, JSONValue>,
  runId: string,
): boolean {
  const authorities = metadata['lastRequestAuthorities'];
  if (!isPlainAuthorityRecord(authorities)) return false;
  const authority = authorities[runId];
  return isPlainAuthorityRecord(authority) && authority[SCHEDULED_FIRE_AUTHORITY_MARKER] === true;
}

/**
 * COR-1596 — what a schedule fire's session records for a tool call its step left awaiting
 * approval: the pending approval under its review id, its supersession round (0, or the round
 * already recorded), and the request authority the fire ran under. These are the keys a session
 * run's approvals are recorded under, so the boot restore of a terminal run's approvals finds a
 * fire's too. Idempotent by key: a replayed step writes the same entries.
 *
 * `committed`, given for a fire that is replaying after a crash, names the review ids of the
 * approvals the run's checkpoint holds. A fire writes its session as each step completes and
 * commits the step after, so a crash between the two leaves an approval in the session that the
 * run never committed; the replay may not make that call again. Every approval of this run that
 * is neither committed nor this step's is dropped from the write, and the authority with the last
 * of them.
 */
export function scheduledFireApprovalMetadata(
  metadata: Record<string, JSONValue>,
  runId: string,
  results: readonly { readonly outcome: string; readonly pendingApproval?: unknown }[],
  requestContext: ToolRequestContext,
  committed?: ReadonlySet<string>,
): Record<string, JSONValue> {
  const prefix = `approval:${runId}:`;
  // A review the session records as decided is not recorded as pending again: a replay that
  // makes the same call under the same id would list it for ever, with nothing to decide.
  const decided = new Set(
    Array.isArray(metadata['resolvedReviewIds']) ? metadata['resolvedReviewIds'] : [],
  );
  const approvals: Array<[string, JSONValue]> = [];
  for (const result of results) {
    if (result.outcome !== 'action_required' || result.pendingApproval === undefined) continue;
    const approval = JSON.parse(JSON.stringify(result.pendingApproval)) as JSONValue;
    const callId = isPlainAuthorityRecord(approval) ? approval['callId'] : undefined;
    if (typeof callId !== 'string' || decided.has(`${prefix}${callId}`)) continue;
    approvals.push([`${prefix}${callId}`, approval]);
  }
  const recordOf = (value: JSONValue | undefined): Record<string, JSONValue> =>
    isPlainAuthorityRecord(value) ? value : {};
  const stepIds = new Set(approvals.map(([id]) => id));
  const existingOverrides = recordOf(metadata['pendingApprovalOverrides']);
  const abandoned = new Set(
    committed === undefined
      ? []
      : Object.keys(existingOverrides).filter(
          (id) => id.startsWith(prefix) && !committed.has(id) && !stepIds.has(id),
        ),
  );
  if (approvals.length === 0 && abandoned.size === 0) return {};
  const without = (record: Record<string, JSONValue>): Record<string, JSONValue> =>
    Object.fromEntries(Object.entries(record).filter(([id]) => !abandoned.has(id)));
  const overrides = { ...without(existingOverrides), ...Object.fromEntries(approvals) };
  const rounds = recordOf(metadata['pendingApprovalRounds']);
  const authorities = recordOf(metadata['lastRequestAuthorities']);
  const authority = JSON.parse(
    JSON.stringify({
      ...requestContext.authority,
      ...(requestContext.audience === undefined ? {} : { audience: requestContext.audience }),
      ...(requestContext.agentId === undefined ? {} : { agentId: requestContext.agentId }),
      [SCHEDULED_FIRE_AUTHORITY_MARKER]: true,
    }),
  ) as JSONValue;
  const { [runId]: _ended, ...otherAuthorities } = authorities;
  const holdsApproval = Object.keys(overrides).some((id) => id.startsWith(prefix));
  return {
    pendingApprovalOverrides: overrides,
    pendingApprovalRounds: {
      ...without(rounds),
      ...Object.fromEntries(approvals.map(([id]) => [id, rounds[id] ?? 0])),
    },
    lastRequestAuthorities: holdsApproval
      ? { ...authorities, [runId]: authority }
      : otherAuthorities,
  };
}

export type RuntimeCompositionOptions = Omit<BureauOptions, 'agents'>;

export async function createRuntimeComposition(
  options: RuntimeCompositionOptions,
  suppliedDependencies: Partial<RuntimeCompositionDependencies> = {},
): Promise<RuntimeComposition> {
  // COR-1509: the durable engine starts reclaiming and resuming runs with a lapsed claim as soon
  // as it exists, on its own interval and independent of `recover`, which is before this
  // composition finishes. `resolveRunServices` therefore waits on this gate rather than answering
  // "not ready": a run that reaches the resolver early must be held, not durably failed.
  const readiness = Promise.withResolvers<void>();
  // A failed composition rejects the gate; the resolver handles that, and nothing else needs to.
  readiness.promise.catch(() => {});
  try {
    return await buildRuntimeComposition(options, suppliedDependencies, readiness);
  } catch (error) {
    readiness.reject(error);
    throw error;
  }
}

async function buildRuntimeComposition(
  options: RuntimeCompositionOptions,
  suppliedDependencies: Partial<RuntimeCompositionDependencies>,
  readiness: PromiseWithResolvers<void>,
): Promise<RuntimeComposition> {
  const dependencies: RuntimeCompositionDependencies = {
    ...defaultRuntimeCompositionDependencies,
    ...suppliedDependencies,
  };
  const maximumSteps = options.maximumSteps ?? DEFAULT_MAXIMUM_STEPS;
  const systemPrompt = options.systemPrompt;
  const diagnose = resolveDiagnosticSink(options.onDiagnostic);
  // AB-260: `createBureau` resolves and forwards its own single
  // `RuntimeServices` instance through `options.runtime` before calling this
  // function, so this resolution just picks that SAME instance back up. A
  // direct caller of this exported function (bypassing `createBureau`
  // entirely — this package's own extensive test suite does exactly that)
  // gets the real-globals default, identical to this composition's behavior
  // before `RuntimeServices` existed.
  const runtimeServices: RuntimeServices = options.runtime ?? createDefaultRuntimeServices();

  // The resolver waits on `readiness` until the whole composition is assembled. In automatic mode
  // `createRunEngine` starts its scheduler and claim-reclaim interval before later consts
  // (`sessionStore`, the `createRunRuntime` closure deps) are initialized, so a persisted schedule
  // or a lapsed claim can reach `resolveRunServices` mid-build and would hit a not-yet-initialized
  // binding. Manual mode has no background poller, but shares the same gate for consistency.
  // Only so the resolver can say, once, that it had to wait; the gate itself is `readiness`.
  let compositionOpen = false;
  let requestAuthorityValidator = options.requestAuthorityValidator;
  // AB-240: wired by `createBureau` once its agent catalog exists (this
  // function's own contract deliberately excludes `agents` — see
  // `RuntimeCompositionOptions`'s doc comment) — `undefined` until then, and
  // for any direct `createRuntimeComposition` caller that never wires one.
  let catalogAgentRunOptionsResolver: CatalogAgentRunOptionsResolver | undefined;
  // COR-1586: with `awaitsCatalogAgentRunOptionsResolver`, a reader of the resolver that finds it
  // unset waits on this gate. It opens when the resolver is wired or abandoned, and stays open.
  const catalogResolverGate = Promise.withResolvers<void>();
  let catalogResolverGateOpen = false;
  let catalogResolverAbandonedReason: string | undefined;
  const openCatalogResolverGate = (): void => {
    catalogResolverGateOpen = true;
    catalogResolverGate.resolve();
  };

  // AB-10: run ids the durable engine flags as version-mismatched during boot
  // recovery — see RuntimeComposition.workflowVersionMismatches.
  const workflowVersionMismatches = new Map<
    string,
    { storedVersion: string; registeredVersion: string }
  >();

  // AB-223: runId → scheduleId for a scheduled fire whose deps this composition
  // has built (live tick or recovered), so the `workflow:completed`/
  // `workflow:failed` engine listener wired below `createRunEngine` can
  // correlate a terminal event back to its owning schedule. Populated in
  // `buildScheduledRunServices`; each entry is deleted the instant its
  // terminal event dispatches, so it never grows past the count of in-flight
  // scheduled fires.
  const scheduledFireScheduleIds = new Map<string, string>();

  /**
   * COR-1482: tells the host which session incarnation a fire runs in. Binding a task to it is a
   * record about the fire, so a host that cannot write it is diagnosed and the fire still runs.
   */
  async function reportScheduledSession(notice: ScheduledSessionNotice): Promise<void> {
    try {
      await dependencies.onScheduledSessionKnown?.(notice);
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'task-registry',
        message: `[bureau] Could not bind the task of schedule fire "${notice.runId}" to its session: ${serializeUnknownError(error)}`,
        cause: error,
      });
    }
  }

  /**
   * COR-1596: hands the host a fire's services so it can register the fire's reviews. Registering
   * them is a record about the fire, so a host that cannot is diagnosed and the fire still runs.
   */
  async function reportScheduledServices(
    notice: ScheduledFireServicesNotice,
    services: DurableRunDeps,
  ): Promise<void> {
    try {
      await dependencies.onScheduledFireServices?.(notice, services);
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'task-registry',
        message: `[bureau] Could not register the reviews of schedule fire "${notice.runId}": ${serializeUnknownError(error)}`,
        cause: error,
      });
    }
  }

  /**
   * COR-1482: tells the host a schedule fire's run has ended. The settlement is a record about a
   * run that already ended, so a host that cannot write it is diagnosed, never thrown into the
   * engine's event dispatch.
   */
  function settleScheduledFire(settlement: ScheduledFireSettlement): void {
    const hook = dependencies.onScheduledFireSettled;
    if (hook === undefined) return;
    void (async () => hook(settlement))().catch((error: unknown) => {
      diagnose({
        level: 'error',
        scope: 'task-registry',
        message: `[bureau] Could not settle the task of schedule fire "${settlement.runId}": ${serializeUnknownError(error)}`,
        cause: error,
      });
    });
  }

  // AB-241 review finding: runId → the decoded `CatalogRunRecoveryRecord`
  // `resolveRunServices`'s catalog branch already successfully read during
  // boot recovery, cached here so BOTH `classifyCatalogRecoveredRun` (called
  // from the awaited `onRecoveredWorkflow` hook, during `recoverAll()`) and
  // `isCatalogRecoveredRun` (called again, LATER, from
  // `recoverDurableRuns`'s own post-recovery loop over `recoverAll()`'s
  // returned handles) can reuse that SAME decode instead of each issuing
  // its own independent storage read — a transient failure on either read
  // could disagree with the first, either losing an already-attributed
  // run's attribution or, worse, misclassifying an already-resolved
  // catalog run as an orphan and cancelling it. Entries are intentionally
  // NOT evicted per-read (a second fresh review finding after an earlier,
  // wrong per-entry-eviction attempt starved the later of these two
  // consumers) — the whole cache is cleared in one call, once, at the end
  // of the boot recovery pass (`clearCatalogRunRecoveryCache`, called from
  // `recoverDurableRuns` in create-bureau.ts), so it never persists past
  // that one pass — unlike `runAttribution`, this is not live-dispatch
  // state.
  const catalogRunRecoveryCache = new Map<string, CatalogRunRecoveryRecord>();
  const scheduleFireEvents = new TypedEventTarget<ScheduleFireEventMap>();
  const skillEvents = new TypedEventTarget<SkillEventMap>();

  // Resolve the `persistence` option into its components. The three forms are:
  // - PersistenceOptions { store, history?, observability?, onLog? }
  // - Bare StorageConfiguration (shorthand for { store: config })
  // - ConditionalTextValueStore (KV-only, no durable engine)
  // The legacy `storage` field is still accepted alongside the new forms.
  const {
    storageConfig: persistenceStorageConfig,
    kvStore: persistenceKvStore,
    persistenceHistory,
    persistenceObservability,
    persistenceOnLog,
  } = resolvePersistenceOptions(options);

  // Prefer the `persistence` form over the top-level storage field. A caller may
  // inject a raw adapter (notably Cloudflare Durable Object SQLite) because it
  // cannot be represented by Weft's built-in StorageConfiguration union.
  const effectiveStorage = persistenceStorageConfig ?? options.storage;

  let kv: ConditionalTextValueStore | undefined = persistenceKvStore;
  // Keep the raw Storage so the durable engine can share the exact backend with
  // the text-value KV view (Weft requires one engine per durable store).
  let durableStorage: Storage | undefined;
  let ownsDurableStorage = false;
  if (!kv && effectiveStorage) {
    if (isStorageConfiguration(effectiveStorage)) {
      durableStorage = await resolveStorage(effectiveStorage);
      ownsDurableStorage = true;
    } else {
      durableStorage = effectiveStorage;
    }
    kv = textValueStore(durableStorage, { disposeUnderlyingStorage: false });
  }

  // Merge operational knobs from the PersistenceOptions form with the legacy
  // top-level fields. PersistenceOptions takes precedence when both are set.
  const effectiveObservability = persistenceObservability ?? options.observability;
  const effectiveOnLog = persistenceOnLog ?? options.onLog;

  // Durable execution is ON BY DEFAULT whenever a PERSISTENT storage backend is
  // configured AND no custom KV-only `persistence` (ConditionalTextValueStore) shadows it.
  // The default follows persistence because that is the only place resume is real:
  // `memory` storage loses its checkpoints with the process, so default-on there
  // would be pure overhead with zero recovery. The explicit `durableExecution`
  // flag overrides the default either way.
  const hasKvOnlyPersistence = persistenceKvStore !== undefined;
  let effectiveStorageIsPersistent = false;
  if (effectiveStorage) {
    if (isStorageConfiguration(effectiveStorage)) {
      effectiveStorageIsPersistent = effectiveStorage.type !== 'memory';
    } else {
      const persistence = effectiveStorage.capabilities().persistence;
      effectiveStorageIsPersistent = persistence === 'local' || persistence === 'remote';
    }
  }
  const wantsDurable =
    options.durableExecution ?? (effectiveStorageIsPersistent && !hasKvOnlyPersistence);

  // A KV-only `persistence` (ConditionalTextValueStore) value means no raw `Storage` was
  // resolved and a durable engine cannot be built. Fail loud if `durableExecution:
  // true` is requested — honor it silently and we ship an engine that looks
  // durable but can't recover. (Flag UNSET + ConditionalTextValueStore is the documented
  // KV-only path — sessions only, no durability.)
  if (options.durableExecution === true && hasKvOnlyPersistence) {
    throw new Error(
      'durableExecution: true is incompatible with a ConditionalTextValueStore `persistence` value. ' +
        'A durable engine must share its backend with the session store, but ' +
        'a ConditionalTextValueStore cannot back a Weft engine. Provide `persistence` as a ' +
        'StorageConfiguration or PersistenceOptions to get durable execution, ' +
        'or drop `durableExecution: true` to use the KV-only persistence layer ' +
        'with the in-memory run loop.',
    );
  }

  let durable: DurableComposition | undefined;
  if (wantsDurable && durableStorage) {
    // Build the checkpoint store over the SAME backend the engine persists to.
    const checkpointStore = createCheckpointStore(
      textValueStore(durableStorage, { disposeUnderlyingStorage: false }),
    );
    const runWorkflow = createRunWorkflow(checkpointStore, { version: options.workflowVersion });
    // recover: false is REQUIRED. Weft's `Engine.create` default is recover:true,
    // which runs recoverAll() *during construction* — but the bureau needs the
    // recovered handles itself (to attach the `settleRecoveredRun` monitors that
    // persist each resumed run's terminal session status), and a handle started
    // inside Engine.create is not surfaced to the caller. So the bureau owns
    // recovery: it calls engine.recoverAll() at boot and keeps the handles. The
    // per-run deps a recovered run needs are re-provided lazily by
    // `resolveRunServices` (passed as resolveWorkflowServices), which Weft fires
    // per recovered run before its generator advances — no pre-injection, no
    // module-global registry.
    //
    // In the default automatic profile, `startScheduler: true` is REQUIRED too:
    // recover:false decouples *who drives recovery* from *whether timers fire*,
    // and the poller otherwise follows recover. In manual mode the serverless
    // host drives timers through `Bureau.runDurableMaintenance()`, so Weft
    // requires the in-process scheduler to remain stopped.
    durable = await createRunEngine({
      storage: durableStorage,
      runWorkflow,
      checkpointStore,
      recover: false,
      backgroundTasks: options.durableBackgroundTasks ?? 'automatic',
      // COR-1527: with workflow files the scheduler waits until their documents are registered,
      // so a schedule that is due the moment the engine exists cannot fire a type Weft does not
      // have yet. `createBureau` starts it, before the engine recovers, once they are.
      startScheduler:
        options.durableBackgroundTasks !== 'manual' && options.workflowDirectory === undefined,
      resolveWorkflowServices: resolveRunServices,
      ...(dependencies.onRecoveredWorkflow === undefined
        ? {}
        : { onRecoveredWorkflow: dependencies.onRecoveredWorkflow }),
      ...(dependencies.goalWorkflow === undefined
        ? {}
        : { goalWorkflow: dependencies.goalWorkflow }),
      ...(effectiveObservability !== undefined ? { observability: effectiveObservability } : {}),
      ...(effectiveOnLog ? { onLog: effectiveOnLog } : {}),
      // durableGuardrails is a Pick of these exact CreateRunEngineOptions fields, so
      // it spreads straight through; createRunEngine guards each one internally, so
      // passing `undefined` members is harmless.
      ...options.durableGuardrails,
      // durableOwnership (AB-178) is the same Pick pattern — createRunEngine
      // defaults `ownership` to 'workflow-lease' when this is omitted entirely.
      ...options.durableOwnership,
      // history from PersistenceOptions takes precedence over durableGuardrails.history
      ...(persistenceHistory !== undefined ? { history: persistenceHistory } : {}),
      runWorkflowVersion: options.workflowVersion,
      // AB-10: record the mismatch so the boot recovery loop below can pass it
      // to `classifyRecoveredRun` (distinct 'reattach-version-mismatch' verdict)
      // before it inspects `workflowVersionMismatches`.
      onWorkflowVersionMismatch: (event: WorkflowVersionMismatchEvent) => {
        workflowVersionMismatches.set(event.runId, {
          storedVersion: event.storedVersion,
          registeredVersion: event.registeredVersion,
        });
        diagnose({
          level: 'warn',
          scope: 'recovery',
          message:
            `[bureau] Recovered run "${event.runId}" was checkpointed under workflow version ` +
            `"${event.storedVersion}" but is resuming under "${event.registeredVersion}". ` +
            `Recovery proceeds against the currently-deployed code (pin-and-warn) — see ` +
            `documentation/workflow-versioning.md.`,
        });
      },
    });

    // AB-223: schedule-fire terminal events. `workflow:completed`/
    // `workflow:failed` fire on the engine for EVERY workflow (scheduled or
    // not) — a live tick and a recovered fire both settle through this same
    // pair, so listening here (rather than duplicating from
    // `monitorRecoveredScheduledFire`'s recovery-only await) gives exactly one
    // dispatch per fire regardless of how it settled. A run with no entry in
    // `scheduledFireScheduleIds` (every ordinary, non-scheduled run) is
    // silently ignored — `return` before either handler does anything else.
    durable.engine.addEventListener(WorkflowCompletedEvent.type, (event) => {
      const scheduleId = scheduledFireScheduleIds.get(event.workflowId);
      if (scheduleId === undefined) return;
      scheduledFireScheduleIds.delete(event.workflowId);
      const result = event.result;
      const finishReason =
        typeof result === 'object' && result !== null && 'finishReason' in result
          ? result.finishReason
          : undefined;
      // Two branches, each dispatching its own concrete event type, rather
      // than one `dispatch(cond ? new A() : new B())` call: TypedEventTarget's
      // `dispatch<K>` infers `K` from its argument's `type` literal, and a
      // ternary's union argument defeats that inference (the argument's
      // static `type` widens to `string`) — using the typed `dispatch` wrapper
      // (not the untyped inherited `dispatchEvent`) needs single-type call
      // sites.
      const failed = isRunFailureFinishReason(finishReason);
      const content =
        typeof result === 'object' && result !== null && 'content' in result
          ? result.content
          : undefined;
      settleScheduledFire({
        runId: event.workflowId,
        status: failed ? 'failed' : finishReason === 'aborted' ? 'canceled' : 'completed',
        finishReason: typeof finishReason === 'string' ? finishReason : undefined,
        error: undefined,
        content: typeof content === 'string' ? content : undefined,
      });
      if (failed) {
        scheduleFireEvents.dispatch(new ScheduleFailedEvent(scheduleId, event.workflowId));
      } else {
        scheduleFireEvents.dispatch(new ScheduleCompletedEvent(scheduleId, event.workflowId));
      }
    });
    durable.engine.addEventListener(WorkflowFailedEvent.type, (event) => {
      const scheduleId = scheduledFireScheduleIds.get(event.workflowId);
      if (scheduleId === undefined) return;
      scheduledFireScheduleIds.delete(event.workflowId);
      settleScheduledFire({
        runId: event.workflowId,
        status: 'failed',
        finishReason: undefined,
        error: event.error instanceof Error ? event.error.message : String(event.error),
        content: undefined,
      });
      scheduleFireEvents.dispatch(new ScheduleFailedEvent(scheduleId, event.workflowId));
    });
    // COR-1482: a fire that timed out is a fire that failed, and its task says so. Without this
    // its task reads `working` until the next boot, and its attribution is never released.
    durable.engine.addEventListener(WorkflowTimedOutEvent.type, (event) => {
      const scheduleId = scheduledFireScheduleIds.get(event.workflowId);
      if (scheduleId === undefined) return;
      scheduledFireScheduleIds.delete(event.workflowId);
      settleScheduledFire({
        runId: event.workflowId,
        status: 'failed',
        finishReason: 'timed-out',
        error: `The fire timed out (${event.timeoutType})`,
        content: undefined,
      });
      scheduleFireEvents.dispatch(new ScheduleFailedEvent(scheduleId, event.workflowId));
    });
    // Not a fire-terminal dispatch (cancellation is out of this issue's scope),
    // but the correlation entry must still be dropped on a cancelled fire, or
    // it leaks for the lifetime of the engine.
    durable.engine.addEventListener(WorkflowCancelledEvent.type, (event) => {
      if (scheduledFireScheduleIds.delete(event.workflowId)) {
        settleScheduledFire({
          runId: event.workflowId,
          status: 'canceled',
          finishReason: 'aborted',
          error: undefined,
          content: undefined,
        });
      }
    });

    // COR-660: the tick observation point Weft's COR-105 exposes. Unlike the
    // terminal pair above, these arrive already keyed by scheduleId, so there
    // is no `scheduledFireScheduleIds` correlation to do and nothing to
    // filter: every schedule on this engine is one the bureau created
    // (`createSchedule`, `createAgentScheduler`, or a durable heartbeat), the
    // engine being bureau-owned. A tick that collides emits `attempted` then
    // `skipped`; a tick that launches emits `attempted` and later one of the
    // terminal pair.
    durable.engine.addEventListener('schedule:attempted', (event) => {
      scheduleFireEvents.dispatch(new ScheduleAttemptedEvent(event.scheduleId, event.occurrence));
    });
    durable.engine.addEventListener('schedule:skipped', (event) => {
      scheduleFireEvents.dispatch(
        new ScheduleSkippedEvent(
          event.scheduleId,
          event.policy,
          event.occurrence,
          // A scheduled fire's Weft workflow id IS its AgentRun id — the same
          // identity `ScheduleFailedEvent`/`ScheduleCompletedEvent` carry as
          // `runId` from `event.workflowId`.
          event.blockingWorkflowId,
        ),
      );
    });
  }

  const memory: GovernedMemory | undefined = options.memory;
  await memory?.init();
  // COR-1546 — the tenant a run's memory is partitioned under. `createBureau` passes its resolved
  // identifier, so `bureau.memory.*`, which builds its authority from `Bureau.id`, reads what the
  // runs wrote. A composition built on its own with no identifier gets one of its own.
  let generatedMemoryTenantId: string | undefined;
  const memoryTenantId = (): string =>
    options.id ?? (generatedMemoryTenantId ??= runtimeServices.identifiers.next('bureau'));

  // A run's skills come from a catalog revision, and only from one. COR-892 removed Bureau's
  // second path — a provider it read skills out of directly — because a skill admitted that way
  // had no trust decision, no artifact digest and no compatibility verdict, so a run holding one
  // could not say where it came from.
  //
  // A caller that has already discovered a revision hands it in, which is the host's job under
  // COR-752's Decision 1: discovery reads approved filesystem roots and remote URLs, and deciding
  // which of those to trust is not Bureau's call to make. A caller that has only configured
  // persistence gets the skills its own store holds, discovered here through the `storage` source.
  // That is the one source Bureau can compose without deciding anything on the host's behalf: the
  // store is already the bureau's, and what is in it is what this runtime itself put there.
  const skillCatalog: SkillCatalogRevision | undefined =
    options.skills === undefined
      ? undefined
      : (options.skills.catalog ??
        (kv === undefined
          ? undefined
          : await discoverSkills({
              sources: [
                {
                  id: 'storage',
                  kind: 'storage',
                  // Not a filesystem path and deliberately not credential-bearing: a catalog entry
                  // exposes this verbatim.
                  location: 'kv://skills',
                  precedence: DEFAULT_SOURCE_PRECEDENCE.storage,
                },
              ],
              storage: kv,
            })));
  /** Whether this Bureau has a skill client: the skills it was given, and a catalog to admit them. */
  const skillsConfigured = options.skills !== undefined && skillCatalog !== undefined;

  // AB-384 (Codex P2 review finding, PR #592, "Mint incarnations from the
  // Bureau's injected runtime"): `runtimeServices` (resolved above from
  // `options.runtime`, defaulting to the real globals) must be threaded
  // through here — omitting it would let `createSessionStore` silently
  // construct its OWN second default `RuntimeServices`, so every
  // `AgentSession.incarnation` it mints would come from real
  // `crypto.randomUUID()`/wall-clock time instead of the same injected
  // runtime every other subsystem this composition builds already uses,
  // breaking determinism for manual-runtime tests and fault-replay runs.
  const sessionStore = kv
    ? (dependencies.createSessionStore ?? createSessionStore)(kv, {
        runtime: runtimeServices,
        beforeCleanup: dependencies.beforeSessionCleanup,
      })
    : undefined;
  const baseToolbox: BureauToolbox = options.toolbox ?? createToolbox([], { context: {} });
  const hasSkillTools = options.skills !== undefined && options.skills.includeTools !== false;
  const fallbackToolbox: BureauToolbox =
    options.toolbox !== undefined || hasSkillTools ? baseToolbox : createUnavailableToolbox();

  const baseProviders =
    options.providers ??
    (options.provider
      ? [
          {
            name: 'default',
            provider: options.provider,
          },
        ]
      : []);
  const routingStrategy =
    options.routing && baseProviders.length > 1
      ? createRoutingStrategy(options.routing)
      : undefined;

  const skillToolSummaries: ToolSummary[] =
    options.skills?.includeTools === false
      ? []
      : options.skills
        ? [
            {
              name: 'activate_skill',
              description:
                'Activate a skill by name. Returns the skill instructions and available resources.',
            },
            {
              name: 'load_skill_resource',
              description: 'Load a resource file from an active skill.',
            },
            {
              name: 'deactivate_skill',
              description: 'Deactivate a skill and remove it from the active set.',
            },
            {
              name: 'list_skills',
              description: 'List available skills and whether they are active.',
            },
          ]
        : [];

  function getToolSummaries(): ToolSummary[] {
    const toolInspections = baseToolbox.inspect('summary').tools;
    return [
      ...toolInspections.map((toolInspection) => ({
        name: toolInspection.name,
        description: toolInspection.description,
      })),
      ...skillToolSummaries,
    ];
  }

  function composeConfiguredGenerate(
    streamEventTarget: TypedEventTarget<StreamEventMap> | undefined,
  ): GenerateFunction | undefined {
    let generate: GenerateFunction | undefined = options.generate;

    if (!generate) {
      if (baseProviders.length === 0) {
        return undefined;
      }

      if (routingStrategy && baseProviders.length > 1) {
        const routes = baseProviders.map((route) => ({
          name: route.name,
          generate: dependencies.resolveProviderGenerate(
            route.provider,
            streamEventTarget,
            options.streaming,
          ),
        }));

        const routingGenerate = createRoutingGenerate({
          routes,
          fallback: routes[0]!.name,
          strategy: routingStrategy.strategy,
        });

        generate =
          routingStrategy.kind === 'cost-aware'
            ? withUsageTracking(routingGenerate, routingStrategy.onUsage)
            : routingGenerate;
      } else if (baseProviders.length > 1) {
        generate = createFalloverGenerate({
          providers: baseProviders.map((route) => ({
            name: route.name,
            generate: dependencies.resolveProviderGenerate(
              route.provider,
              streamEventTarget,
              options.streaming,
            ),
          })),
        });
      } else {
        generate = dependencies.resolveProviderGenerate(
          baseProviders[0]!.provider,
          streamEventTarget,
          options.streaming,
        );
      }
    }

    return applyCache(generate, options.cache, kv);
  }

  const nonStreamingGenerate = composeConfiguredGenerate(undefined);
  const schedulerGenerate = nonStreamingGenerate;

  const scheduler =
    schedulerGenerate && options.scheduler?.enabled === true
      ? createScheduler({
          generate: schedulerGenerate,
          toolbox: fallbackToolbox,
          idleDelay: options.scheduler?.idleDelay ?? 1000,
          retentionWindowMs:
            options.scheduler?.retentionWindowMs ?? DEFAULT_SCHEDULER_RETENTION_WINDOW_MS,
          // The composed runtime, so idle/wake and retention timers are
          // deterministic under a manual runtime.
          runtime: runtimeServices,
          // When a durable engine is composed, preemptable scheduler tasks run as
          // durable workflows and a preemption SUSPENDS the run (preserving its
          // checkpoint) rather than aborting it — a requeue resumes from the last
          // completed step. Without an engine the scheduler stays in-memory.
          ...(durable
            ? { durable: { engine: durable.engine, checkpointStore: durable.checkpointStore } }
            : {}),
        })
      : undefined;

  if (scheduler) {
    scheduler.start();
  }

  /**
   * The guardrail configuration in force for this composition, with `false`
   * narrowed away so a caller sees a real configuration or nothing.
   *
   * AB-40 — `undefined` (not configured) wires the enabled-by-default preset;
   * `false` opts out entirely; anything else replaces the preset. A pure
   * function of `options`, hoisted to composition scope because
   * {@link createBureauInvariantHooks} needs the same answer for a run that
   * never goes through `createRunRuntime` at all.
   */
  function resolveGuardrailsConfiguration(): GuardrailsOptions | undefined {
    const resolved =
      options.guardrails === undefined ? createDefaultGuardrailsPreset() : options.guardrails;
    return resolved === false ? undefined : resolved;
  }

  /** {@link RuntimeComposition.mediaOptionsFor}. */
  function mediaOptionsFor(
    principalId: string | undefined,
    rowHolder: MediaRowHolder,
  ): MediaRunOptions {
    const resolver = dependencies.contentSourceResolverFor?.(principalId);
    const admitter = dependencies.generatedMediaAdmitterFor?.(principalId, rowHolder);
    const assetSafety = resolveGuardrailsConfiguration()?.input?.assetSafety;
    return {
      ...(resolver === undefined ? {} : { contentSourceResolver: resolver }),
      ...(admitter === undefined ? {} : { generatedMediaAdmitter: admitter }),
      ...(assetSafety === undefined ? {} : { assetSafety }),
    };
  }

  /**
   * The Bureau invariants that do not close over a run (COR-1265 criterion 3b,
   * owner ruling 2026-09-20).
   *
   * A catalog-dispatched run resolves its provider, toolbox, memory and skills
   * through the catalog agent's OWN `OPERATIVE_RESOLVE_RUN_OPTIONS`, never
   * through `createRunRuntime` — that separation is AB-240's point and its
   * rollback trigger. Bureau's hooks were absent from those runs entirely, which
   * was survivable only while no tier reached them at all; once the agent tier
   * became real, a catalog run would carry its agent's hooks and none of
   * Bureau's policy, which contradicts COR-567's non-bypassable invariants.
   *
   * The whole Bureau tier cannot travel there. `bureau:memory-recall`,
   * `bureau:memory-persist`, the skill hooks and `bureau:skill-record-snapshot`
   * close over this run's session, memory and skill session, and a catalog run
   * has none of them. The three that close over composition-level configuration
   * only — the identity prompt and both guardrails — do, and they are exactly
   * the registrations COR-567's "non-bypassable Bureau invariant hooks" section
   * names.
   *
   * A fresh registry, and a fresh `createGuardrails`, per call: the guardrail
   * carries per-run taint state, so sharing one across catalog runs would leak
   * one run's detections into another.
   *
   * This does not reach every catalog path. A non-durable dispatch of a catalog
   * agent that exposes no `OPERATIVE_RESOLVE_RUN_OPTIONS` goes straight to
   * `agent.run()` with no `RunOptions` for anyone to augment; there is no seam
   * short of a caller-facing hook field, which COR-567 Decision 4 declines. See
   * `documentation/hierarchical-hook-composition.md`.
   */
  function createBureauInvariantHooks(
    goalAttempt?: GoalAttemptTarget,
    invariantOptions?: BureauInvariantOptions,
  ): HookRegistry<OperativeHookMap> {
    const invariants = new HookRegistry<OperativeHookMap>({ source: BUREAU_HOOK_TIER });
    // First, so no other `prepareStep` handler (the guardrail scan included)
    // runs for a step the goal no longer allows. This is the one invariant that
    // closes over a run, and only a goal attempt's run is given it.
    if (goalAttempt !== undefined && dependencies.goalAttemptFence !== undefined) {
      registerGoalAttemptFence(invariants, dependencies.goalAttemptFence, goalAttempt, {
        runtime: runtimeServices,
      });
    }
    if (options.identity) {
      registerIdentityInvariant(invariants, options.identity);
    }
    // COR-1367 — an agent that resolves its own guardrails was handed this
    // bureau's policy through `inheritedGuardrails` (see
    // `catalogRunGuardrailsContext`) and applies it in its own tier, so
    // registering it here as well would run the same policy twice.
    const guardrailsConfig =
      invariantOptions?.agentResolvesGuardrails === true
        ? undefined
        : resolveGuardrailsConfiguration();
    if (guardrailsConfig) {
      registerGuardrailInvariants(invariants, createGuardrails(guardrailsConfig));
    }
    return invariants;
  }

  function createRunRuntime(
    request: CreateRunRequest & { sessionId: string; runId?: string },
    runtimeOptions?: {
      liveStreaming?: boolean;
      /**
       * Active-skill entries to seed the run's {@link SkillSession} with on
       * construction. Used by the durable recovery path: when
       * `buildRunDepsFromSession` rebuilds deps for a recovered run, it reads the
       * `activeSkillRecords` snapshot from session metadata and passes it here so the
       * recovered toolbox is aware of skills activated in completed pre-crash steps
       * (those steps are memoized and do not re-run their `activate_skill` calls).
       */

      /**
       * Provenance-carrying records for the catalog-backed path.
       *
       * Recovery
       * re-validates these against the live catalog and re-checks each digest, so a skill whose
       * source was revoked or whose content drifted does not come back.
       */
      initialActiveSkillRecords?: ReadonlyArray<SkillActivationRecord> | undefined;

      /**
       * COR-1577 — the named catalog agent this session run executes. Its `generate` and toolbox
       * replace the Bureau-wide ones; everything else the Bureau composes around a run still
       * applies.
       */
      sessionAgent?: SessionAgentRun | undefined;

      /**
       * COR-1546 — the run's owner of record, which its memory is partitioned under: the session's
       * owner for a chat run, the schedule's for a fire, `anonymous:local` for a run no principal started
       * (the owner of anything created with none stated). A caller that omits it
       * gets the request authority's `ownerId`; `createBureau` always states it.
       */
      memoryOwner?: string | undefined;
      skillPolicyUnverifiable?: boolean | undefined;
    },
  ) {
    const liveStreaming = runtimeOptions?.liveStreaming ?? true;
    const sessionAgent = runtimeOptions?.sessionAgent;
    const requestContext = request.requestContext;
    // AB-40 — the auto-wired default guardrail preset (`options.guardrails ===
    // undefined`) runs its output PII validator in `mode: 'tripwire'` against
    // the FULL response content in `validateResponse`, which only runs after
    // `runStep`'s generate call returns. `withEnhancedStreaming` forwards
    // `stream:text-delta` events (and finalizes the streaming message) as the
    // provider streams, which happens entirely INSIDE that generate call —
    // before `validateResponse` ever sees the content. A streamed response
    // would therefore leak PII to clients before the default tripwire could
    // fire, defeating the preset's purpose. Force buffered (non-streaming)
    // generation whenever the default preset is in effect so the output
    // guardrail actually gates what reaches the client. A caller who
    // explicitly supplies `guardrails` (including re-supplying this same
    // preset) has opted into managing that tradeoff themselves and keeps
    // streaming.
    const usingDefaultGuardrailsPreset = options.guardrails === undefined;
    const streamEventTarget =
      !liveStreaming ||
      // A named agent's own `generate` is not wrapped for live token streaming.
      sessionAgent !== undefined ||
      options.generate !== undefined ||
      options.streaming?.enabled === false ||
      usingDefaultGuardrailsPreset
        ? undefined
        : new TypedEventTarget<StreamEventMap>();
    const generate =
      sessionAgent !== undefined
        ? sessionAgent.options.generate
        : streamEventTarget === undefined
          ? nonStreamingGenerate
          : composeConfiguredGenerate(streamEventTarget);

    if (!generate) {
      throw new Error('No generate function configured');
    }

    // Clone the toolbox for this run so concurrent runs do not share a single
    // CompletableEventTarget emitter. A shared emitter would route every tool.*
    // event (execute-start, settled, …) to ALL runs that have subscribed, causing
    // cross-run event pollution and shared budget/loop-detector state.
    // `extend()` (no args) creates a fresh toolbox with a new emitter while
    // preserving all tool configurations, context, and policy from the original.
    // The unavailable-toolbox sentinel (no user toolbox, no skill tools) is
    // structurally distinct (custom throwing execute) and must be freshly
    // instantiated per-call via createUnavailableToolbox() instead.
    //
    // The skills path below calls combineToolboxes(toolbox, skillToolbox) which
    // always creates a fresh toolbox — so cloning here also means the combined
    // result is based on a per-run clone, which is correct.
    //
    // COR-1577 — a named agent's resolved toolbox is its own: `createAgent` builds a fresh one
    // per resolution unless the agent was handed a shared toolbox, which `extend()` clones for
    // the same cross-run isolation the Bureau-wide toolbox gets.
    let toolbox: AnyToolbox =
      sessionAgent !== undefined
        ? sessionAgent.options.toolbox.extend()
        : options.toolbox !== undefined
          ? baseToolbox.extend()
          : hasSkillTools
            ? fallbackToolbox.extend()
            : createUnavailableToolbox();
    // COR-567 — one registry per run. Per-run rather than per-composition
    // because these hooks close over this run's session, memory and skill
    // session; a registry shared across runs would leak one run's state into
    // another exactly the way the per-run toolbox clone above exists to
    // prevent.
    //
    // Registration order is the order the legacy arrays ran in, and every id
    // below is explicit: a generated `<hookName>#<n>` would renumber whenever
    // an earlier conditional block stops registering, so an observer
    // correlating across runs would see the same hook under different names
    // depending on whether memory or skills happened to be configured.
    // COR-1265 — `source` names the owning tier once, and `on()` stamps it onto
    // every entry. On the entry rather than only here because a merged plan has
    // one registry and many tiers: afterwards this object can no longer say
    // where an entry came from, but the entry still can.
    const hooks = new HookRegistry<OperativeHookMap>({ source: BUREAU_HOOK_TIER });
    let getActiveSkillRecords = (): readonly SkillActivationRecord[] => [];
    let getActiveSkillToolPolicy: (() => ToolPolicy | undefined) | undefined;
    // COR-1620: set when the policy that governs the run cannot be verified, from the start or
    // once a stored skill is refused on recovery. The run then offers no tool and writes no
    // skill snapshot, so what it persisted before is kept, and an approval it raises is refused
    // at approve.
    let skillPolicyUnverified = runtimeOptions?.skillPolicyUnverifiable === true;

    if (options.identity) {
      registerIdentityInvariant(hooks, options.identity);
    }

    // COR-41 — memory hooks run only under a persisted request authority. A
    // recovered run whose authority could not be restored gets none: no
    // conversation can reach memory outside the authority it was granted.
    const memoryAuthority =
      memory && requestContext
        ? createRunMemoryAuthority(
            requestContext,
            {
              runId: request.runId ?? request.sessionId,
              tenantId: memoryTenantId(),
              // A caller that states no owner (a composition used directly) is partitioned by the request
              // authority's own owner, so two requests never share one partition.
              ownerId: ownerOrLocal(
                runtimeOptions?.memoryOwner ?? requestContext.authority.ownerId,
              ),
            },
            options.memoryAuthority,
          )
        : undefined;
    // COR-1546 — an agent remembers across every chat its owner has with it, so the collection is
    // the agent's identifier and never the session's.
    const memoryTarget: RunMemoryTarget = {
      collection: request.agentName ?? requestContext?.agentId ?? defaultBureauAgentName,
      sessionId: request.sessionId,
    };
    if (memory && memoryAuthority) {
      hooks.on('prepareStep', createMemoryRecallHook(memory, memoryAuthority, memoryTarget), {
        id: 'bureau:memory-recall',
        // Recall admission records the read and can quarantine a poisoned
        // record; both are idempotent on a replayed step.
        replay: 'effectful',
      });
      hooks.on(
        'onStep',
        createMemoryPersistHook(memory, memoryAuthority, memoryTarget, request.runId, (receipt) =>
          diagnose({
            level: 'warn',
            scope: 'memory',
            message:
              `[bureau] Governed memory rejected the answer of run "${request.runId ?? request.sessionId}" ` +
              `for agent "${memoryTarget.collection}" (${receipt.reason ?? 'no reason given'}), so it was not remembered.`,
          }),
        ),
        {
          id: 'bureau:memory-persist',
          // Writes to the memory store, so a replayed step writes again. The
          // classification records that at-least-once contract; it does not
          // suppress the second write, which would drop the persistence for a
          // step whose generation genuinely re-ran.
          replay: 'effectful',
        },
      );
    }

    // COR-1226 — resolved here rather than at the hook-registration site below,
    // because the skill toolbox needs the same detectors and the same session
    // taint tracker, and it is constructed before that point. `createGuardrails`
    // is a pure function of its options, so calling it earlier changes nothing
    // about what it returns.
    const guardrailsConfig = resolveGuardrailsConfiguration();
    const guardrails = guardrailsConfig ? createGuardrails(guardrailsConfig) : undefined;

    // COR-1226 — skill bodies and skill resources are untrusted instruction
    // input and must pass the same detector pipeline as anything else entering
    // context. `GuardrailHooks.taint`'s own doc comment names skill resources
    // as one of the retrieval surfaces that cannot reach the model through
    // `prepareStep`/`validateResponse` and so must scan directly and fold its
    // detections back into the session-wide taint state. The wiring is
    // `createSkillGuardrailOptions` from `./agent-skills`, which
    // `createAgentSkills` uses for per-agent skills too (COR-1367), so the
    // two paths cannot drift.
    const skillGuardrail =
      guardrails && guardrailsConfig
        ? createSkillGuardrailOptions(guardrailsConfig, guardrails)
        : undefined;

    let skillRecovery: Promise<SkillRecoveryOutcome> | undefined;
    if (options.skills && skillCatalog !== undefined) {
      // COR-892 — the catalog-backed path. Bureau composes policy and durability *around*
      // Agent-owned behaviour rather than reimplementing it: discovery, trust admission,
      // digest-verified activation and the active set all live in `@lostgradient/bureau/skills`, and what
      // Bureau adds here is the run and session correlation the client cannot see, plus durable
      // persistence of what the client decided.
      const skillClient = createSkillClient({
        catalog: skillCatalog,
        // Routed by source kind rather than fixed to the filesystem: a catalog can mix a host's
        // filesystem roots with the bureau's own store, and a `storage` record's `sourceLocation`
        // is a store namespace that no filesystem read can follow.
        loadArtifact: createSkillArtifactLoader(kv === undefined ? {} : { storage: kv }),
        // COR-1226's scan, carried onto the client path. Migrating without it would have created
        // the guardrail bypass COR-892 names: skill bodies are untrusted instruction input and
        // pass the same detector pipeline as anything else entering context.
        ...(skillGuardrail === undefined ? {} : { guardrail: skillGuardrail }),
        ...(skillEvents === undefined ? {} : { events: skillEvents }),
        correlation: {
          ...(request.runId === undefined ? {} : { runId: request.runId }),
          sessionId: request.sessionId,
          ...(request.agentName === undefined ? {} : { agentName: request.agentName }),
        },
      });

      // Recovery before anything else reads the active set: a resumed run must re-validate every
      // stored record against the live catalog and re-check its digest, so a skill whose source
      // was revoked or whose content drifted while the run was away does not come back.
      const recoverable = runtimeOptions?.initialActiveSkillRecords;
      if (recoverable !== undefined && recoverable.length > 0) {
        // Detached deliberately: composition is synchronous, and recovery re-reads bundles. The
        // first step's `prepareStep` awaits the same promise below, so nothing reads a half-filled
        // active set.
        skillRecovery = skillClient.recover(recoverable).then((outcome) => {
          if (outcome.refused.length > 0) skillPolicyUnverified = true;
          return outcome;
        });
      }

      // The records verbatim, not a name-and-policy projection of them. The projection was what
      // the provider-backed snapshot could carry; narrowing to it here would throw away the
      // provenance every reader of this snapshot now depends on.
      getActiveSkillRecords = () => skillClient.activationRecords();
      getActiveSkillToolPolicy = () => {
        const narrowed = skillClient.narrowedTools();
        return narrowed === undefined ? undefined : { allowList: [...narrowed] };
      };

      if (options.skills.includeTools !== false) {
        const skillToolset = createSkillClientToolbox(
          skillClient,
          skillGuardrail === undefined ? undefined : { guardrail: skillGuardrail },
        );
        // `undefined` when the admitted catalog is empty, so no skill tool is exposed at all —
        // a model handed `activate_skill` against an empty catalog invents a name to pass it.
        if (skillToolset !== undefined) {
          hooks.on(
            'prepareStep',
            (context) => {
              if (context.step !== 0) return Promise.resolve();
              const rendered = renderClientCatalog(skillClient);
              if (rendered !== undefined) {
                context.conversation.appendSystemMessage(rendered, {
                  _skillCatalogInjected: true,
                });
              }
              return Promise.resolve();
            },
            {
              id: 'bureau:skill-client-catalog',
              // Reads the client's frozen catalog revision and appends to the
              // step's conversation; nothing outside it is touched.
              replay: 'safe',
            },
          );

          toolbox = combineToolboxes(
            toolbox,
            createToolbox([
              skillToolset.activateSkill,
              skillToolset.loadSkillResource,
              skillToolset.deactivateSkill,
            ]) as AnyToolbox,
          );
        }
      }

      // Active instructions are re-rendered every step rather than left in the transcript, which
      // is what makes them survive a compaction strategy that rewrote the whole history.
      hooks.on(
        'prepareStep',
        async (context) => {
          // Recovery settles before the first step reads the active set, so nothing renders a
          // half-filled one.
          if (skillRecovery !== undefined) await skillRecovery;
          const instructions = renderActiveSkillInstructions(skillClient.active());
          if (instructions !== undefined) {
            context.conversation.appendSystemMessage(instructions, { _skillContentInjected: true });
          }
        },
        {
          id: 'bureau:skill-client-instructions',
          // Renders the active set into the step's conversation. Re-rendering on
          // a replayed step is the point — see the comment above — and reaches
          // nothing outside that conversation.
          replay: 'safe',
        },
      );

      if (sessionStore) {
        const writeSkillSnapshot = createSkillRecordSnapshotHook(
          skillClient,
          skillCatalog,
          request.sessionId,
          sessionStore,
          request.runId,
        );
        hooks.on(
          'onStep',
          async (context) => {
            // What an unverified policy persisted before is kept: a snapshot of the skills this
            // run holds now would replace the one that governs the call.
            if (!skillPolicyUnverified) await writeSkillSnapshot(context);
          },
          {
            id: 'bureau:skill-record-snapshot',
            // Writes the activation records to the session store.
            replay: 'effectful',
          },
        );
      }
    }

    // AB-40 — `undefined` (not configured) wires the enabled-by-default
    // preset; `false` opts out entirely; anything else replaces the preset.
    // COR-1577 — an agent that resolves its own guardrails was handed this bureau's policy as
    // its inherited one and applies it in its own hook tier, exactly as a catalog dispatch does.
    if (guardrails && sessionAgent?.agentResolvesGuardrails !== true) {
      // Registered last on `prepareStep`, as the array push order had it, so
      // the input guardrail scans a step context every earlier hook has
      // already contributed to rather than one they then append to.
      registerGuardrailInvariants(hooks, guardrails);
    }

    // Records the run was given but no skill client is configured to enforce cannot be honoured.
    if (!skillsConfigured && (runtimeOptions?.initialActiveSkillRecords?.length ?? 0) > 0) {
      skillPolicyUnverified = true;
    }
    const skillToolPolicy: (() => ToolPolicy | undefined) | undefined =
      getActiveSkillToolPolicy === undefined && !skillPolicyUnverified
        ? undefined
        : () => (skillPolicyUnverified ? { allowList: [] } : getActiveSkillToolPolicy?.());
    const runToolbox = withDefaultToolboxRequestContext(
      // COR-1228 — narrow by active-skill policy first, then apply the request
      // context. Order matters only for readability here: both are proxies and
      // neither observes the other, but filtering nearest the toolbox keeps the
      // request-context wrapper the outermost thing a caller sees.
      skillToolPolicy ? withActiveSkillToolPolicy(toolbox, skillToolPolicy) : toolbox,
      requestContext,
      () => requestAuthorityValidator,
      runtimeServices,
    );
    return Promise.resolve({
      generate,
      toolbox: runToolbox,
      hooks,
      streamEventTarget,
      getActiveSkillRecords,
      // Records the run was given but no skill client is configured to enforce: all are refused.
      skillPolicyUnverified: () => skillPolicyUnverified,
      skillsRecovered:
        skillRecovery ??
        Promise.resolve({
          recovered: [],
          refused: (runtimeOptions?.initialActiveSkillRecords ?? []).map((record) => record.name),
        }),
    });
  }

  /**
   * COR-1586 — the resolver a reader needs. The engine reclaims runs on its own interval from the
   * moment it exists, which is before `createBureau` has built the catalog the resolver reads, so
   * a reader that finds the resolver unset waits for it when the caller said one is coming (see
   * `awaitsCatalogAgentRunOptionsResolver`), saying once, as a `warn`, which run it is holding.
   * `absent` is the answer of a composition that was never told to expect one, or whose resolver
   * was cleared again; `abandoned` is the answer once the caller gave up on wiring it.
   */
  async function awaitCatalogAgentRunOptionsResolver(
    runId: string | undefined,
  ): Promise<
    | { status: 'wired'; resolver: CatalogAgentRunOptionsResolver }
    | { status: 'absent' }
    | { status: 'abandoned'; reason: string }
  > {
    // Abandonment is terminal: a composition whose Bureau failed to build answers every reader
    // with the failure, even if a resolver was wired before it failed.
    if (catalogResolverAbandonedReason !== undefined) {
      return { status: 'abandoned', reason: catalogResolverAbandonedReason };
    }
    if (catalogAgentRunOptionsResolver) {
      return { status: 'wired', resolver: catalogAgentRunOptionsResolver };
    }
    if (dependencies.awaitsCatalogAgentRunOptionsResolver !== true) return { status: 'absent' };
    if (!catalogResolverGateOpen) {
      diagnose({
        level: 'warn',
        scope: 'recovery',
        message:
          `[bureau] ${runId === undefined || runId === '' ? 'A run' : `Run "${runId}"`} needs the ` +
          `agent run options resolver before the bureau has wired it; holding it until the ` +
          `bureau finishes building its agent catalog.`,
      });
      await catalogResolverGate.promise;
    }
    // Re-read after the wait: the gate opened because the resolver was wired or abandoned.
    if (catalogResolverAbandonedReason !== undefined) {
      return { status: 'abandoned', reason: catalogResolverAbandonedReason };
    }
    return catalogAgentRunOptionsResolver
      ? { status: 'wired', resolver: catalogAgentRunOptionsResolver }
      : { status: 'absent' };
  }

  /**
   * COR-1577 — resolve the catalog agent a session run names, through the resolver `createBureau`
   * wires for catalog dispatch and boot recovery, so a session run and a catalog run of the same
   * agent resolve identically. The placeholder input is discarded: only the run options and the
   * system prompt the definition would seed are read from the result.
   */
  async function resolveSessionAgentRun(
    agentName: string,
    runId: string,
    principal?: string,
    recorded?: CatalogRunRecordedDefinition,
  ): Promise<SessionAgentRunResolution> {
    const wired = await awaitCatalogAgentRunOptionsResolver(runId);
    if (wired.status === 'absent') {
      return { status: 'resolver-failed', error: new Error('No catalog agent resolver is wired.') };
    }
    if (wired.status === 'abandoned') {
      return { status: 'resolver-failed', error: new Error(wired.reason) };
    }
    const resolution = await wired.resolver(
      agentName,
      SESSION_AGENT_PLACEHOLDER_INPUT,
      { agentName, ...(principal === undefined ? {} : { principal }) },
      runId,
      ...(recorded === undefined ? [] : [recorded]),
    );
    if (resolution.status !== 'resolved') return resolution;
    return {
      status: 'resolved',
      run: {
        agentName,
        options: resolution.options,
        definitionRevision: resolution.definitionRevision,
        ...(resolution.agentBinding === undefined ? {} : { agentBinding: resolution.agentBinding }),
        agentResolvesGuardrails: resolution.agentResolvesGuardrails === true,
        instructions: agentInstructionsFromRunOptions(resolution.options),
      },
    };
  }

  /**
   * Rebuild a recovered run's non-serializable {@link DurableRunDeps} from durable
   * config: reconstruct the run runtime from the owning session's persisted
   * request — the same `createRunRuntime` a fresh run uses. Its one caller
   * (`resolveRunServices`, below) already narrows `session` non-null before
   * calling this, so the parameter is typed non-optional rather than
   * defending an absent-session case nothing reaches — AB-260 removed the
   * `null`-returning branch this used to have, which was covered only
   * through the retired `setBuildRunDepsFromSession` override seam.
   *
   * The reconstructed `conversation` is a placeholder: a resumed run reads its
   * transcript from the checkpoint, not from `options.conversation`. Weft's
   * awaited recovery hook attaches the live emitter after these services are
   * rebuilt and before resumed user code advances.
   */
  async function buildRunDepsFromSession(
    session: AgentSession,
    runId?: string,
    agentName?: string,
  ): Promise<DurableRunDeps> {
    const message = session.metadata['lastUserMessage'];
    // Recover the per-request token cap persisted by create-bureau's saveSession
    // call. Without this, recovered generate calls receive maximumTokens:undefined
    // and may produce more output than the original client cap allowed, changing
    // cost and output length after a process crash (PRRT_kwDORvupsc6MZEri).
    const maximumTokensRaw = session.metadata['lastMaximumTokens'];
    const maximumTokens = typeof maximumTokensRaw === 'number' ? maximumTokensRaw : undefined;
    // Restore the per-request step cap from session metadata so a recovered run
    // honours the caller's original maximumSteps rather than the bureau default
    // (PRRT_kwDORvupsc6MZfl5). Absent that, the named agent's cap, then the default
    // `maximumSteps` closure value (COR-1577).
    const maximumStepsRaw = session.metadata['lastMaximumSteps'];
    // Rehydrate the active skill set from the last-written snapshot so the
    // recovered toolbox is aware of skills activated in completed pre-crash steps.
    // Completed steps are memoized by Weft and do not re-run their tool executions,
    // so a fresh SkillSession would be unaware of any `activate_skill` calls made
    // before the crash. `activeSkillRecords` is written by createSkillRecordSnapshotHook after
    // each step boundary and is validated here before use (PRRT_kwDORvupsc6MZ1Md).
    // COR-1620: the snapshot it can verify, or none and no tools: a reattached run whose policy
    // cannot be verified, or whose stored skill the catalog refuses, is offered no tool, has its
    // approvals refused at approve, and keeps the snapshot it has.
    const skillSnapshot: SkillSnapshot =
      runId === undefined
        ? { status: 'verified', records: undefined }
        : readSessionSkillSnapshot(session, runId);
    const initialActiveSkillRecords =
      skillSnapshot.status === 'verified' ? skillSnapshot.records : undefined;
    const requestContext = recoveredRequestContext(
      session.metadata,
      runId,
      session.id,
      agentName,
      runtimeServices.clock.now,
    );
    // COR-1577 — a recovered named run resumes under its agent, by the catalog path's policy: an
    // agent gone from the catalog fails the run, and a definition that changed since the run
    // started is logged and the current one runs.
    const sessionAgent = await resolveRecoveredSessionAgent(session, runId, agentName);
    const runRuntime = await createRunRuntime(
      {
        message: typeof message === 'string' ? message : '',
        sessionId: session.id,
        // Thread the recovered run's id so the memory-persist hook's idempotency
        // key (`${runId}:${step}`) matches the pre-crash execution — the durable
        // recovery path is one place the at-least-once re-fire happens.
        ...(runId !== undefined ? { runId } : {}),
        ...(agentName !== undefined ? { agentName } : {}),
        ...(requestContext ? { requestContext } : {}),
      },
      {
        liveStreaming: false,
        initialActiveSkillRecords,
        skillPolicyUnverifiable: skillSnapshot.status === 'unverifiable',
        sessionAgent,
        memoryOwner: resolveRunMemoryOwner(session.metadata, runId),
      },
    );
    const skillRecovery = await runRuntime.skillsRecovered;
    if (skillSnapshot.status === 'unverifiable' || skillRecovery.refused.length > 0) {
      options.onLog?.({
        workflowId: runId ?? session.id,
        workflowType: 'agentRun',
        timestamp: runtimeServices.clock.now(),
        level: 'warn',
        message: `Session run "${runId ?? session.id}" is reattached without tools: its skill policy cannot be verified (${
          skillSnapshot.status === 'unverifiable'
            ? skillSnapshot.reason
            : `a stored skill was refused on recovery: ${skillRecovery.refused.join(', ')}`
        }).`,
      });
    }

    // AB-336: wire `requestHumanInput`/`scheduleWakeup` in on the RECOVERY
    // path too — see `wireDurableOptInTools`'s own doc comment for the root
    // cause this closes. `servicesRef.current` is assigned to `services`
    // itself, synchronously, below (no `onServices` hook needed here: unlike
    // `createRunFromRequest`'s fresh dispatch, this function already holds
    // the exact object Weft will hand back as `ctx.services` — it's what
    // this function returns).
    let runToolbox: BureauToolbox = runRuntime.toolbox;
    const servicesRef: { current?: DurableRunDeps } = {};
    const wantsHumanInput = options.humanInput === true && runId !== undefined;
    const wantsWakeup = options.wakeup === true && runId !== undefined;
    if (wantsHumanInput || wantsWakeup) {
      runToolbox = wireDurableOptInTools(runRuntime.toolbox, servicesRef, {
        humanInput: wantsHumanInput,
        wakeup: wantsWakeup,
        // `runId` is non-undefined here (both `wantsHumanInput`/`wantsWakeup`
        // require it); `?? ''` only satisfies the type checker.
        runId: runId ?? '',
        ...(wantsHumanInput
          ? {
              // `DurableRunDeps.emitter` isn't assigned until AFTER this
              // function returns — `createRecoveredRunEventSurface` sets it
              // on the SAME `services` object this closure is about to
              // construct and hand back (see `onRecoveredWorkflow` in
              // `create-bureau.ts`). This forwarder reads it lazily, at
              // actual tool-call time, by which point it has settled;
              // `hasDispatchEvent` narrows without a cast, since
              // `DurableRunDeps.emitter`'s own `EventDispatcher` type
              // declares only `dispatch`, not the DOM-style `dispatchEvent`
              // every real emitter (a `CompletableEventTarget`) also has.
              humanInputEmitter: {
                dispatchEvent: (event: Event) => {
                  const target = servicesRef.current?.emitter;
                  return hasDispatchEvent(target) ? target.dispatchEvent(event) : false;
                },
              },
            }
          : {}),
      });
    }

    const services: DurableRunDeps = {
      toolbox: runToolbox,
      getStepMetadata: () =>
        runRuntime.skillPolicyUnverified()
          ? {}
          : {
              [activeSkillsStepMetadataKey]: activeSkillsStepMetadata(
                runRuntime.getActiveSkillRecords(),
              ),
            },
      options: {
        generate: runRuntime.generate,
        toolbox: runToolbox,
        conversation: new Conversation(session.conversationHistory),
        ...copyAgentOwnedRunOptions(sessionAgent?.options),
        // COR-1577 — the request's cap persisted at the start, then the named agent's, then the
        // Bureau's default; a run with no named agent keeps the Bureau's.
        // The run's owner of record, not its per-run service principal: a managed asset
        // resolves for whoever owns the session, as it did before the crash.
        ...sessionRunMediaOptions(
          sessionAgent,
          mediaOptionsFor(resolveSessionOwner(session.metadata), 'session'),
        ),
        maximumSteps:
          typeof maximumStepsRaw === 'number'
            ? maximumStepsRaw
            : (sessionAgent?.options.maximumSteps ?? maximumSteps),
        stopWhen: sessionAgent?.options.stopWhen ?? options.stopWhen,
        // COR-1269 — stamped onto this run's hook-plan observations.
        sessionId: session.id,
        // COR-1265 — the completed Bureau tier, snapshotted. A single-tier
        // merge still copies every entry into a fresh registry, so a
        // registration added to `runRuntime.hooks` after this point cannot
        // reach the run that already holds the copy. COR-1577 — a named agent's own tier
        // follows it, as on a catalog dispatch.
        hooks: mergeHookRegistries(runRuntime.hooks, sessionAgent?.options.hooks),
        // AB-260: the bureau's single composed RuntimeServices instance,
        // snapshotted into every run it starts — including a recovered run
        // rebuilt here from a persisted session.
        runtime: runtimeServices,
        executeOptions: sessionExecuteOptions(sessionAgent?.options, requestContext),
        // Thread agentName and runId so curated tool.* bubble events stamped by
        // the resumed run carry the same {agentName, runId, step} metadata as the
        // pre-crash run (C3 parity). Without them, recovered runs emit blank ids.
        ...(agentName !== undefined ? { agentName } : {}),
        ...(runId !== undefined ? { runId } : {}),
        // Restore the per-request token cap so recovered steps honour the same
        // maximumTokens constraint as the original run (PRRT_kwDORvupsc6MZEri).
        ...(maximumTokens !== undefined
          ? { maximumTokens }
          : sessionAgent?.options.maximumTokens !== undefined
            ? { maximumTokens: sessionAgent.options.maximumTokens }
            : {}),
      },
    };
    if (wantsHumanInput || wantsWakeup) {
      servicesRef.current = services;
    }
    recordRecoveredSkillPolicy(runToolbox, {
      scheduledFire: false,
      agentName: agentName ?? session.agentName,
      sessionAgent,
      recordsKey: JSON.stringify(initialActiveSkillRecords ?? []),
      recoveredCleanly: skillSnapshot.status === 'verified' && skillRecovery.refused.length === 0,
    });
    return services;
  }

  /** The agent a recovered session run belongs to, or `undefined` for the default agent. */
  async function resolveRecoveredSessionAgent(
    session: AgentSession,
    runId: string | undefined,
    agentName: string | undefined,
  ): Promise<SessionAgentRun | undefined> {
    if (agentName === undefined || agentName === BUREAU_AGENT_NAME) return undefined;
    // A composition with no catalog wired (`createBureau` always wires one) has no named agents,
    // so the name is only a label and the run is the Bureau-wide runtime's. A Bureau that is
    // still being built has one coming, and the run waits for it (COR-1586): resuming it under the
    // Bureau-wide runtime would be resuming it under the wrong agent.
    const wired = await awaitCatalogAgentRunOptionsResolver(runId);
    const label = runId === undefined ? 'a recovered run' : `run ${runId}`;
    if (wired.status === 'absent') return undefined;
    if (wired.status === 'abandoned') throw new Error(`${label}: ${wired.reason}`);
    const owner = resolveSessionOwner(session.metadata);
    const recordedHash = session.metadata[SESSION_AGENT_DEFINITION_HASH_METADATA_KEY];
    const resolution = await resolveSessionAgentRun(agentName, runId ?? '', owner, {
      agentDefinitionHash: typeof recordedHash === 'string' ? recordedHash : undefined,
      definitionRevision: sessionRecordedRevision(session.metadata, recordedHash),
    });
    if (resolution.status === 'missing-agent') {
      throw new Error(`${label}: catalog agent "${agentName}" is no longer in the catalog`);
    }
    if (resolution.status === 'not-durable-capable') {
      throw new Error(
        `${label}: catalog agent "${agentName}" no longer supports durable definition ` +
          `resolution (OPERATIVE_RESOLVE_RUN_OPTIONS)`,
      );
    }
    if (resolution.status === 'resolver-failed') {
      throw new Error(
        `${label}: catalog agent "${agentName}" could not resolve run options during ` +
          `recovery: ${serializeUnknownError(resolution.error)}`,
      );
    }
    const startedAt = session.metadata[SESSION_AGENT_REVISION_METADATA_KEY];
    if (
      resolution.run.agentBinding === undefined &&
      typeof startedAt === 'number' &&
      startedAt !== resolution.run.definitionRevision
    ) {
      diagnose({
        level: 'warn',
        scope: 'recovery',
        message:
          `[bureau] Catalog agent "${agentName}" definition revision changed since ${label} ` +
          `started (was ${startedAt}, now ${resolution.run.definitionRevision}); ` +
          `resuming with the current definition.`,
      });
    }
    return resolution.run;
  }

  /**
   * Persist a scheduled run's conversation back to its session after EVERY
   * completed step (last-write-wins, idempotent). This is what makes the
   * recurring-conversation pattern work: fire N+1 loads the session this hook
   * last wrote, so the agent accumulates context across fires. For a
   * fresh-per-fire (stateless cron) session it records the fire's transcript so
   * the run is observable via `getSession`.
   *
   * Persisting on every step (not only `context.final`) is deliberate: a fire that
   * ends on `maximum-steps` — or any other non-`final` terminal outcome — still did
   * real work, but its last `StepResult.final` is `false`, so a final-only hook
   * would silently drop the whole fire from a recurring digest (review: codex
   * Mn69a). A step that throws before completing never reaches this hook, so a
   * step-0 failure (no assistant turn produced) is correctly NOT persisted — we
   * never seed a bare, reply-less user turn that the next fire would build on.
   *
   * Deliberately writes ONLY the conversation (no `lastRunStatus: 'running'`
   * lifecycle metadata): scheduled fires recover through Weft's handle monitor
   * rather than the bureau's interactive session ownership path, so a `running`
   * marker would only race any interactive run sharing the session.
   */
  function createScheduledSessionPersistHook(
    store: SessionStore,
    sessionId: string,
    agentName: string,
    baseConversationHistory: ConversationHistory,
    runId: string,
    replaceCurrentFireTranscript: boolean,
    getActiveSkillRecords: () => readonly SkillActivationRecord[],
    skillPolicyUnverified: () => boolean,
    owner: string,
    requestContext: ToolRequestContext,
  ): OnStepHook {
    let bound = false;
    return async (context) => {
      // COR-1596: a fire replaying after a crash may have left an approval in its session that
      // its checkpoint never held; only a replay can find one, so only a replay reads the
      // checkpoint, and reads it before the atomic update, which cannot wait on a read.
      let committedApprovals: ReadonlySet<string> | undefined;
      if (replaceCurrentFireTranscript && durable !== undefined) {
        try {
          // Strict, as every reader of the checkpoint for this is: a step record skipped is a
          // committed approval taken for an abandoned one.
          committedApprovals = committedFireApprovalIds(
            runId,
            await durable.checkpointStore.loadSteps(runId, { strict: true }),
          );
        } catch (error) {
          // A checkpoint that cannot be read drops nothing, and does not fail the fire's step:
          // the approvals it holds are checked at the next boot and when the fire settles.
          diagnose({
            level: 'error',
            scope: 'recovery',
            message: `[bureau] Could not read the checkpoint of replaying schedule fire "${runId}", so its session keeps the approvals it holds: ${serializeUnknownError(error)}`,
            cause: error,
          });
        }
      }
      const saved = await store.update(sessionId, (existing: AgentSession | undefined) => {
        const activeSkillRecords = getActiveSkillRecords();
        const sessionOwnedByAnotherRunningRun =
          existing?.metadata['lastRunStatus'] === 'running' &&
          typeof existing.metadata['lastRunId'] === 'string' &&
          existing.metadata['lastRunId'] !== runId;
        // Decided inside the atomic update: a fire that built its services while the
        // session did not exist must not append to a session another owner has
        // created since, or one that a concurrent fire created for another owner.
        if (existing !== undefined && !isSessionAuthorityAuthorized(existing.metadata, owner)) {
          throw new SessionOwnerConflictError(sessionId);
        }
        const next =
          existing ??
          createAgentSession({
            id: sessionId,
            agentName,
            conversationHistory: context.conversation.current,
          });
        const existingConversationHistory =
          replaceCurrentFireTranscript && existing
            ? removeLastScheduledFireTranscript(existing.conversationHistory, runId)
            : existing?.conversationHistory;
        return {
          ...next,
          metadata: {
            ...next.metadata,
            lastScheduledFireRunId: runId,
            // COR-718 — the fire's run is owned by the schedule's owner, recorded
            // where a restart rehydrates run owners from, and a session this fire
            // creates takes the same owner. An existing session keeps its own.
            lastRunOwningPrincipals: {
              ...(isPlainAuthorityRecord(next.metadata['lastRunOwningPrincipals'])
                ? next.metadata['lastRunOwningPrincipals']
                : {}),
              [runId]: owner,
            },
            ...(existing === undefined ? { [SESSION_OWNER_METADATA_KEY]: owner } : {}),
            ...(sessionOwnedByAnotherRunningRun || skillPolicyUnverified()
              ? {}
              : activeSkillSessionMetadataForStep(activeSkillRecords, context.step, runId)),
            // COR-1596 — a tool call this step left awaiting approval is recorded with the
            // conversation, so a restart can list it again.
            ...scheduledFireApprovalMetadata(
              next.metadata,
              runId,
              context.results,
              requestContext,
              committedApprovals,
            ),
          },
          conversationHistory: existingConversationHistory
            ? appendConversationMessages(
                existingConversationHistory,
                context.conversation.current,
                baseConversationHistory,
              )
            : context.conversation.current,
        };
      });
      // COR-1482: the first save of a fresh session gives it its incarnation, which the fire's
      // task is bound to once, so `bureau.tasks.list({ contextId })` finds the fire.
      if (!bound && saved !== undefined) {
        bound = true;
        await reportScheduledSession({ runId, sessionId, incarnation: saved.incarnation });
      }
    };
  }

  /**
   * AB-240: persist the catalog-run recovery record. Called from
   * `create-bureau.ts`'s `runAgent` durable branch BEFORE `createActiveRun`
   * starts the durable engine, so a crash immediately after start still has,
   * on the next boot, enough to reattach against the catalog agent's own
   * run options — see `resolveRunServices`'s catalog branch below. A no-op
   * when this composition has no durable storage (nothing to reattach
   * across a restart without one, matching the schedule-marker precedent
   * above); the caller only reaches this inside an `if (runtime.durable)`
   * guard, so `durableStorage` is defined whenever it actually matters.
   */
  async function persistCatalogRunRecoveryRecord(
    runId: string,
    record: Omit<CatalogRunRecoveryRecord, 'schemaVersion'>,
  ): Promise<void> {
    if (!durableStorage) return;
    const fullRecord: CatalogRunRecoveryRecord = { schemaVersion: 1, ...record };
    await durableStorage.put(catalogRunRecoveryKey(runId), encode(fullRecord));
  }

  async function claimCatalogRunRecoveryRecord(
    runId: string,
    record: Omit<CatalogRunRecoveryRecord, 'schemaVersion'>,
  ): Promise<boolean> {
    if (!durableStorage) return true;
    const key = catalogRunRecoveryKey(runId);
    const fullRecord: CatalogRunRecoveryRecord = { schemaVersion: 1, ...record };
    return storageConditionalBatch(
      durableStorage,
      [{ key, expectedValue: null }],
      [{ type: 'put', key, value: encode(fullRecord) }],
    );
  }

  async function loadCatalogRunRecoveryRecord(runId: string): Promise<CatalogRunRecoveryLoad> {
    if (!durableStorage) return { status: 'missing' };
    try {
      const value = await durableStorage.get(catalogRunRecoveryKey(runId));
      if (!value) return { status: 'missing' };
      const decoded = decode(value);
      return isCatalogRunRecoveryRecord(decoded)
        ? { status: 'found', record: decoded }
        : { status: 'corrupt' };
    } catch (error) {
      return { status: 'read-error', error };
    }
  }

  /** How many times a tombstone retries against a record that changed under it. */
  const FENCE_WRITE_TRIES = 5;

  async function fenceGoalAttemptRecoveryRecord(
    runId: string,
    owner: GoalAttemptClaimOwner,
    tombstonedAt: string,
  ): Promise<GoalAttemptClaimFence> {
    // No durable storage, nothing to claim: a claim cannot exist to be raced.
    if (!durableStorage) return 'fenced';
    const key = catalogRunRecoveryKey(runId);
    const tombstoned = {
      goalRunId: owner.goalRunId,
      attemptIndex: owner.attemptIndex,
      tombstonedAt,
    };
    for (let attempt = 0; attempt < FENCE_WRITE_TRIES; attempt += 1) {
      const bytes = await durableStorage.get(key);
      if (!bytes) {
        // Nothing claimed yet. The tombstone is the claim, written whole, so a
        // start that reaches its own claim next finds this one and starts nothing.
        // The estimator is the "declared none" selection a valid attempt record
        // must carry; the record is never the source of a run, so nothing reads it.
        const created: CatalogRunRecoveryRecord = {
          schemaVersion: 1,
          agentName: owner.agentName,
          definitionRevision: 0,
          input: '',
          ...(owner.principal === undefined ? {} : { principal: owner.principal }),
          goalAttempt: tombstoned,
          costEstimation: null,
        };
        if (
          await storageConditionalBatch(
            durableStorage,
            [{ key, expectedValue: null }],
            [{ type: 'put', key, value: encode(created) }],
          )
        ) {
          return 'fenced';
        }
        continue;
      }
      const decoded = decode(bytes);
      if (!isCatalogRunRecoveryRecord(decoded)) {
        throw new Error(
          `The recovery record for run "${runId}" exists but is not valid, so its attempt cannot be fenced.`,
        );
      }
      const claimed = decoded.goalAttempt;
      if (
        claimed?.goalRunId !== owner.goalRunId ||
        claimed.attemptIndex !== owner.attemptIndex ||
        decoded.agentName !== owner.agentName ||
        decoded.principal !== owner.principal
      ) {
        return 'foreign';
      }
      if (claimed.tombstonedAt !== undefined) return 'fenced';
      const next: CatalogRunRecoveryRecord = {
        ...decoded,
        goalAttempt: { ...claimed, tombstonedAt },
      };
      if (
        await storageConditionalBatch(
          durableStorage,
          [{ key, expectedValue: bytes }],
          [{ type: 'put', key, value: encode(next) }],
        )
      ) {
        return 'fenced';
      }
    }
    throw new Error(
      `The recovery record for run "${runId}" kept changing while its attempt was being fenced.`,
    );
  }

  /**
   * AB-240: whether `runId` has a persisted catalog-run recovery record —
   * `create-bureau.ts`'s boot-recovery classification uses this to route a
   * catalog-dispatched run to a headless monitor (mirroring a native
   * scheduled fire) instead of the session-ownership classification, which
   * would otherwise treat it as an orphaned run and cancel it (a catalog run
   * deliberately owns no bureau session).
   *
   * True for `'read-error'` as well as `'found'` (review finding): a corrupt
   * record still marks this workflow id as catalog territory. `'missing'`
   * is the only status that means "genuinely not a catalog run" — treating
   * `'read-error'` as `false` would let a merely-corrupt (not absent) record
   * fall through to the session-ownership classification below, which would
   * then cancel the run as an unowned orphan instead of leaving it to the
   * `{ status: 'unavailable', reason: '... unreadable' }` outcome
   * `resolveRunServices`'s catalog branch already produced for it.
   */
  async function isCatalogRecoveredRun(runId: string): Promise<boolean> {
    // AB-241 review finding: consult the cache `resolveRunServices` already
    // populated FIRST — `recoverDurableRuns`'s post-recovery loop calls this
    // for every handle `onRecoveredWorkflow` didn't already register, so a
    // catalog run's classification here must stay consistent with the
    // resolver's own earlier, successful read rather than risk a fresh,
    // independent one transiently disagreeing with it (a `false` from a
    // flaky second read would fall through to session-ownership
    // classification and cancel an already-resolved-and-monitored catalog
    // run as an orphan). See `catalogRunRecoveryCache`'s own doc comment for
    // why entries are NOT evicted here — only `classifyCatalogRecoveredRun`
    // (a second, later consumer of the same cache — see its own doc
    // comment for why entries are retained for the whole recovery pass,
    // never evicted per-read).
    if (catalogRunRecoveryCache.has(runId)) return true;
    const load = await loadCatalogRunRecoveryRecord(runId);
    return load.status !== 'missing' && load.status !== 'corrupt';
  }

  /**
   * AB-241 review finding: `create-bureau.ts`'s `onRecoveredWorkflow` calls
   * this ONCE to both classify a recovered workflow as catalog territory
   * and reseed `runAttribution` — see this function's own doc comment on
   * the `RuntimeComposition` interface for why a single combined read
   * replaces what would otherwise be two independent ones.
   *
   * Fresh review finding: `resolveRunServices`'s catalog branch ALREADY
   * reads and decodes this exact record, earlier, for the same workflow
   * (Weft always resolves a recovered workflow's services before invoking
   * the awaited `onRecoveredWorkflow` hook this function is called from).
   * Rather than issue a THIRD independent storage read here, this consumes
   * `catalogRunRecoveryCache`'s entry from that earlier, already-successful
   * read — a transient failure on a fresh read can no longer diverge from
   * the classification `resolveRunServices` already committed to. Falls
   * back to a fresh read only when the cache holds nothing for `runId`
   * (e.g. a direct caller of this function outside the normal recovery
   * hook ordering, or a test exercising it in isolation).
   *
   * Second fresh review finding: does NOT evict the cache entry after
   * reading it. `recoverDurableRuns`'s own post-recovery loop calls
   * `isCatalogRecoveredRun` for the SAME workflow id, AFTER this function
   * already ran for it (via the awaited `onRecoveredWorkflow` hook, which
   * happens during `recoverAll()`, strictly before the post-recovery loop
   * that iterates its returned handles) — evicting here would have starved
   * that second, later consumer of the exact same already-successful read
   * this function exists to reuse, sending it back to an independent
   * storage read whose transient failure could misclassify an
   * already-resolved-and-monitored catalog run as an orphan. The whole
   * cache is cleared in one call at the end of the boot recovery pass
   * instead — see `clearCatalogRunRecoveryCache`.
   */
  async function classifyCatalogRecoveredRun(runId: string): Promise<{
    isCatalogRun: boolean;
    attribution?: { agentName: string; principal?: string };
  }> {
    const cached = catalogRunRecoveryCache.get(runId);
    if (cached) {
      return {
        isCatalogRun: true,
        attribution: {
          agentName: cached.agentName,
          ...(cached.principal !== undefined ? { principal: cached.principal } : {}),
        },
      };
    }
    const load = await loadCatalogRunRecoveryRecord(runId);
    if (load.status === 'missing' || load.status === 'corrupt') return { isCatalogRun: false };
    if (load.status === 'read-error') return { isCatalogRun: true };
    return {
      isCatalogRun: true,
      attribution: {
        agentName: load.record.agentName,
        ...(load.record.principal !== undefined ? { principal: load.record.principal } : {}),
      },
    };
  }

  /**
   * AB-241 review finding: see `catalogRunRecoveryCache`'s own doc comment.
   */
  function clearCatalogRunRecoveryCache(): void {
    catalogRunRecoveryCache.clear();
  }

  /**
   * AB-240: `resolveRunServices`'s catalog branch — resolves a recovered
   * catalog-dispatched run's deps through the CATALOG AGENT's own
   * `OPERATIVE_RESOLVE_RUN_OPTIONS` (via `catalogAgentRunOptionsResolver`,
   * wired by `createBureau`), never through `buildRunDepsFromSession` /
   * the Bureau's own runtime composition — reattaching a catalog run
   * against the Bureau's default provider/tools instead of the agent's own
   * is this feature's rollback trigger.
   */
  async function resolveCatalogAgentRunServices(
    runId: string,
    record: CatalogRunRecoveryRecord,
  ): Promise<WorkflowServicesResolution> {
    const wired = await awaitCatalogAgentRunOptionsResolver(runId);
    if (wired.status === 'absent') {
      return {
        status: 'unavailable',
        reason: `run ${runId}: no catalog agent recovery resolver is configured`,
      };
    }
    if (wired.status === 'abandoned') {
      return { status: 'unavailable', reason: `run ${runId}: ${wired.reason}` };
    }
    const resolution = await wired.resolver(
      record.agentName,
      record.input,
      {
        agentName: record.agentName,
        // The run's own id, as its first dispatch carried, so a row the agent seeds from `input`
        // gets the id it had then (COR-1581) and the options carry the run's id.
        runId,
        // AB-241 review finding: without this, a recovered catalog agent's
        // re-invoked `OPERATIVE_RESOLVE_RUN_OPTIONS` rebuilt `RunOptions` with
        // no `principal` at all, so a resumed run silently lost attribution
        // across a restart.
        ...(record.principal !== undefined ? { principal: record.principal } : {}),
      },
      runId,
      {
        agentDefinitionHash: record.agentDefinitionHash,
        definitionRevision: record.definitionRevision,
      },
    );
    if (resolution.status === 'missing-agent') {
      return {
        status: 'unavailable',
        reason: `run ${runId}: catalog agent "${record.agentName}" is no longer in the catalog`,
      };
    }
    if (resolution.status === 'not-durable-capable') {
      return {
        status: 'unavailable',
        reason:
          `run ${runId}: catalog agent "${record.agentName}" no longer supports durable ` +
          `definition resolution (OPERATIVE_RESOLVE_RUN_OPTIONS)`,
      };
    }
    if (resolution.status === 'resolver-failed') {
      return {
        status: 'unavailable',
        reason:
          `run ${runId}: catalog agent "${record.agentName}" could not resolve run options ` +
          `during recovery: ${serializeUnknownError(resolution.error)}`,
      };
    }
    if (
      resolution.agentBinding === undefined &&
      resolution.definitionRevision !== record.definitionRevision
    ) {
      // Pin-and-warn, mirroring AB-10's workflow-version-mismatch precedent
      // (`workflowVersionMismatches` / 'reattach-version-mismatch'): reattach
      // with the catalog's CURRENT definition (the closest available match)
      // rather than fail, but surface the drift for operators.
      diagnose({
        level: 'warn',
        scope: 'recovery',
        message:
          `[bureau] Catalog agent "${record.agentName}" definition revision changed since ` +
          `run ${runId} was checkpointed (was ${record.definitionRevision}, now ` +
          `${resolution.definitionRevision}); reattaching with the current definition.`,
      });
    }
    // COR-1265 criterion 3b. AB-240's separation is about the PROVIDER and the
    // TOOLBOX — a recovered catalog run must reattach against the agent's own,
    // not the Bureau's, and that is unchanged here. Only the hook tier is added,
    // and only the invariants that close over nothing run-specific, so Bureau's
    // identity and guardrail policy hold on this path as they do on every other.
    // The agent's own tier arrives inside `resolution.options.hooks`, from its
    // own `buildRunOptions`; Bureau goes first so it wins `runFirst` and, being
    // pinned last, still wins the waterfall.
    // A recovered goal attempt's run is fenced exactly as a fresh one is: a run
    // the goal ended over, which a crash left to be resumed here, takes no step.
    const invariants = createBureauInvariantHooks(
      record.goalAttempt === undefined
        ? undefined
        : {
            goalRunId: record.goalAttempt.goalRunId,
            attemptIndex: record.goalAttempt.attemptIndex,
            runId,
          },
      { agentResolvesGuardrails: resolution.agentResolvesGuardrails === true },
    );
    // COR-1577 — a recovered `bureau.run()` run is offered `requestHumanInput` again, exactly
    // when its fresh dispatch was: the option is on, the engine is durable, and it is neither a
    // child nor a goal attempt. The tool parks through the services object being returned, so
    // that object is captured once it exists, as `buildRunDepsFromSession` does.
    const offersHumanInput =
      options.humanInput === true &&
      durable !== undefined &&
      record.goalAttempt === undefined &&
      record.workflowStep === undefined &&
      resolution.recoveredChild !== true;
    const humanInputServices: { current?: DurableRunDeps } = {};
    const toolbox = offersHumanInput
      ? wireDurableOptInTools(resolution.options.toolbox, humanInputServices, {
          humanInput: true,
          wakeup: false,
          runId,
          humanInputEmitter: {
            dispatchEvent: (event: Event) => {
              const target = humanInputServices.current?.emitter;
              return hasDispatchEvent(target) ? target.dispatchEvent(event) : false;
            },
          },
        })
      : resolution.options.toolbox;
    const services: DurableRunDeps = {
      options: {
        ...resolution.options,
        // The run's owner of record resolves its assets and holds the same
        // unverified-asset policy as on a fresh dispatch, unless the agent set its own.
        ...unsetMediaOptions(
          resolution.options,
          mediaOptionsFor(ownerOrLocal(record.principal), 'run'),
        ),
        toolbox,
        hooks: mergeHookRegistries(invariants, resolution.options.hooks),
      },
      toolbox,
    };
    humanInputServices.current = services;
    return { status: 'available', services };
  }

  async function loadScheduleIdForRecoveredRun(
    workflowId: string,
  ): Promise<RecoveredScheduleMarker> {
    if (!durableStorage) return { status: 'missing' };
    try {
      const value = await durableStorage.get(KEYS.scheduleRun(workflowId));
      if (!value) return { status: 'missing' };
      const scheduleId = decodeScheduleRunMarker(decode(value));
      return scheduleId !== undefined ? { status: 'found', scheduleId } : { status: 'missing' };
    } catch (error) {
      return { status: 'read-error', error };
    }
  }

  async function loadExistingStatelessScheduledSessionId(
    store: SessionStore,
    runId: string,
  ): Promise<string | undefined> {
    const sessions = await store.list();
    return sessions.find(
      (session: SessionSummary) =>
        session.id.startsWith('sched-') &&
        session.id.endsWith(`-${runId}`) &&
        session.metadata['lastScheduledFireRunId'] === runId,
    )?.id;
  }

  async function loadExistingScheduledSessionId(
    store: SessionStore,
    input: ScheduledAgentRunInput,
    runId: string,
  ): Promise<string | undefined> {
    if (input.sessionId !== undefined) {
      const session = await store.load(input.sessionId);
      return session?.metadata['lastScheduledFireRunId'] === runId ? input.sessionId : undefined;
    }
    return loadExistingStatelessScheduledSessionId(store, runId);
  }

  async function readCommittedScheduledSkillSnapshot(
    session: { readonly metadata: Record<string, JSONValue> } | undefined,
    runId: string,
    recovering: boolean,
  ): Promise<SkillSnapshot> {
    const none: SkillSnapshot = { status: 'verified', records: undefined };
    if (!recovering || !session) return none;

    const metadata = session.metadata;
    const lastFireRunId = metadata['lastScheduledFireRunId'];
    const recordsRunId = metadata['activeSkillRecordsRunId'];
    // Without skills there is no policy to verify, and whatever the session holds is not it.
    if (!skillsConfigured && recordsRunId !== runId) return none;
    // A fire writes its own run id with its snapshot, at every step. A session that names
    // another fire, as a recurring schedule's newer fire leaves it, holds that fire's snapshot;
    // one whose run id was cleared (null, as the start of a later run in the session does) or
    // never written holds none of this fire's. Whether this fire had skills is not known.
    if (lastFireRunId !== runId) {
      return {
        status: 'unverifiable',
        reason: `its session names another fire, ${describe(lastFireRunId)}`,
      };
    }
    if (recordsRunId !== runId) {
      return {
        status: 'unverifiable',
        reason: `its snapshot names another run, ${describe(recordsRunId)}`,
      };
    }
    const activeSkillRecordsRaw = metadata['activeSkillRecords'];
    const activeSkillRecordsStep = metadata['activeSkillRecordsStep'];
    if (
      typeof activeSkillRecordsStep !== 'number' ||
      !Number.isInteger(activeSkillRecordsStep) ||
      activeSkillRecordsStep < 0
    ) {
      return { status: 'unverifiable', reason: 'its snapshot step does not deserialize' };
    }

    try {
      const checkpoint = await durable?.checkpointStore.loadCheckpoint(runId);
      const committedStepRecords = [...(checkpoint?.steps ?? [])];

      const checkpointBytes = await durable?.engine.storage.get(KEYS.checkpoint(runId));
      if (checkpointBytes) {
        const weftCheckpoint = deserializeCheckpoint(checkpointBytes);
        for (const [, value] of weftCheckpoint.accumulatedResults) {
          const record = recordedAgentStep(value);
          if (record) committedStepRecords.push(record);
        }
      }

      const latestCommittedStep = committedStepRecords
        .filter((step) => step.step <= activeSkillRecordsStep)
        .toSorted((a, b) => b.step - a.step)
        .find((step) => activeSkillsFromStepMetadata(step.metadata) !== undefined);

      if (latestCommittedStep !== undefined) {
        return {
          status: 'verified',
          records: activeSkillsFromStepMetadata(latestCommittedStep.metadata),
        };
      }

      if (committedStepRecords.some((step) => step.step === activeSkillRecordsStep)) {
        if (isSkillActivationRecordArray(activeSkillRecordsRaw)) {
          return { status: 'verified', records: activeSkillRecordsRaw };
        }
        if (activeSkillRecordsRaw !== undefined && activeSkillRecordsRaw !== null) {
          return { status: 'unverifiable', reason: 'its stored skill records do not deserialize' };
        }
      }

      // No committed step activated a skill: a verified absence.
      return none;
    } catch (error) {
      options.onLog?.({
        workflowId: runId,
        workflowType: 'agentRun',
        timestamp: runtimeServices.clock.now(),
        level: 'warn',
        message: `Unable to verify scheduled fire skill snapshot checkpoint for run "${runId}": ${serializeUnknownError(error)}`,
      });
      return {
        status: 'unverifiable',
        reason: `its checkpoint could not be read: ${serializeUnknownError(error)}`,
      };
    }
  }

  function readSessionSkillSnapshot(
    session: { readonly metadata: Record<string, JSONValue> } | undefined,
    runId: string,
  ): SkillSnapshot {
    if (session === undefined) {
      return { status: 'unverifiable', reason: 'its session is not found' };
    }
    const metadata = session.metadata;
    const recordsRunId = metadata['activeSkillRecordsRunId'];
    const lastRunId = metadata['lastRunId'];
    // Without skills there is no policy to verify, and whatever the session holds is not it.
    if (!skillsConfigured && recordsRunId !== runId)
      return { status: 'verified', records: undefined };
    if (typeof recordsRunId === 'string' && recordsRunId !== runId) {
      return {
        status: 'unverifiable',
        reason: `its snapshot names another run, "${recordsRunId}"`,
      };
    }
    // The start of a run clears the session's snapshot (a null run id), so a cleared one that a
    // later run left is that run's reset, not a record that this run had no skills.
    if (recordsRunId === null && typeof lastRunId === 'string' && lastRunId !== runId) {
      return {
        status: 'unverifiable',
        reason: `a later run, "${lastRunId}", cleared its snapshot`,
      };
    }
    const raw = metadata['activeSkillRecords'];
    if (raw === undefined || raw === null) return { status: 'verified', records: undefined };
    if (!isSkillActivationRecordArray(raw)) {
      return { status: 'unverifiable', reason: 'its stored skill records do not deserialize' };
    }
    return { status: 'verified', records: raw };
  }

  /**
   * Build fresh {@link DurableRunDeps} for a NATIVE WEFT SCHEDULE FIRE (#109).
   *
   * Reached whenever `resolveRunServices` classifies this run as scheduled — a
   * live timer tick (`info.schedule` set), a recovered fire whose
   * `resolveWorkflowServices` info now also carries `info.schedule` (Weft 0.10+
   * derives it from durable schedule metadata on recovery, same as a live
   * tick), or an older-store recovered fire identified only by the persisted
   * `ScheduledAgentRunInput` / `KEYS.scheduleRun(...)` marker. `info.schedule`
   * being set is therefore NOT a reliable live-vs-recovered signal — both cases
   * populate it. Whether this is a *replay* of a fire that already persisted a
   * partial session before crashing is instead read directly off the session:
   * see `isRecoveredFireReplay` below. It builds deps exactly as a fresh
   * `createRun` would, seeding the conversation with the scheduled prompt and
   * using `info.workflowId` (the per-fire id Weft minted) as the runId. The
   * workflow body reads that same id back as `ctx.workflowId`.
   *
   * Session semantics (D6): `sessionId` present → continue that session's
   * conversation (recurring); absent → a fresh per-fire session (stateless cron).
   */
  async function buildScheduledRunServices(
    info: WorkflowServicesResolverInfo,
    store: SessionStore,
    recoveredScheduleMarker?: RecoveredScheduleMarker,
  ): Promise<WorkflowServicesResolution> {
    if (info.workflowType !== 'agentRun' || !isScheduledAgentRunInput(info.input)) {
      return {
        status: 'unavailable',
        reason: `scheduled fire ${info.workflowId} has an unrecognized workflow type or input`,
      };
    }

    const scheduledInput: ScheduledAgentRunInput = info.input;
    if (
      info.schedule === undefined &&
      !hasPersistedScheduleMarker(scheduledInput) &&
      recoveredScheduleMarker?.status !== 'found' &&
      recoveredMarkerSessionId(recoveredScheduleMarker) === undefined
    ) {
      return {
        status: 'unavailable',
        reason: `scheduled fire ${info.workflowId} is missing a persisted schedule marker`,
      };
    }

    const runId = info.workflowId;
    const agentName = scheduledInput.agentName;

    // sessionId present → recurring conversation; absent → fresh per-fire session.
    // The fresh id is derived from the schedule id + per-fire runId so each fire
    // is observable as its own session and two fires never collide.
    const recurring = scheduledInput.sessionId !== undefined;
    const recoveredScheduleId =
      persistedScheduleMarker(scheduledInput) ??
      info.schedule?.id ??
      (recoveredScheduleMarker?.status === 'found'
        ? recoveredScheduleMarker.scheduleId
        : undefined);
    // AB-223: record the correlation the engine-level terminal listener needs
    // to turn this fire's `workflow:completed`/`workflow:failed` into
    // `schedule.completed`/`schedule.failed`. Every reachable branch above
    // that resolves `{ status: 'available' }` has already confirmed a
    // schedule marker exists (the `hasPersistedScheduleMarker`/`info.schedule`/
    // `recoveredScheduleMarker` guard earlier in this function), so
    // `recoveredScheduleId` is defined here in practice; the `undefined` guard
    // is defensive, not a real branch this function's own preconditions
    // permit — dropping the entry rather than recording a bogus correlation.
    if (recoveredScheduleId !== undefined) {
      scheduledFireScheduleIds.set(runId, recoveredScheduleId);
    }
    const existingStatelessSessionId =
      !recurring && recoveredScheduleId === undefined
        ? recoveredMarkerSessionId(recoveredScheduleMarker)
        : undefined;
    const sessionId =
      scheduledInput.sessionId ??
      existingStatelessSessionId ??
      `sched-${recoveredScheduleId ?? 'unknown'}-${runId}`;

    // COR-718 — the fire is recorded, with its owner and its `schedule.fired` entry,
    // before any refusal below: a refused fire is still a fire, and its run is the
    // schedule owner's.
    const owner = ownerOrLocal(scheduledInput.principal);
    await dependencies.onScheduledFire?.({
      runId,
      scheduleId: recoveredScheduleId,
      sessionId,
      agentName,
      owner,
      message: payloadText(scheduledInput.input),
    });

    // COR-851: a goal's sessions are the goal's alone. A schedule can name any
    // session (an agent registers one itself through `scheduleSelf`, and one
    // persisted before the reservation existed is still live), and the fire
    // would load that conversation, append to it, and write it back. The id is
    // refused before anything is read.
    const reservedSession = reservedIdentifierReason('scheduled session', sessionId);
    if (reservedSession !== undefined) {
      return {
        status: 'unavailable',
        reason: `scheduled fire ${info.workflowId} names session "${sessionId}", which durable goals own: ${reservedSession}`,
      };
    }

    // Always check for an existing session at this id. A recurring fire
    // continues its stored session; a fresh-per-fire (stateless) session's id
    // embeds this exact runId, so a live (never-before-run) fire finds nothing
    // here and this load is a harmless no-op. It only finds something for a
    // recurring schedule's later fires, or a REPLAY of a fire that already
    // persisted (partially or fully) before this resume — which is exactly the
    // case `isRecoveredFireReplay` below needs to detect.
    const existing = await store.load(sessionId);
    // Defence in depth behind the id check above: a session a goal wrote carries
    // its `goalRunId`, whatever id it sits under, and no schedule fire reads it.
    if (existing !== undefined && existing.metadata['goalRunId'] !== undefined) {
      return {
        status: 'unavailable',
        reason: `scheduled fire ${info.workflowId} names session "${sessionId}", which belongs to a durable goal`,
      };
    }
    // COR-718 — a fire's run is owned by the schedule's owner, and so is the
    // session it creates. A fire into a session another principal owns would write
    // into a conversation its owner never shared, so it is refused, worded as a
    // session that is not there so the schedule owner learns nothing about whose it is.
    if (existing !== undefined && !isSessionAuthorityAuthorized(existing.metadata, owner)) {
      return {
        status: 'unavailable',
        reason: `scheduled fire ${info.workflowId} names session "${sessionId}", which was not found`,
      };
    }
    // The session's own metadata — not `info.schedule` — is the source of
    // truth for "have we already run this exact fire": `info.schedule` is
    // populated on BOTH a live tick and a recovered one, so it cannot
    // distinguish a fresh fire from a replay of one that crashed mid-flight.
    // A match here means this runId already wrote to this session, so its
    // transcript (and any committed active-skills snapshot) belongs to a
    // stale, partial attempt that must be cleaned before replay re-appends.
    const isRecoveredFireReplay = existing?.metadata['lastScheduledFireRunId'] === runId;
    // COR-1482: a session that already exists has its incarnation now; a fresh one gets it when
    // the fire first saves it (below).
    if (existing !== undefined) {
      await reportScheduledSession({ runId, sessionId, incarnation: existing.incarnation });
    }
    let conversation: Conversation;
    if (existing) {
      conversation = new Conversation(
        isRecoveredFireReplay
          ? removeLastScheduledFireTranscript(existing.conversationHistory, runId)
          : existing.conversationHistory,
      );
    } else {
      conversation = new Conversation(createConversationHistory({ id: sessionId }));
      if (systemPrompt) {
        conversation.appendSystemMessage(systemPrompt);
      }
    }
    const baseConversationHistory = conversation.current;
    appendAgentInput(conversation, scheduledInput.input, { scheduledFireRunId: runId });

    // Same runtime a normal run builds (generate/toolbox/memory/skills/guardrails),
    // wired to this fire's session + per-fire runId, with live streaming off (no
    // ActiveRun surface for a scheduled fire).
    // COR-1620: a replay is decided under the snapshot it can verify. One it cannot, and a stored
    // skill the catalog refuses, leave the replay without tools and without a snapshot write.
    const skillSnapshot = await readCommittedScheduledSkillSnapshot(
      existing,
      runId,
      isRecoveredFireReplay,
    );
    const initialActiveSkillRecords =
      skillSnapshot.status === 'verified' ? skillSnapshot.records : undefined;
    const requestContext = createSchedulerServiceRequestContext(runId, agentName, sessionId);

    // COR-1546 — the fire's run writes into the schedule owner's memory, not the scheduler's.
    const runRuntime = await createRunRuntime(
      { message: payloadText(scheduledInput.input), sessionId, runId, agentName, requestContext },
      {
        liveStreaming: false,
        initialActiveSkillRecords,
        skillPolicyUnverifiable: skillSnapshot.status === 'unverifiable',
        memoryOwner: owner,
      },
    );
    const skillRecovery = await runRuntime.skillsRecovered;
    if (skillSnapshot.status === 'unverifiable' || skillRecovery.refused.length > 0) {
      options.onLog?.({
        workflowId: runId,
        workflowType: 'agentRun',
        timestamp: runtimeServices.clock.now(),
        level: 'warn',
        message: `Schedule fire "${runId}" replays without tools: its skill policy cannot be verified (${
          skillSnapshot.status === 'unverifiable'
            ? skillSnapshot.reason
            : `a stored skill was refused on recovery: ${skillRecovery.refused.join(', ')}`
        }).`,
      });
    }

    // COR-1596: a fire is offered `requestHumanInput` exactly as a `bureau.run()` run is, so a
    // scheduled agent can ask for an answer it will wait for. The tool parks through the services
    // object returned below, so that object is captured once it exists, as the recovery of a
    // catalog run captures it.
    const humanInputServices: { current?: DurableRunDeps } = {};
    const fireToolbox =
      options.humanInput === true && durable !== undefined
        ? wireDurableOptInTools(runRuntime.toolbox, humanInputServices, {
            humanInput: true,
            wakeup: false,
            runId,
            humanInputEmitter: {
              dispatchEvent: (event: Event) => {
                const target = humanInputServices.current?.emitter;
                return hasDispatchEvent(target) ? target.dispatchEvent(event) : false;
              },
            },
          })
        : runRuntime.toolbox;
    if (isRecoveredFireReplay) {
      recordRecoveredSkillPolicy(fireToolbox, {
        scheduledFire: true,
        agentName,
        sessionAgent: undefined,
        recordsKey: JSON.stringify(initialActiveSkillRecords ?? []),
        recoveredCleanly: skillSnapshot.status === 'verified' && skillRecovery.refused.length === 0,
      });
    }
    const services: DurableRunDeps = {
      toolbox: fireToolbox,
      // An unverified policy keeps the snapshot the committed steps already hold.
      getStepMetadata: () =>
        runRuntime.skillPolicyUnverified()
          ? {}
          : {
              [activeSkillsStepMetadataKey]: activeSkillsStepMetadata(
                runRuntime.getActiveSkillRecords(),
              ),
            },
      options: {
        generate: runRuntime.generate,
        toolbox: fireToolbox,
        conversation,
        ...mediaOptionsFor(owner, 'session'),
        maximumSteps,
        stopWhen: options.stopWhen,
        // AB-260: the bureau's single composed RuntimeServices instance,
        // snapshotted into every run it starts — including a scheduled fire.
        runtime: runtimeServices,
        // The session write-back runs AFTER the runtime's own onStep hooks so
        // recurring fires accumulate and a stateless fire is observable.
        // COR-1269 — stamped onto this run's hook-plan observations.
        sessionId,
        // COR-1265 criterion 8 — merged AFTER the trailing registration, so the
        // Bureau tier is complete before it becomes the merge's first argument
        // and the trailing hook is offset with every other Bureau entry rather
        // than beside them at a raw priority.
        hooks: mergeHookRegistries(
          registerTrailingOnStep(
            runRuntime.hooks,
            'bureau:scheduled-session-write-back',
            createScheduledSessionPersistHook(
              store,
              sessionId,
              agentName,
              baseConversationHistory,
              runId,
              isRecoveredFireReplay,
              runRuntime.getActiveSkillRecords,
              runRuntime.skillPolicyUnverified,
              owner,
              requestContext,
            ),
          ),
        ),
        executeOptions: { requestContext },
        agentName,
        runId,
      },
    };

    humanInputServices.current = services;
    // Scheduled fires have no interactive ActiveRun surface. The recovery hook
    // monitors them without attaching live event forwarding.
    await reportScheduledServices({ runId, sessionId, agentName, requestContext }, services);
    return { status: 'available', services };
  }

  /**
   * Weft's `resolveWorkflowServices` resolver: re-provide a recovered run's deps
   * on a fresh-process resume. Weft fires it (per recovered inline run that was
   * launched with `services`) BEFORE the generator advances, passing the run's
   * `workflowId` — which equals our `runId`, since `engine.start` pins
   * `{ id: runId }`. Finds the owning `running` session, rebuilds its deps, and
   * returns `{ status: 'available', services }`; a run with no reconstructable
   * session returns `{ status: 'unavailable' }`, which fails just that one run
   * (terminal `failed`) without aborting recovery or the engine.
   *
   * When the owning session exists and is `running` but its deps cannot be rebuilt
   * here (`buildRunDepsFromSession` throws — e.g. no `generate` configured on this
   * process), it best-effort reconciles that session to `error` before returning
   * unavailable, so the session metadata is not left stuck `running` for a run the
   * engine is about to fail. This is the resolver's one write; it is keyed on the
   * session it just loaded (no race) and swallowed on failure.
   *
   * Idempotent: once a session is reconciled to `error`, the `=== 'running'`
   * predicate above no longer matches it on a later boot, so it falls through to
   * the no-running-session return and is never re-failed or re-written.
   */
  async function resolveRunServices(
    info: WorkflowServicesResolverInfo,
  ): Promise<WorkflowServicesResolution> {
    // The engine's background tasks are armed at engine construction, before this closure's later
    // dependencies (sessionStore, createRunRuntime deps) are initialized. A tick or a reclaim that
    // reaches this resolver mid-construction waits for the composition instead of being answered
    // "unavailable", which the engine would turn into a terminal failure of the run. (Reading a
    // not-yet-initialized `const` below would otherwise throw a TDZ error.)
    if (!compositionOpen) {
      diagnose({
        level: 'warn',
        scope: 'recovery',
        message:
          `[bureau] Run "${info.workflowId}" reached recovery before the bureau finished ` +
          `composing; holding it until composition completes.`,
      });
    }
    try {
      await readiness.promise;
    } catch {
      return {
        status: 'unavailable',
        reason: `run ${info.workflowId}: composition failed`,
      };
    }
    // COR-1527: an instance of a workflow file runs the interpreter, which reads no services.
    if (dependencies.isWorkflowFileType?.(info.workflowType) === true) {
      return { status: 'available', services: undefined };
    }
    if (!sessionStore) {
      return { status: 'unavailable', reason: 'no session store configured' };
    }
    // AB-240: `bureau.run()`'s durable catalog dispatch persists its OWN
    // recovery record (agent name + a stable definition revision + the
    // original input), keyed by workflowId, entirely independent of
    // `sessionStore`'s lastRunId/lastRunStatus correlation — a catalog run
    // deliberately never owns a bureau session. Check for it FIRST: when
    // present it is authoritative and bypasses every guard below (scheduler
    // origin, session ownership), none of which apply to a catalog run.
    const catalogRecovery = await loadCatalogRunRecoveryRecord(info.workflowId);
    if (catalogRecovery.status === 'read-error') {
      return {
        status: 'unavailable',
        reason: `run ${info.workflowId}: catalog recovery record unreadable`,
      };
    }
    if (catalogRecovery.status === 'found') {
      // AB-241 review finding: cache the successfully decoded record so
      // `classifyCatalogRecoveredRun` (called from `onRecoveredWorkflow`,
      // always AFTER this resolver for the same workflow) reuses this exact
      // read instead of issuing its own independent one.
      catalogRunRecoveryCache.set(info.workflowId, catalogRecovery.record);
      return resolveCatalogAgentRunServices(info.workflowId, catalogRecovery.record);
    }
    // NATIVE SCHEDULED FIRE (#109/#126): Weft sets `info.schedule` for a live
    // schedule tick, and (Weft 0.10+) also derives it from durable schedule
    // metadata when re-providing services on recovery — so `info.schedule` alone
    // does not distinguish live from recovered. Some recovered fires (older
    // stores, or a schedule whose metadata could not be resolved) may only carry
    // the persisted ScheduledAgentRunInput, so recovery must also check the
    // persisted schedule marker written by createAgentSchedule(); the broad
    // `{ agentName, input }` shape alone is not enough to bypass the interactive
    // session-ownership guards below.
    let recoveredScheduleMarker =
      info.schedule === undefined &&
      isScheduledAgentRunInput(info.input) &&
      !hasPersistedScheduleMarker(info.input)
        ? await loadScheduleIdForRecoveredRun(info.workflowId)
        : undefined;
    if (
      recoveredScheduleMarker !== undefined &&
      recoveredScheduleMarker.status !== 'found' &&
      isScheduledAgentRunInput(info.input)
    ) {
      try {
        const sessionId = await loadExistingScheduledSessionId(
          sessionStore,
          info.input,
          info.workflowId,
        );
        if (sessionId !== undefined)
          recoveredScheduleMarker = { ...recoveredScheduleMarker, sessionId };
      } catch (error) {
        diagnose({
          level: 'error',
          scope: 'recovery',
          message: `[bureau] Could not inspect scheduled session proof for recovered run "${info.workflowId}"; continuing without scheduled-fire classification: ${serializeUnknownError(error)}`,
        });
      }
    }
    if (
      info.schedule !== undefined ||
      (isScheduledAgentRunInput(info.input) &&
        (hasPersistedScheduleMarker(info.input) ||
          recoveredScheduleMarker?.status === 'found' ||
          recoveredMarkerSessionId(recoveredScheduleMarker) !== undefined))
    ) {
      return buildScheduledRunServices(info, sessionStore, recoveredScheduleMarker);
    }
    // The owning session id rides in the run's durable input (Weft passes the
    // persisted `input` to the resolver on recovery — see #2), so load the
    // session DIRECTLY by id, with no `sessionStore.list()` scan or
    // lastRunId/lastRunStatus correlation. A run whose input predates the
    // sessionId field (or is not an agentRun) fails the guard and is treated as
    // not-reconstructable — no compatibility fallback for cross-upgrade runs.
    if (!isAgentRunWorkflowInput(info.input)) {
      return { status: 'unavailable', reason: `run ${info.workflowId} has no recoverable session` };
    }
    // SCHEDULER-ORIGIN GUARD (#25, #44): Weft 0.7 includes launch metadata in
    // WorkflowServicesResolverInfo, so new scheduler-origin runs discriminate by
    // their explicit launch tag instead of the old synthetic-input shape. Keep
    // the prefix check only as legacy cleanup for persisted scheduler runs
    // created before resolver launch context was available.
    const schedulerOriginByLaunchTag =
      info.launchOptions?.tags?.includes(SCHEDULER_ORIGIN_TAG) ?? false;
    const legacySchedulerOriginBySyntheticInput =
      info.input.sessionId === info.input.runId &&
      info.input.runId.startsWith(SCHEDULER_RUN_ID_PREFIX);
    if (schedulerOriginByLaunchTag || legacySchedulerOriginBySyntheticInput) {
      return {
        status: 'unavailable',
        reason: `run ${info.workflowId} is scheduler-origin (no session to recover)`,
      };
    }
    // CORRELATION GUARD (committee MF-5): the workflow id IS the run id (pinned at
    // engine.start), so the input's own runId must match. A mismatch means a
    // corrupt or crafted durable input is trying to correlate this run to a
    // foreign session — fail closed (no session load, no reconcile write) rather
    // than rebuild deps for / write to a session the input doesn't legitimately own.
    if (info.input.runId !== info.workflowId) {
      return { status: 'unavailable', reason: `run ${info.workflowId} input runId mismatch` };
    }
    const sessionId = info.input.sessionId;
    const session = await sessionStore.load(sessionId);

    // The session must still OWN this run AND be IN-FLIGHT (its `lastRunId`
    // matches the workflow id AND `lastRunStatus` is `running`) before we rebuild
    // its deps (committee/Bugbot review: recovery skips session-run ownership).
    // The status check is load-bearing, not just symmetric with the post-recover
    // gate in create-bureau: the resolver fires DURING `recoverAll()` and resuming
    // a run whose session already says `completed`/`error` would let it advance
    // (model/tool SIDE EFFECTS) before the post-recover gate could cancel it —
    // too late. A durable input pointing at a session owning a DIFFERENT run, or
    // at an already-terminal session, fails closed with NO session write.
    if (
      !session ||
      session.metadata['lastRunId'] !== info.workflowId ||
      session.metadata['lastRunStatus'] !== 'running'
    ) {
      return {
        status: 'unavailable',
        reason: `run ${info.workflowId} not owned by a running session`,
      };
    }

    const recoveredAuthority = recoveredRequestContext(
      session.metadata,
      info.workflowId,
      sessionId,
      info.input.agentName,
      runtimeServices.clock.now,
    );
    if (!recoveredAuthority) {
      return {
        status: 'unavailable',
        reason: `run ${info.workflowId} request authority is unavailable during recovery`,
      };
    }
    const recoveredAuthorizationRevision = recoveredAuthority.authority.authorizationRevision;
    const requiresTransportValidation =
      recoveredAuthorizationRevision !== 'bureau:1' &&
      recoveredAuthorizationRevision !== 'bureau:scheduler:1';
    if (requestAuthorityValidator === undefined && requiresTransportValidation) {
      return {
        status: 'unavailable',
        reason: `run ${info.workflowId} authority cannot be revalidated during recovery`,
      };
    }
    if (
      requiresTransportValidation &&
      requestAuthorityValidator &&
      !(await requestAuthorityValidator(recoveredAuthority))
    ) {
      return {
        status: 'unavailable',
        reason: `run ${info.workflowId} authority is no longer current`,
      };
    }

    let services: DurableRunDeps;
    try {
      // info.workflowId === the run id (pinned at engine.start) — thread it so the
      // recovered run's memory-persist idempotency key matches its pre-crash key.
      // info.input.agentName is guaranteed non-empty here: isAgentRunWorkflowInput
      // requires a non-empty string (the guard returned earlier if it's missing).
      services = await buildRunDepsFromSession(session, info.workflowId, info.input.agentName);
    } catch (error) {
      // The session exists, but its deps cannot be rebuilt on this process (e.g.
      // no `generate`/provider configured here, so `createRunRuntime` throws).
      // Weft will fail this run terminally pre-replay; the reattached handle then
      // rejects and its adapter stays write-free — so without this reconcile the
      // session would be left stuck `running`. We have the sessionId in hand, so
      // reconcile it to `error` synchronously on the boot path (not a racy
      // detached write).
      const reason = error instanceof Error ? error.message : String(error);
      try {
        await sessionStore.updateMetadata(sessionId, {
          lastRunStatus: 'error',
          lastFinishReason: 'error',
          lastError: `Recovered run could not be reconstructed: ${reason}`,
        });
      } catch (writeError) {
        // Reconciliation is best-effort — a failed write must not abort the rest
        // of recovery — but it is NOT silent: a session left stale `running`
        // cannot be repaired by a later boot (the run is already terminal
        // `failed` and is skipped), so surface it for operators.
        diagnose({
          level: 'error',
          scope: 'session-persistence',
          message:
            `[bureau] Failed to reconcile unrecoverable run "${info.workflowId}" ` +
            `(session ${sessionId}) to error: ${writeError instanceof Error ? writeError.message : String(writeError)}`,
        });
      }
      return { status: 'unavailable', reason: `run ${info.workflowId} not reconstructable` };
    }
    // `services` is never null here: the owning-session check above already
    // guarantees a non-null `session`, and `buildRunDepsFromSession` only
    // returns null for a null session — so its return type's `| null` is a
    // defensive contract for OTHER callers (this file's own
    // `resolveCatalogAgentRunServices` and `buildScheduledRunServices` never
    // call it; a future caller might), not a branch reachable from here. A
    // dead `if (services === null)` fail-closed used to guard this anyway,
    // covered only by forcing it through a private mutation seam (AB-260
    // retired both).
    return { status: 'available', services };
  }

  // Every closure dependency the resolver reads is now initialized; open the gate
  // so scheduler-poller ticks (and the bureau's subsequent `recoverAll()`) resolve.
  compositionOpen = true;
  readiness.resolve();

  const composition: RuntimeComposition = {
    kv,
    durable,
    workflowVersionMismatches,
    scheduleFireEvents,
    skillEvents,
    disposeStorage:
      durableStorage && ownsDurableStorage ? () => durableStorage[Symbol.dispose]() : undefined,
    durableStorage,
    memory,
    sessionStore,
    scheduler,
    // Exposed so the review queue (`resolveReview`) can call `resumeApproval()`
    // on the SAME toolbox instance (or any `.extend()` clone of it, which
    // preserves `approvalSecret` — see armorer's `extend()`) that executed the
    // original tool call. `resumeApproval` re-invokes the tool by name/callId,
    // so any toolbox sharing this instance's `approvalSecret` and tool set can
    // resume a signed pending approval, not only the specific per-run clone.
    baseToolbox,
    setRequestAuthorityValidator(validator) {
      requestAuthorityValidator = validator;
    },
    setCatalogAgentRunOptionsResolver(resolver) {
      catalogAgentRunOptionsResolver = resolver;
      if (resolver !== undefined) openCatalogResolverGate();
    },
    abandonCatalogAgentRunOptionsResolver(reason) {
      if (dependencies.awaitsCatalogAgentRunOptionsResolver !== true) return;
      catalogResolverAbandonedReason ??= reason;
      openCatalogResolverGate();
    },
    persistCatalogRunRecoveryRecord,
    claimCatalogRunRecoveryRecord,
    loadCatalogRunRecoveryRecord,
    fenceGoalAttemptRecoveryRecord,
    isCatalogRecoveredRun,
    classifyCatalogRecoveredRun,
    clearCatalogRunRecoveryCache,
    mediaOptionsFor,
    ready:
      options.generate !== undefined ||
      options.provider !== undefined ||
      (options.providers?.length ?? 0) > 0,
    provider: options.provider ? redactProvider(options.provider) : undefined,
    providers: baseProviders.map((provider) => ({
      ...provider,
      provider: redactProvider(provider.provider),
    })),
    maximumSteps,
    systemPrompt,
    getToolSummaries,
    createRunRuntime,
    // AB-260: folded onto the returned object directly — see the interface's
    // own doc comments for why these are genuine capabilities of this
    // composition rather than test-only introspection.
    resolveRunServices,
    buildScheduledRunServices,
    readCommittedScheduledSkillSnapshot,
    readSessionSkillSnapshot,
    createBureauInvariantHooks,
    resolveSessionAgentRun,
  };

  return composition;
}
