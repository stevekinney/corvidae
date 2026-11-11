/**
 * Run creation (COR-2376 slice S2): `createRunFromRequest`, the one path that admits a session run,
 * with the run-creation ledger it claims and releases. Built by `constructBureau` and reached only
 * through `createBureau`. It and task start call each other through `peers`.
 */
import {
  type ActiveRun,
  type AgentSession,
  type CombinedOperativeEventMap,
  type DurableRunDeps,
  HumanWaitParkedEvent,
  type JSONValue,
  type CleanupAcknowledgement as RunCleanupAcknowledgement,
  type RunOptions,
  SESSION_OWNER_METADATA_KEY,
  type SessionInputGate,
  SteeringAppliedEvent,
  appendAgentInput,
  bureauInvariantsField,
  createActiveRun,
  createRunFinishedFrame,
  createRunStartedFrame,
  isFailureFinishReason,
  runScopedExecutionContextOf,
} from '@lostgradient/operative';
import type { AgentDefinitions } from '../agent-catalog';
import { BUREAU_AGENT_NAME, detachBestEffortPromise } from '../bureau-construction-support';
import type { BureauCore, ChatRunSpend } from './core';
import { BureauError, toBadRequest } from '../bureau-errors';
import type { BureauSteeringGate } from '../steering';
import {
  SESSION_AGENT_DEFINITION_HASH_METADATA_KEY,
  SESSION_AGENT_REVISION_METADATA_KEY,
} from '../session-agent-revision';
import { registerTrailingOnStep } from '../bureau-invariant-hooks';
import { sessionRunMediaOptions } from '../provider-resolution';
import { type BureauToolbox, type SessionAgentRun } from '../runtime-composition-types';
import { wireDurableOptInTools } from '../run-request-context';
import { CompletableEventTarget } from '@lostgradient/lifecycle';
import type { ConditionalTextValueStore } from '@lostgradient/storage';
import type { Conversation, ConversationHistory } from 'conversationalist';
import type {
  CreateRunRequest,
  LocateRunCreationReceiptRequest,
  PendingReview,
  RunSummary,
  ServerFrame,
} from '../types';
import {
  type CreatedRunSummary,
  type RunCreationAttempt,
  type RunCreationReceiptLocation,
  digestRunCreationPayload,
  serializeTaskInput,
  serializeTaskRequestContext,
} from '../command-ledger';
import type { ReleasableConversation } from '../catalog-run-asset-release';
import {
  SESSION_END_REASON_HOST_STOPPED,
  type createSessionPersistence,
} from '../bureau-session-persistence';
import {
  SessionAgentConflictError,
  SessionOwnerConflictError,
  isSessionAuthorityAuthorized,
} from '../session-authority';
import {
  type SessionTaskFields,
  appendRequestRows,
  assertConversationAnswerable,
  legacyTaskInputOf,
  rejectUnopenableNewSessionIdentifier,
  requestTextOf,
  validateCreateRunRequest,
} from '../run-request-validation';
import { type SteeringLogEvent, steeringSessionRunTag } from '../steering-log';
import { type TaskOrigin, taskOriginOfStart, taskOriginTag } from '../task-origin';
import type { TaskToolGrant } from '../task-registry';
import { attachRunEventFeed } from '../run-event-feed-attachment.ts';
import { bindRunWorkspaceAuthority } from '../run-authority.ts';
import {
  buildTerminalReportFromAbortedEvent,
  buildTerminalReportFromCompletedEvent,
  createRunFrameForwarder,
} from '../run-envelope';
import { copyAgentOwnedRunOptions, sessionExecuteOptions } from '../session-agent-options';
import { createPendingApprovalPersistHook } from '../approval-state-records';
import { humanInputSchemasOf } from '../human-input-option';
import { isTryAgentName } from '../agent-try';
import { normalizeRunRequestContext, persistedRequestAuthority } from '../session-request-context';
import { ownerFromPrincipal, ownerOrLocal } from '../owner-of-record';
import { serializeRunState, serializeUnknownError } from '../serialization';

/** The callables run creation reads from elsewhere in `constructBureau`. */
export interface RunCreationPeers {
  /** Loads a session and its conversation. */
  readonly loadConversation: ReturnType<typeof createSessionPersistence>['loadConversation'];
  /** Saves a session's conversation and metadata. */
  readonly saveSession: ReturnType<typeof createSessionPersistence>['saveSession'];
  /** Follows a catalog asset release, so shutdown waits for it. */
  readonly trackCatalogAssetRelease: (pending: Promise<void>) => Promise<void>;
  /** Aborts a task's run, as the task handle does. */
  readonly abortTask: (id: string, reason?: string) => void;
  /** Throws unless a tried agent belongs to the context that was started with it. */
  readonly assertTriedAgentBelongsTo: (agentName: string, sessionId: string) => void;
  /** Aborts a started task when the caller's start signal aborts. */
  readonly bindStartSignal: (signal: AbortSignal, id: string, settled: Promise<unknown>) => void;
  /** The refusal of a run of an agent that no catalog agent resolves. */
  readonly missingAgentError: (agentName: string) => BureauError;
  /** The tools a task starting now is granted. */
  readonly toolGrantFor: (triedRun: boolean) => TaskToolGrant;
  /** The origin a tried context records once, when its session is created. */
  readonly triedOriginMetadata: (
    triedRun: boolean,
    session: AgentSession | undefined,
  ) => Record<string, string>;
  /** Tells whoever waits on a run's terminal session record that it will not be written. */
  readonly abandonTerminalSessionRecord: (runId: string) => void;
  /** A run's cost budget with the chat's spend so far. */
  readonly chatCostBudgetOf: (
    sessionAgent: SessionAgentRun,
    sessionId: string,
    session: { readonly incarnation?: string | undefined } | undefined,
  ) => Promise<NonNullable<RunOptions['costBudget']> | undefined>;
  /** Makes a wait for a run's session record last until the run's terminal save has finished. */
  readonly expectTerminalSessionRecord: (runId: string) => void;
  /** Persists a run's terminal session state, then settles the session's input. */
  readonly persistTerminalSession: (
    saveSessionUpdate: () => Promise<unknown>,
    context: {
      runId: string;
      sessionId: string;
      status: 'completed' | 'error' | 'aborted';
      /** What the run spent, for the chat's ledger (COR-1915); written before the session's save. */
      spend?: ChatRunSpend;
    },
  ) => void;
  /** A run's terminal save, pinned to the session incarnation the run started in. */
  readonly saveRunTerminalSession: (
    runId: string,
    sessionId: string,
    conversation: Conversation,
    metadata: Record<string, JSONValue>,
    agentName?: string,
    baseConversationHistory?: ConversationHistory,
  ) => Promise<AgentSession | undefined>;
  /** Appends a non-admission steering event after catching up, then applies it. */
  readonly appendThenApplySteering: (
    kv: ConditionalTextValueStore,
    sessionId: string,
    incarnation: string,
    event: Exclude<SteeringLogEvent, { type: 'admit' | 'refused' }>,
  ) => Promise<void>;
  /** `runtime.kv`, when this Bureau keeps durable steering. */
  readonly durableSteeringStore: () => ConditionalTextValueStore | undefined;
  /** Runs an operation after every earlier steering log operation for the session. */
  readonly enqueueSteering: <T>(sessionId: string, operation: () => Promise<T>) => Promise<T>;
  /** The session's steering gate, created on first use. */
  readonly getSessionSteeringGate: (sessionId: string) => BureauSteeringGate;
  /** Logs a run-boundary steering event and applies it once logged. */
  readonly logRunBoundarySteering: (
    sessionId: string,
    gate: BureauSteeringGate,
    event: Extract<SteeringLogEvent, { type: 'applied' | 'run-ended' }>,
  ) => void;
  /** Starts following a session's durable steering log for a run. */
  readonly pollSessionSteering: (sessionId: string, incarnation: string, runId: string) => void;
  /** Settles a run whose local handle ended with no terminal event. */
  readonly settleAbandonedRun: (sessionId: string, runId: string, activeRun: ActiveRun) => void;
  /** The gate through which a session's durable run receives input. */
  readonly sessionInputGateFor: (
    sessionId: string,
    runId: string,
    incarnation: string | undefined,
  ) => SessionInputGate | undefined;
  /** Settles a session's inputs once a run has ended. */
  readonly settleSessionInputsAfterRunEnd: (sessionId: string, runId: string) => Promise<void>;
  /** Tracks a session input settlement, so shutdown waits for it. */
  readonly trackSessionInputSettlement: (settling: Promise<void>) => void;
  /** The terminal checkpoint cleanup step in force when a run starts, if any. */
  readonly durableTerminalCleanup: () =>
    ((runId: string) => Promise<RunCleanupAcknowledgement>) | undefined;
  /** Applies the checkpoint retention policy to a durable run's history, once. */
  readonly runTerminalCheckpointCleanup: (runId: string) => Promise<RunCleanupAcknowledgement>;
  /** Sends a server frame to the live frame listeners. */
  readonly emitLiveFrame: (frame: ServerFrame) => void;
  /** Persists a pending approval override, retrying a failed write. */
  readonly persistPendingApprovalOverrideWithRetry: (
    sessionId: string,
    reviewId: string,
    approval: Extract<PendingReview, { kind: 'tool-approval' }>['approval'],
  ) => Promise<void>;
  /** Forgets a terminal run's review state. */
  readonly releaseTerminalRunReviewState: (runId: string) => void;
  /** Runs and clears a run's registered stream listeners. */
  readonly disposeRegisteredStreamListeners: (listeners: Array<() => void>) => void;
}

/** Builds the run creation functions of one Bureau. Synchronous, and registers nothing. */
export function createRunCreation<D extends AgentDefinitions>(
  core: BureauCore<D>,
  peers: RunCreationPeers,
) {
  const {
    workspace,
    runtimeServices,
    store,
    runEventFeeds,
    lateDecisions,
    runSessionIdentifiers,
    runSessionIncarnations,
    runtime,
    diagnose,
    configureChildWaitServices,
    assertRunAdmissionOpen,
    releaseRunToolboxWhenIdle,
    activeRuns,
    erroredActiveRuns,
    runsStoppedByShutdown,
    runToolboxes,
    runToolboxesByRunId,
    runScopedContexts,
    runHookPlans,
    pendingApprovalOverrides,
    runAttribution,
    steeringRunIncarnations,
    runRequestContexts,
    isTransportIssuedAuthority,
    inFlightSessionDeletions,
  } = core;

  async function createRunFromRequest(
    request: CreateRunRequest & SessionTaskFields,
  ): Promise<CreatedRunSummary> {
    validateCreateRunRequest(request);
    // COR-718 — the owner of record: stored once, below, and unchanged afterward. A
    // host that states no principal owns the run as `anonymous:local`; one that
    // states anything but text is refused here, before anything is persisted.
    const owner = ownerFromPrincipal(request.principal, toBadRequest);
    assertRunAdmissionOpen('run');

    if (request.runCreationRequestId !== undefined) requireRunCreationLedger();

    const sessionId = request.sessionId?.trim() ?? runtimeServices.identifiers.next('session');
    // COR-1481 — a context being deleted takes no new task: it reads as one that does
    // not exist, until the deletion has committed and the id may name a new incarnation.
    if (inFlightSessionDeletions.has(sessionId)) {
      throw new BureauError(`Session "${sessionId}" not found`, 'NOT_FOUND');
    }
    const runId = runtimeServices.identifiers.next('run');
    // The text that stands for the request where only text fits: flow control,
    // and the session's `lastUserMessage`.
    const requestText = requestTextOf(request);

    // COR-1577 — which agent this run is. A session is bound to the agent of the run that
    // created it, so an existing session decides; a new one takes the named agent, or the
    // default `bureau`. Every refusal here lands before anything is persisted.
    const { session, conversation } = await peers.loadConversation(sessionId);
    const baseConversationHistory = conversation.current;
    rejectUnopenableNewSessionIdentifier('"sessionId"', sessionId, session !== undefined);

    // COR-718 — a session belongs to the owner of the run that created it. A
    // different principal starting a run on it is refused exactly as a session
    // that does not exist is, so an identifier grants nothing.
    if (session && !isSessionAuthorityAuthorized(session.metadata, owner)) {
      throw new BureauError(`Session "${sessionId}" not found`, 'NOT_FOUND');
    }
    const agentName = resolveRunAgentName(sessionId, session, request.agentName);
    // COR-1911 — a tried agent belongs to the one context that was started with it: a name that
    // is held for another context, or for none, is an agent that does not exist.
    const triedRun = isTryAgentName(agentName);
    if (triedRun) peers.assertTriedAgentBelongsTo(agentName, sessionId);
    // COR-1867 — where the task came from, as its record and its run's `origin:<kind>` tag keep
    // it. A chat's identifiers are this start's own, never the caller's.
    const taskOrigin: TaskOrigin = taskOriginOfStart(request.origin, {
      sessionId,
      agentName,
      owner,
    });
    // COR-323 — every run belongs to a catalog agent. The implicit `bureau` agent, which ran on
    // Bureau-wide `generate`/`toolbox` options, no longer exists, so a session stored under it
    // answers as any unknown agent does.
    const resolution = await runtime.resolveSessionAgentRun(agentName, runId, owner, undefined, {
      sessionId,
      metadata: session?.metadata,
    });
    if (resolution.status === 'missing-agent') throw peers.missingAgentError(agentName);
    if (resolution.status === 'not-durable-capable') {
      throw new BureauError(
        `Agent "${agentName}" cannot run in a session: it exposes no definition resolver.`,
        'UNSUPPORTED_CAPABILITY',
      );
    }
    if (resolution.status === 'resolver-failed') throw resolution.error;
    const sessionAgent: SessionAgentRun = resolution.run;
    // Request beats agent, and agent beats Bureau, for what the run is seeded and capped with.
    const effectiveSystemPrompt = sessionAgent?.instructions ?? runtime.systemPrompt;
    const effectiveMaximumSteps = sessionAgent?.options.maximumSteps ?? runtime.maximumSteps;
    const effectiveMaximumTokens = sessionAgent?.options.maximumTokens;
    // COR-1915 — the agent's `limits.cost.chat` is measured against what the chat's earlier
    // runs spent. It is read here, before anything is persisted, so a chat whose spend cannot be
    // read refuses the run instead of starting it unmeasured. The run is told the total once and
    // is stopped by it only before its first step. Two runs that start together both read the
    // total as it is: the owner's decision is that the NEXT run stops, not one that has begun.
    const chatCostBudget = await peers.chatCostBudgetOf(sessionAgent, sessionId, session);
    const requestContext = await bindRunWorkspaceAuthority(
      workspace,
      normalizeRunRequestContext(
        request.requestContext,
        runId,
        sessionId,
        agentName,
        request.principal,
      ),
      owner,
    );
    if (isTransportIssuedAuthority(requestContext)) {
      if (!core.requestAuthorityValidator) {
        throw new BureauError(
          'Cannot create run: transport-issued request authority cannot be validated.',
          'CONFLICT',
        );
      }
      if (!(await core.requestAuthorityValidator(requestContext))) {
        throw new BureauError(
          'Cannot create run: request authority is no longer current.',
          'CONFLICT',
        );
      }
    }

    // AB-13 — admit BEFORE any session/runtime work: createRun returns
    // synchronously right after the run starts (it does not await
    // completion), so admission is a synchronous pre-gate — over-cap or
    // rate-limited or duplicate triggers are rejected outright, not queued.
    // COR-690: re-checked here because the authority validation above awaits,
    // and `shutdown()` may have started during it.
    assertRunAdmissionOpen('run');
    // COR-424 — a request naming a run-creation request id consults the
    // command ledger before flow control, so an exact retry replays the
    // original run instead of being admitted, or rejected, as new work. A
    // fresh claim is settled exactly once below: completed with the run's
    // summary once it is durably started, or released when no run results.
    // The payload digest takes every default at the value this run will use,
    // so a retry that spells out a default it first omitted is the same
    // command. The session is the one the request names: an omitted session
    // is minted afresh per attempt, so its minted id cannot be part of it.
    const ledgerAttempt =
      request.runCreationRequestId === undefined
        ? undefined
        : await requireRunCreationLedger().begin({
            // A run creation request id requires an explicit `principal`, so this is
            // exactly the owner the run records, and the caller a receipt replays to
            // is the principal that owns the run. The `''` is unreachable.
            callerId: request.principal ?? '',
            // The agent the run is, not the one the caller stated: a retry that spells out
            // the agent an omitted name inherited is the same command, and
            // `locateRunCreationReceipt` resolves it the same way.
            agentName,
            requestId: request.runCreationRequestId.trim(),
            payloadDigest: digestRunCreationPayload({
              agentName,
              input: serializeTaskInput(request.taskInput ?? legacyTaskInputOf(request)),
              contextId: request.sessionId?.trim(),
              requestContext: serializeTaskRequestContext(request.requestContext),
            }),
            claim: { runId, sessionId },
          });
    if (ledgerAttempt?.kind === 'replay') return ledgerAttempt.result;
    const ledgerClaim = ledgerAttempt;
    if (core.flowController) {
      const decision = core.flowController.admit({
        runId,
        agentName,
        source: 'api',
        message: requestText,
        sessionId,
        ...(request.principal !== undefined ? { principal: request.principal } : {}),
      });
      if (!decision.allowed) {
        const rejection = new BureauError(
          `Run rejected by flow control policy (${decision.reason})`,
          'RATE_LIMITED',
        );
        await releaseRunCreationClaim(ledgerClaim, rejection);
        throw rejection;
      }
    }

    // AB-13 — everything below stays INLINE in this same function (not a
    // separately-awaited helper): an extra `await helper(...)` layer would
    // add a microtask hop before `createRun` resolves back to the caller,
    // shifting how much of the in-memory loop's own internal scheduling has
    // run by the time a caller can first call `abortRun()` — existing
    // abort-timing tests depend on that not moving. try/catch alone adds no
    // such hop, so it is the release mechanism here.
    //
    // AB-361 review (codex P2 PRRT_kwDORvupsc6ga0TX): distinguishes the
    // catch block's two reachable cases below — set true the moment
    // `store.register` succeeds, so a durable-write failure that happens
    // AFTER registration (this run is already a terminal FAILED run other
    // callers can see via `listRuns()`/`getRun()`) does not fall through
    // the SAME `runAttribution.delete(runId)` cleanup a genuinely
    // never-registered run needs.
    let registeredForRecovery = false;
    // COR-1524: whether this run holds a snapshot reference that nothing else will settle if the
    // run never registers.
    let heldAgentReference = false;
    let created: RunSummary;
    try {
      if (!session) {
        if (effectiveSystemPrompt) {
          conversation.appendSystemMessage(effectiveSystemPrompt);
        }
      }

      if (request.message !== undefined) conversation.appendUserMessage(request.message);
      if (request.inputParts !== undefined) appendAgentInput(conversation, request.inputParts);
      appendRequestRows(conversation, request.appendMessages);
      // A run answers the row the conversation ends in: a user message, or a
      // tool result (the outcome of an approval) with nothing newer.
      assertConversationAnswerable(conversation);

      // AB-54 usage analytics: resolve agentName/principal deterministically now
      // (before `store.register`, so it's in place before any listRuns()/getRun()
      // call can observe this run) rather than relying on the tool-bubble-event
      // heuristic, which cannot see a run that never calls a tool.
      runAttribution.set(runId, { agentName, principal: owner });
      // COR-2009 — the audit log's "Started a run": who started it, the agent, and the chat it runs
      // in, which the log names by its title. Best effort and not awaited, so starting a run takes
      // no extra turn (AB-13 above); the trail tracks the write until it is disposed.
      void core.auditTrailInstance?.record({
        runId,
        type: 'run.started',
        principal: owner,
        detail: { agentName, sessionId },
      });
      const runRuntime = await runtime.createRunRuntime(
        {
          ...request,
          agentName,
          sessionId,
          runId,
          requestContext,
        },
        {
          sessionAgent,
          memoryOwner: owner,
          withoutMemory: triedRun,
          sessionMetadata: session?.metadata,
        },
      );
      runRequestContexts.set(runId, requestContext);

      const disposeStreamListeners: Array<() => void> = [];

      // COR-1524 — a file agent's definition is stored, and this run tied to it, before the
      // session names the run, so recovery always finds the snapshot the session's hash points at.
      if (sessionAgent?.agentBinding !== undefined) {
        await core.fileAgents?.recordBoundRun(sessionAgent.agentBinding, runId);
        heldAgentReference = core.fileAgents !== undefined;
      }
      const savedAsRunning = await peers.saveSession(
        sessionId,
        conversation,
        {
          lastRunId: runId,
          lastRunStatus: 'running',
          // This run's own starting entry: durable steering counts it as
          // starting, until its `promoted` entry is logged and for a bounded
          // time, even when another run's save replaces `lastRunId`.
          ...(peers.durableSteeringStore() === undefined
            ? {}
            : { steeringStartingRuns: { [runId]: runtimeServices.clock.nowISO() } }),
          lastUserMessage: requestText,
          // COR-1577 — the definition the named agent had when this run started, so recovery can
          // tell when the catalog's has moved on. Null for the default agent, which has none.
          [SESSION_AGENT_REVISION_METADATA_KEY]: sessionAgent?.definitionRevision ?? null,
          // COR-1524 — the file the agent was read from, by hash, so recovery builds from the
          // snapshot. Null for a code-defined agent, and for the default one.
          [SESSION_AGENT_DEFINITION_HASH_METADATA_KEY]: sessionAgent?.agentBinding?.hash ?? null,
          // Reset the active-skill snapshot at the start of every run so a reused
          // session never seeds a fresh run with the PREVIOUS run's active skills.
          // The snapshot is otherwise written only by createSkillRecordSnapshotHook
          // after the run's first onStep boundary; if the durable process crashes
          // before that first snapshot, recovery would read this session's stale
          // records and pre-seed the new run with skills a live fresh run would not
          // have. null clears it: buildRunDepsFromSession runs the value through
          // isSkillActivationRecordArray, which rejects null → the recovered run
          // starts empty, exactly as a fresh run would (PRRT_kwDORvupsc6Mddv3).
          //
          // All three keys, not just the records. The run id and step are what
          // readCommittedScheduledSkillSnapshot matches on, and a stale pair left
          // behind would let it accept a committed step snapshot belonging to a
          // previous run on this session.
          activeSkillRecords: null,
          activeSkillRecordsRunId: null,
          activeSkillRecordsStep: null,
          // Durable recovery needs the authority that was safe to persist at
          // dispatch time. Credentials, tracing, and other request-local data
          // intentionally never cross the session boundary.
          lastRequestAuthority: persistedRequestAuthority(requestContext, agentName),
          lastRequestAuthorities: { [runId]: persistedRequestAuthority(requestContext, agentName) },
          // AB-359, COR-718 — persist the run's OWNER (`request.principal`, or
          // `anonymous:local` when it states none), never
          // `requestContext.authority.principalId`: that is tool-execution
          // authority, and it is synthesized as `run:${runId}` when the caller
          // omitted a principal, per `normalizeRunRequestContext` above. Persisting
          // it lets a recovered run's real owner authorize against durable
          // `eventHistory` after a process restart, when `runAttribution` (AB-54's
          // in-memory-only map) has been lost. Written unconditionally, like
          // `runAttribution.set` above: every run has an owner, so a restart
          // reads the same owner the run had live.
          lastRunOwningPrincipals: { [runId]: owner },
          // COR-718 — the session's owner, written once: `mergeMetadata` keeps the
          // stored owner when the session already has one.
          [SESSION_OWNER_METADATA_KEY]: owner,
          // COR-1911 — the session of an agent being tried says so once, when it is created.
          ...peers.triedOriginMetadata(triedRun, session),
        },
        // Stamp a new session with the dispatched agent (PRRT_kwDORvupsc6MbUsN) so it
        // is not always recorded as the house default 'bureau'. An existing session keeps the
        // agent it was created for.
        agentName,
        baseConversationHistory,
      );

      // F3 — opt-in `requestHumanInput` wiring for a REAL durable run
      // (`options.humanInput`). This closes the tracked wiring gap: the tool's
      // mutable `pendingHumanWait` slot must be the EXACT object Weft hands
      // back as `ctx.services` (durable's own per-run deps), and its
      // `HumanWaitParkedEvent` dispatch must land on the EXACT emitter this
      // run's `ActiveRun` exposes — neither exists until `createActiveRun`
      // constructs them below, and both are internal to the durable adapter.
      // `emitter` is threaded in directly (built here, handed to
      // `createActiveRun` to use instead of minting its own); the
      // `ctx.services` reference is captured via `onServices`, a synchronous
      // hook the durable adapter fires immediately before `engine.prepare` —
      // see `DurableActiveRunOptions.onServices` in operative for why this is
      // the only point such a reference can be obtained. Once captured, the
      // tool's `pendingHumanWait` setter forwards onto it, so a real
      // `requestHumanInput` call actually parks the workflow AND fires an
      // observable event — reaching the `activeRun.addEventListener(
      // HumanWaitParkedEvent.type, …)` listener below (AB-13 `markParked`)
      // and `store`'s action log (AB-20 `listPendingReviews`).
      let humanInputEmitter: CompletableEventTarget<CombinedOperativeEventMap> | undefined;
      // Shared `ctx.services` capture for BOTH durable-only opt-in tools this
      // run may wire (`requestHumanInput` and `scheduleWakeup`): Weft's
      // durable adapter fires exactly one `onServices` hook per run
      // (`DurableActiveRunOptions.onServices`, immediately before
      // `engine.prepare`), so a SINGLE ref/hook is captured here and handed to
      // whichever context(s) `wireDurableOptInTools` wires below need it —
      // two separate hooks would have the later one clobber the earlier
      // one's `onServices` property in the `createActiveRun` options object
      // literal, silently breaking whichever tool composed first.
      const servicesRef: { current?: DurableRunDeps } = {};
      // COR-1710 — the tools this task is granted, read from the settings once and recorded on its
      // admission record below, so its recovery offers the same ones.
      // COR-1911 — a tried agent is granted neither `scheduleWakeup` nor `decide`, whatever the
      // settings offer, and the admission record below keeps that grant for its recovery.
      const toolGrant = peers.toolGrantFor(triedRun);
      const wantsHumanInput = toolGrant.humanInput !== false && !!runtime.durable;
      const wantsWakeup = toolGrant.wakeup && !!runtime.durable;
      // COR-1709: offered to exactly the runs that are offered `requestHumanInput`.
      const decideWiring = lateDecisions.toolWiringFor(!!runtime.durable, owner, toolGrant.decide);
      if (wantsHumanInput) {
        humanInputEmitter = new CompletableEventTarget<CombinedOperativeEventMap>();
      }
      // AB-336: `wireDurableOptInTools` is the ONE place this wiring lives —
      // shared with `buildRunDepsFromSession`'s recovery path
      // (`runtime-composition.ts`), which used to omit it entirely.
      const runToolbox: BureauToolbox = wireDurableOptInTools(runRuntime.toolbox, servicesRef, {
        humanInput: wantsHumanInput,
        inputSchemas: humanInputSchemasOf(toolGrant.humanInput),
        wakeup: wantsWakeup,
        runId,
        decide: decideWiring,
        ...(humanInputEmitter ? { humanInputEmitter } : {}),
      });
      const durableServicesOnServices = runtime.durable
        ? (services: DurableRunDeps) => {
            servicesRef.current = services;
            configureChildWaitServices(services, owner);
          }
        : undefined;

      // AB-67/AB-199 — steering is scoped to in-memory (process-local)
      // sessions only: a durably-configured bureau's `submitSteeringCommand`
      // always rejects pause/resume as `unsupported-capability`, so a
      // durable run never needs a gate. An in-memory run's gate is created
      // (or reused) HERE, eagerly, before `createActiveRun` — not lazily
      // inside `submitSteeringCommand` — because a pause admitted mid-run
      // must gate THIS run's own `runStep` boundary; a gate created only on
      // first use would miss every run already started before the first
      // `submitSteeringCommand` call for its session. A gate with no
      // `pause`/`resume` ever admitted against it is inert: `getDesiredState()`
      // stays `{ paused: false, configVersion: 0 }`, which `run-step.ts`'s
      // `maybeDispatchSteeringApplied` never fires for (`configVersion > 0`
      // guard) — identical to today's no-`steering`-dependency behavior.
      // `promoteForNewRun()` promotes any agent-identity bump a prior run
      // deferred (AB-199's coordinator amendments, 2026-09-02 addendum); a
      // no-op when nothing was pending.
      // AB-200: durable runs get a steering gate too. They were excluded
      // while `submitSteeringCommand` refused every durable command —
      // attaching a gate nothing could ever write to was pointless. Now
      // that durable steering persists and recovers, excluding them would
      // be the actual bug: a command admitted and durably recovered would
      // never reach the run it was meant to steer.
      // A durable run must see the session's logged desired state at its
      // own step 0, so its start is itself a logged event: catching up and
      // appending `promoted` folds everything other processes (or this one,
      // before a restart) admitted, and records the promotion in log order.
      const steeringKv = peers.durableSteeringStore();
      const steeringSession =
        steeringKv === undefined ? undefined : await runtime.sessionStore?.load(sessionId);
      if (savedAsRunning) runSessionIncarnations.set(runId, savedAsRunning.incarnation);
      if (
        steeringKv !== undefined &&
        (steeringSession === undefined ||
          steeringSession.incarnation !== savedAsRunning?.incarnation)
      ) {
        // Saved just above; gone now, or replaced by a recreated session,
        // only if deleted concurrently. A durable run must not start on a
        // gate the steering log does not feed, nor steer, log into, or later
        // save over a session it was never started in.
        throw new BureauError(
          `Session "${sessionId}" was deleted while run "${runId}" was starting.`,
          'CONFLICT',
        );
      }
      // The session was already saved as running this run. If the run then
      // never starts, it is recorded as failed rather than left a phantom —
      // decided inside the session's own update, so it applies only while
      // this very run is still the session's latest: not to a session
      // deleted meanwhile (saving would recreate it), nor over a newer run
      // another process started.
      const markStartFailed = async (error: unknown): Promise<void> => {
        if (steeringSession === undefined) return;
        try {
          await runtime.sessionStore?.update(sessionId, (current) => {
            if (current?.incarnation !== steeringSession.incarnation) return undefined;
            // Never starting now, whichever run is the session's latest.
            const starting = current.metadata['steeringStartingRuns'];
            const stillStarting =
              typeof starting === 'object' && starting !== null && !Array.isArray(starting)
                ? Object.fromEntries(
                    Object.entries(starting).filter(([startingRunId]) => startingRunId !== runId),
                  )
                : starting;
            return {
              ...current,
              metadata: {
                ...current.metadata,
                ...(stillStarting === undefined ? {} : { steeringStartingRuns: stillStarting }),
                ...(current.metadata['lastRunId'] === runId
                  ? { lastRunStatus: 'error', lastError: serializeUnknownError(error) }
                  : {}),
              },
            };
          });
        } catch (rollbackError) {
          diagnose({
            level: 'error',
            scope: 'steering',
            message: `[bureau] Could not mark session "${sessionId}" failed after run "${runId}" failed to start: ${serializeUnknownError(rollbackError)}`,
          });
        }
      };
      if (steeringKv !== undefined && steeringSession !== undefined) {
        try {
          await peers.enqueueSteering(sessionId, () =>
            peers.appendThenApplySteering(steeringKv, sessionId, steeringSession.incarnation, {
              type: 'promoted',
              runId,
              now: runtimeServices.clock.nowISO(),
            }),
          );
        } catch (error) {
          await markStartFailed(error);
          throw error;
        }
        steeringRunIncarnations.set(runId, steeringSession.incarnation);
        peers.pollSessionSteering(sessionId, steeringSession.incarnation, runId);
      } else {
        peers
          .getSessionSteeringGate(sessionId)
          .promoteForNewRun(runId, runtimeServices.clock.nowISO());
      }
      const steeringGate = peers.getSessionSteeringGate(sessionId);
      // AB-67/AB-199 — a per-run VIEW of the shared session gate (see
      // `steering.ts`'s `forRun` doc comment): a pause bound to a DIFFERENT
      // concurrent run on this same session must never block this one.
      const runSteeringGate = steeringGate.forRun(runId);

      // COR-690: the last admission check before the run and its toolbox are
      // registered. Everything from that check to the registration is
      // synchronous, so a `shutdown()` that started during the awaits above
      // rejects this run instead of letting it start outside shutdown's snapshot.
      let activeRun: ReturnType<typeof createActiveRun>;
      let startedRunOptions: RunOptions;
      // COR-1707 — with no session store, nothing saves the context's rows or claims what they
      // reference, so the task holds its own rows, its input included, under its run for the
      // task's life, as a catalog run does; its end releases them (the terminal listeners below).
      const rowHolder: 'session' | 'run' = runtime.sessionStore === undefined ? 'run' : 'session';
      try {
        // COR-1481 — the task's record, before anything of the run starts, so a
        // record that cannot be written ends the start like any other start failure.
        await core.tasks.recordAdmission({
          taskId: runId,
          contextId: sessionId,
          incarnation: runSessionIncarnations.get(runId) ?? savedAsRunning?.incarnation ?? '',
          agentName,
          owner,
          origin: taskOrigin,
          // The text the run began with, whether it came as `message` or as an appended user row.
          message: request.message ?? (requestText === '' ? undefined : requestText),
          tools: toolGrant,
        });
        // COR-1476 — inside the block below, so a gate that cannot be built
        // (its session read fails) ends the promoted run like any other start
        // failure: its end is logged and its session's input settled.
        const runSessionInputGate = peers.sessionInputGateFor(
          sessionId,
          runId,
          runSessionIncarnations.get(runId) ?? savedAsRunning?.incarnation,
        );
        assertRunAdmissionOpen('run');
        // COR-1481 — the fence again, now that the session is saved and before the run
        // registers: a deletion that began during the awaits above has already looked
        // for this session's runs and would not find this one.
        if (inFlightSessionDeletions.has(sessionId)) {
          throw new BureauError(`Session "${sessionId}" not found`, 'NOT_FOUND');
        }
        startedRunOptions = {
          generate: runRuntime.generate,
          toolbox: runToolbox,
          conversation,
          // COR-2106 — children this run dispatches carry Bureau's tier.
          ...bureauInvariantsField(runtime.bureauChildInvariants),
          // COR-1577 — the named agent's own options (stop conditions, structured output and
          // its retries, …), before the ones Bureau sets below, which win.
          ...copyAgentOwnedRunOptions(sessionAgent?.options),
          ...(chatCostBudget === undefined ? {} : { costBudget: chatCostBudget }),
          // COR-716 — a managed asset in this run's input (or in input admitted to
          // its session mid-run) resolves as the run's owner.
          ...sessionRunMediaOptions(sessionAgent, runtime.mediaOptionsFor(owner, rowHolder)),
          maximumSteps: effectiveMaximumSteps,
          maximumTokens: effectiveMaximumTokens,
          // COR-1577 — a named agent's stop conditions replace the Bureau's default ones.
          stopWhen: sessionAgent?.options.stopWhen,
          // AB-260: the bureau's single composed RuntimeServices instance,
          // snapshotted into every run it starts.
          runtime: runtimeServices,
          ...(runSteeringGate ? { steering: runSteeringGate } : {}),
          // COR-1269 — stamped onto this run's hook-plan observations.
          sessionId,
          // COR-1476 — input admitted while this run is live, delivered at
          // each of its step boundaries.
          ...(runSessionInputGate ? { sessionInput: runSessionInputGate } : {}),
          // COR-1265 criterion 8 — merged AFTER the trailing registration, so
          // the Bureau tier is complete before it becomes the merge's `bureau`
          // tier. The merge copies every entry into a fresh
          // registry, which is what makes the plan a snapshot: a registration
          // added to `runRuntime.hooks` afterwards cannot reach this run.
          hooks: runtime.composeRunHooks({
            bureau: registerTrailingOnStep(
              runRuntime.hooks,
              'bureau:pending-approval-persist',
              createPendingApprovalPersistHook(
                runId,
                sessionId,
                pendingApprovalOverrides,
                peers.persistPendingApprovalOverrideWithRetry,
              ),
            ),
            // COR-1577 — a named agent's own hook tier follows the Bureau's, as on a catalog dispatch.
            agent: sessionAgent?.options.hooks,
          }),
          executeOptions: sessionExecuteOptions(sessionAgent?.options, requestContext),
          // Thread agentName and runId so curated tool.* bubble events are stamped
          // with {agentName, runId, step} metadata (C3) and durable launch input
          // carries the owning agent for audit/recovery attribution (F2). Fall back
          // to BUREAU_AGENT_NAME when the request omits it, matching the agent the
          // session is stamped with — otherwise the durable input + tool events
          // carry an empty agentName while the session says 'bureau'.
          agentName,
          runId,
          // The start's trace context parents this run's spans, as a catalog dispatch's does.
          ...(request.traceContext === undefined ? {} : { parentContext: request.traceContext }),
          ...(request.withTraceContext === undefined
            ? {}
            : { withTraceContext: request.withTraceContext }),
        };
        activeRun = createActiveRun(
          startedRunOptions,
          // Route through the durable engine when one was composed (durable
          // + storage). The conversation already carries the seeded user/system
          // messages, so no separate `prompt` is passed — the workflow snapshots it.
          // The run is then checkpointed and resumes from its last step after a crash.
          runtime.durable
            ? {
                engine: runtime.durable.engine,
                checkpointStore: runtime.durable.checkpointStore,
                // COR-625: this run's terminal checkpoint-retention step,
                // folded into its `closed()`. Memoized per run id, so the
                // listeners below firing it independently costs nothing.
                ...(peers.durableTerminalCleanup()
                  ? { terminalCleanup: peers.runTerminalCheckpointCleanup }
                  : {}),
                runId,
                // Carry the owning session in the durable input so boot recovery can
                // correlate a recovered handle back to its session without a side
                // table (see recoverDurableRuns / resolveRunServices).
                sessionId,
                // Lets durable steering in any process find this run as live
                // for this session incarnation (`liveSessionRunIdsEverywhere`).
                tags: [
                  taskOriginTag(taskOrigin),
                  ...(steeringSession === undefined
                    ? []
                    : [steeringSessionRunTag(sessionId, steeringSession.incarnation)]),
                ],
                ...(humanInputEmitter ? { emitter: humanInputEmitter } : {}),
                ...(durableServicesOnServices ? { onServices: durableServicesOnServices } : {}),
              }
            : undefined,
          // AB-214 review (PRRT_kwDORvupsc6esZTF): thread the authenticated
          // principal starting this run into `LivenessSnapshot.owner` — AC4
          // reserves an absent owner for a standalone (non-Bureau) run, and a
          // Bureau-started run always has one to give.
          { owner },
        );
      } catch (error) {
        await core.tasks.discard(runId).catch(() => undefined);
        // Promoted but never started, so no terminal listener will ever log
        // its end: log it here, or every process would count this run as
        // starting and keep a pause bound to it accepted.
        peers.logRunBoundarySteering(sessionId, steeringGate, {
          type: 'run-ended',
          runId,
          now: runtimeServices.clock.nowISO(),
        });
        // COR-1476 — a run that never starts has ended: it releases its gate
        // and, with no other run on the session, cancels the input left open.
        // Tracked rather than awaited, as a terminal listener's settlement is,
        // so a write that must be retried never holds this caller's rejection.
        peers.trackSessionInputSettlement(peers.settleSessionInputsAfterRunEnd(sessionId, runId));
        await markStartFailed(error);
        throw error;
      }
      activeRuns.add(activeRun);
      request.onActiveRun?.(activeRun);
      runToolboxes.add(runToolbox);
      runToolboxesByRunId.set(runId, runToolbox);
      // COR-2106 — what the run gives its tool calls, kept for the approved call that resumes later.
      const startedScope = runScopedExecutionContextOf(startedRunOptions);
      if (startedScope !== undefined) runScopedContexts.set(runId, startedScope);
      if (startedRunOptions.hooks !== undefined) runHookPlans.set(runId, startedRunOptions.hooks);
      // AB-96 — the versioned run-lifecycle frame stream. Registered before
      // `store.register` so `run-started` is the first frame a live subscriber
      // ever sees for this run.
      const disposeRunFrameForwarder = createRunFrameForwarder(
        runId,
        activeRun,
        (frame) => peers.emitLiveFrame({ type: 'run-envelope', runId, frame }),
        // AB-260: the bureau's single composed RuntimeServices clock, so
        // every run-lifecycle frame this forwarder emits is origin-derived
        // for a manually-clocked bureau rather than reading the real clock.
        { clock: runtimeServices.clock.now },
      );
      disposeStreamListeners.push(disposeRunFrameForwarder);
      // Registered here, for the same reason the frame forwarder is: before
      // `store.register`, which is what drives `run.registered` onto this
      // bureau's own feed. A client that reacts to `run.registered` by
      // subscribing to `operative.runs.events` would otherwise race an entry
      // that does not exist yet.
      disposeStreamListeners.push(
        attachRunEventFeed(runId, activeRun, runEventFeeds, {
          now: runtimeServices.clock.now,
          onError: (error, kind) => {
            diagnose({
              level: 'error',
              scope: 'event-feed',
              message: `[bureau] run event feed threw recording a "${kind}" event for run ${runId}:`,
              cause: error,
            });
          },
        }),
      );
      peers.emitLiveFrame({
        type: 'run-envelope',
        runId,
        frame: createRunStartedFrame({ runId, sessionId, agentName }, runtimeServices.clock.now),
      });

      // AB-13 — free this run's concurrency slot while it is parked on a
      // human-wait signal; `HumanWaitParkedEvent` fires on the SAME emitter
      // `store.register` subscribes to below, so this observes both the
      // in-memory and durable paths identically.
      const flowController = core.flowController;
      if (flowController) {
        activeRun.addEventListener(HumanWaitParkedEvent.type, () => {
          flowController.markParked(runId);
        });
      }

      // AB-67/AB-199 — the write side of cross-run steering dedupe:
      // `SteeringGate.getAppliedFloor()` (the read side `run-step.ts`
      // consults) only reflects reality once something raises it.
      // `runStep` dispatches `SteeringAppliedEvent` on this exact run's
      // emitter the moment it observes a `configVersion` at its boundary
      // (`run-step.ts`'s `maybeDispatchSteeringApplied`), so listening here
      // is the one place that fires for both drivers identically.
      activeRun.addEventListener(SteeringAppliedEvent.type, (event) => {
        peers.logRunBoundarySteering(sessionId, steeringGate, {
          type: 'applied',
          runId: event.effective.appliedAtRunId,
          configVersion: event.effective.configVersion,
          now: event.effective.appliedAt,
        });
      });

      /** A task that held its own rows (no session store) lets them go when it ends. */
      const releaseTaskRowClaims = (ended: ReleasableConversation): void => {
        if (rowHolder !== 'run') return;
        void peers.trackCatalogAssetRelease(
          core.catalogRunAssets.releaseConversation({
            runId,
            principalId: ownerOrLocal(owner),
            conversation: ended,
          }),
        );
      };
      // The session will record this run's end once it is terminal; a reader that asks before that
      // (`whenRunRecorded`) waits for the save, whenever the run gets there.
      peers.expectTerminalSessionRecord(runId);
      activeRun.once('run.completed', (event) => {
        activeRuns.delete(activeRun);
        erroredActiveRuns.delete(activeRun);
        releaseTaskRowClaims(event.conversation);
        releaseRunToolboxWhenIdle(runToolbox);
        peers.disposeRegisteredStreamListeners(disposeStreamListeners);
        // COR-625: a terminal transition owes this run one checkpoint-
        // retention step whether or not anyone ever calls `closed()`.
        // Memoized per run id, so this and `closed()`'s own fold resolve the
        // SAME step. Fire-and-forget: the step records its own
        // acknowledgement durably and never rejects.
        void peers.runTerminalCheckpointCleanup(runId);
        // AB-67's ratified Abort row: a session's pause/resume never carries
        // into a future run. Any command still `accepted` and bound to this
        // run transitions to `failed`/`'run-terminal'` the moment the run
        // reaches ANY terminal state — completed here, aborted in the
        // sibling listener below.
        peers.logRunBoundarySteering(sessionId, steeringGate, {
          type: 'run-ended',
          runId,
          now: runtimeServices.clock.nowISO(),
        });
        core.flowController?.settle(runId);
        queueMicrotask(() => peers.releaseTerminalRunReviewState(runId));

        const finishReason = event.finishReason;
        const lastRunStatus = isFailureFinishReason(finishReason) ? 'error' : 'completed';

        const report = buildTerminalReportFromCompletedEvent(runId, event);
        peers.emitLiveFrame({
          type: 'run-envelope',
          runId,
          frame: createRunFinishedFrame({ runId, report }, runtimeServices.clock.now),
        });

        peers.persistTerminalSession(
          () =>
            peers.saveRunTerminalSession(
              runId,
              sessionId,
              event.conversation,
              {
                lastRunId: runId,
                lastRunStatus,
                lastFinishReason: event.finishReason,
                ...(isFailureFinishReason(event.finishReason)
                  ? { lastError: serializeUnknownError(event.error) }
                  : {}),
              },
              agentName,
              baseConversationHistory,
            ),
          {
            runId,
            sessionId,
            status: lastRunStatus,
            spend: { agentName, owner, costEstimate: event.costEstimate },
          },
        );
      });

      activeRun.once('run.aborted', (event) => {
        activeRuns.delete(activeRun);
        erroredActiveRuns.delete(activeRun);
        releaseTaskRowClaims(event.conversation);
        releaseRunToolboxWhenIdle(runToolbox);
        peers.disposeRegisteredStreamListeners(disposeStreamListeners);
        // COR-625: a terminal transition owes this run one checkpoint-
        // retention step whether or not anyone ever calls `closed()`.
        // Memoized per run id, so this and `closed()`'s own fold resolve the
        // SAME step. Fire-and-forget: the step records its own
        // acknowledgement durably and never rejects.
        void peers.runTerminalCheckpointCleanup(runId);
        core.flowController?.settle(runId);
        queueMicrotask(() => peers.releaseTerminalRunReviewState(runId));
        // See the identical call in the `run.completed` listener above.
        peers.logRunBoundarySteering(sessionId, steeringGate, {
          type: 'run-ended',
          runId,
          now: runtimeServices.clock.nowISO(),
        });

        const report = buildTerminalReportFromAbortedEvent(runId, {
          usage: event.usage,
          costEstimate: event.costEstimate,
          reason: event.reason,
          error: event.error,
          steps: store.getRun(runId)?.steps ?? [],
          conversation: event.conversation,
        });
        peers.emitLiveFrame({
          type: 'run-envelope',
          runId,
          frame: createRunFinishedFrame({ runId, report }, runtimeServices.clock.now),
        });

        peers.persistTerminalSession(
          () =>
            // Persist the conversation carried on the abort event, NOT the
            // launch-time `conversation` closure. On the durable path the workflow
            // mutates per-step checkpoint snapshots, so a run that aborts after
            // checkpointed steps (e.g. when engine.cancel() wins the abort race)
            // reconstructs its abort RunResult from the checkpoint — the event's
            // conversation reflects those steps, whereas the closure still holds
            // only the seed transcript. For the in-memory loop the event carries
            // the same mutated instance, so this is correct on both paths.
            peers.saveRunTerminalSession(
              runId,
              sessionId,
              event.conversation,
              {
                lastRunId: runId,
                lastRunStatus: 'aborted',
                // Write lastFinishReason too so an aborted session's metadata is
                // internally consistent (status + finishReason agree) and a prior
                // run's stale lastFinishReason on the same session can't linger. This
                // is also what boot recovery now relies on: a recovered run that
                // aborts settles through THIS listener (settleRecoveredRun is gone),
                // so the field must be written here, not only on the old recovery path.
                lastFinishReason: 'aborted',
                lastError: serializeUnknownError(event.error),
                // COR-2009 — why the run ended, when the run did not end itself: the host
                // stopped it. Written on every abort, so an earlier run's reason never lingers.
                lastRunEndReason: runsStoppedByShutdown.has(activeRun)
                  ? SESSION_END_REASON_HOST_STOPPED
                  : null,
              },
              agentName,
              baseConversationHistory,
            ),
          {
            runId,
            sessionId,
            status: 'aborted',
            spend: { agentName, owner, costEstimate: event.costEstimate },
          },
        );
      });

      activeRun.once('run.error', (_event) => {
        activeRuns.delete(activeRun);
        erroredActiveRuns.add(activeRun);
        releaseRunToolboxWhenIdle(runToolbox);
        // The stream listeners are deliberately NOT disposed here. `run.error`
        // is not terminal: Operative follows it with `run.completed`, which
        // carries the finish reason, so the `run.completed` listener above
        // disposes them once that event has reached them. Detaching on
        // `run.error` stopped the run frame forwarder and the run event feed
        // one event early, so a run that exceeded its budget never announced
        // it and a failed run's feed never recorded its terminal event
        // (COR-1419). A recovered run already works this way.
        // COR-625: a terminal transition owes this run one checkpoint-
        // retention step whether or not anyone ever calls `closed()`.
        // Memoized per run id, so this and `closed()`'s own fold resolve the
        // SAME step. Fire-and-forget: the step records its own
        // acknowledgement durably and never rejects.
        void peers.runTerminalCheckpointCleanup(runId);
        core.flowController?.settle(runId);
        queueMicrotask(() => peers.releaseTerminalRunReviewState(runId));
      });

      // A run can settle without any terminal event: a durable run whose engine lost a
      // checkpoint compare-and-swap, or was disposed, is abandoned to whoever owns it and
      // resolves its result quietly (`driveDurableRun`). The terminal listeners above never run
      // for it, and `run.error` no longer detaches the stream listeners, so a run that reported
      // an error before being abandoned would keep them attached for good. A result settles
      // only after any terminal event it carries has been dispatched, so detaching here cannot
      // cut off the `run.completed` the forwarder and the run event feed are waiting for. The
      // disposers drain as they run, which makes this a no-op after a terminal listener ran.
      detachBestEffortPromise(
        activeRun.result.finally(() => {
          erroredActiveRuns.delete(activeRun);
          peers.disposeRegisteredStreamListeners(disposeStreamListeners);
          // A result settles after any terminal event it carries has been dispatched, so a run
          // whose save has not started by now will not save: its end is not recorded here.
          peers.abandonTerminalSessionRecord(runId);
          // A quietly settled run can stay `running` in the store. Only an abandoned one is
          // handled: a terminal event already left `running` before the result settled.
          peers.settleAbandonedRun(sessionId, runId, activeRun);
        }),
      );

      store.register(activeRun, runId);
      registeredForRecovery = true;
      runSessionIdentifiers.set(activeRun, sessionId);

      // AB-361/AB-34: the started-work control contract says an
      // acknowledged durable run is durable — a caller that holds this
      // run's identifier must be able to recover it after a crash at any
      // later point. `activeRun.durablyStarted` settles with the SAME write
      // `driveDurableRun`'s `context.engine.prepare(...)` performs on the
      // durable branch (`durable/active-run-driver.ts`), which commits before
      // the run's `onRunStart` hook runs, so this never waits on that hook
      // (COR-297). Awaited here,
      // AFTER `store.register` (so `run.started` is still the first frame
      // any live subscriber sees — an earlier await would let the deferred
      // `drive()` microtask run before this function's own subscription
      // exists) and immediately before returning, so this function's own
      // promise cannot resolve until the durable record is committed.
      // Guarded by `runtime.durable`, not an unconditional `await
      // activeRun.durablyStarted` — that field is `undefined` on the
      // in-memory branch (nothing durable to await), and an unconditional
      // `await undefined` would still cost every in-memory run one extra
      // microtask tick it does not have today.
      if (runtime.durable) {
        await activeRun.durablyStarted;
      }
      // Bound before the receipt write below: the run is executing by now, so an abort during a
      // slow write reaches it at once rather than once the write returns.
      if (request.signal !== undefined)
        peers.bindStartSignal(request.signal, runId, activeRun.result);

      created = serializeRunState(store.getRun(runId)!, sessionId);
    } catch (error) {
      // Reached either because the run never got as far as `store.register`
      // (no terminal event to settle through — the original reason this
      // catch exists), OR because `store.register` succeeded but the
      // AWAITED `durablyStarted` above rejected (a genuine durable-write
      // failure — `engine.prepare` rejecting, or a caller-supplied
      // `onServices` throwing; see `driveDurableRun`'s own review-fixed
      // handling of both, PRRT_kwDORvupsc6gWc39/PRRT_kwDORvupsc6gWb3a).
      // Either way this function is about to throw instead of returning a
      // run identifier to its caller, so release whatever this admission
      // claimed so it does not leak a phantom concurrency/singleton hold.
      // In the second case the run itself is already registered, but its
      // terminal `run.completed` listener already fired SYNCHRONOUSLY,
      // inside `makeErrorResult`'s `RunCompletedEvent` dispatch — by
      // construction this happens before this function's own `await
      // activeRun.durablyStarted` line can even resume (that rejection is
      // only observed in a later microtask) — never merely "will fire"
      // asynchronously afterward, so this cleanup is scoped to per-request
      // bookkeeping this function itself owns, not to unregistering the
      // run.
      core.flowController?.settle(runId);
      // COR-1524: a run that never registered has no terminal action to settle its snapshot
      // reference, so the reference is released here; a registered one settles through the store.
      if (heldAgentReference && !registeredForRecovery) {
        await core.fileAgents?.releaseRun(runId);
      }
      runRequestContexts.delete(runId);
      // AB-361 review (codex P2 PRRT_kwDORvupsc6ga0TX): only the
      // never-registered case may delete `runAttribution` — a run that
      // reached `store.register` is ALREADY a terminal FAILED run other
      // callers can observe via `listRuns()`/`getRun()` (its
      // `run.completed` listener fired synchronously, per the comment
      // above), and `resolveEventHistory()`'s authorization check fails
      // closed when this map entry is absent, locking the run's real owner
      // out of its own event history. A normal terminal run keeps its
      // attribution until an explicit `deleteRun`; this post-registration
      // durable-write-failure path must match that, not the
      // never-registered path's full cleanup.
      if (!registeredForRecovery) {
        runAttribution.delete(runId);
      }
      // COR-424: no acknowledged run resulted, so the claim is released and a
      // retry starts afresh. That includes a run registered here whose
      // durable start then failed: the engine holds no record of it to
      // recover, so there is nothing for a retry to observe.
      // COR-718: a save that lost the race to create the session is refused as a
      // session that is not there, exactly as the preflight check refuses one.
      // COR-1577: a save that lost the race to bind the session to an agent is refused as the
      // preflight check refuses a run naming another agent, before the run executes.
      const rejection =
        error instanceof SessionOwnerConflictError
          ? new BureauError(`Session "${sessionId}" not found`, 'NOT_FOUND')
          : error instanceof SessionAgentConflictError
            ? new BureauError(
                // A run that named no agent started on the default one before it saw the
                // session, so it must not be told it named `bureau`.
                request.agentName === undefined
                  ? `Session "${sessionId}" was bound to agent "${error.boundAgentName}" by ` +
                      `another run while this run, which named no agent, was starting on the ` +
                      `default agent "${error.requestedAgentName}". Retry to continue the session.`
                  : error.message,
                'BAD_REQUEST',
              )
            : error;
      await releaseRunCreationClaim(ledgerClaim, rejection);
      throw rejection;
    }
    // COR-424: the ledger records the run only once it is durably started,
    // so a retry never replays a run that a restart could not recover. When
    // recording fails, `complete` rejects with a
    // `RunCreationReceiptUnrecordedError` naming the run. The caller holds no
    // handle to that run, so it is aborted rather than left executing
    // unowned; the claim stays pending, and a retry observes the aborted run
    // and records its receipt.
    if (ledgerClaim === undefined) return created;
    return ledgerClaim.complete(created).catch((error: unknown) => {
      peers.abortTask(runId, 'Aborted: the task’s receipt was not recorded');
      throw error;
    });
  }

  /**
   * COR-1577 — which agent a run is. A session is bound to the agent of the run that created it,
   * so an existing session decides, and a run that names another agent is refused; a new session
   * takes the named agent, or the default `bureau`. Starting a run and locating its
   * run-creation receipt both resolve the agent here, so the two cannot disagree on the ledger key.
   */
  function resolveRunAgentName(
    sessionId: string,
    session: AgentSession | undefined,
    statedAgentName: string | undefined,
  ): string {
    if (
      session !== undefined &&
      statedAgentName !== undefined &&
      statedAgentName !== session.agentName
    ) {
      throw new BureauError(
        `Session "${sessionId}" belongs to agent "${session.agentName}", so a run cannot name ` +
          `agent "${statedAgentName}".`,
        'BAD_REQUEST',
      );
    }
    return session?.agentName ?? statedAgentName ?? BUREAU_AGENT_NAME;
  }

  /**
   * COR-424 — the run-creation ledger, or `NOT_CONFIGURED` for a bureau whose
   * receipts could not survive a restart.
   */
  function requireRunCreationLedger(): NonNullable<typeof core.runCreationLedger> {
    if (core.runCreationLedger === undefined) {
      throw new BureauError(
        'Run-creation receipts need storage and a durable engine: "runCreationRequestId" ' +
          'is supported only by a bureau with durable execution.',
        'NOT_CONFIGURED',
        'durable',
      );
    }
    return core.runCreationLedger;
  }

  /**
   * COR-424 — where a run-creation request's receipt stands, keyed exactly as
   * `createRunFromRequest` keys the request. See `Bureau.locateRunCreationReceipt`.
   */
  async function locateRunCreationReceipt(
    request: LocateRunCreationReceiptRequest,
  ): Promise<RunCreationReceiptLocation> {
    const principal = typeof request.principal === 'string' ? request.principal : '';
    const requestId =
      typeof request.runCreationRequestId === 'string' ? request.runCreationRequestId.trim() : '';
    if (principal.trim().length === 0) toBadRequest('"principal" must be a non-empty string');
    if (requestId.length === 0) toBadRequest('"runCreationRequestId" must be a non-empty string');
    const ledger = requireRunCreationLedger();
    // A request that continued a session was keyed under the session's agent, so naming the
    // session resolves it the way starting the run did. A session that is not there, or is
    // another principal's, binds nothing, exactly as it would not have for the run.
    let agentName = request.agentName;
    const sessionId = request.sessionId?.trim();
    // COR-323 — no run belongs to an implicit default agent any more, so a query that names
    // neither the agent nor the session has no key to look under.
    if ((sessionId === undefined || sessionId.length === 0) && agentName === undefined) {
      toBadRequest('"agentName" or "sessionId" must say which agent the run was created as');
    }
    if (sessionId !== undefined && sessionId.length > 0) {
      const { session } = await peers.loadConversation(sessionId);
      const owner = ownerFromPrincipal(principal, toBadRequest);
      const visible =
        session !== undefined && isSessionAuthorityAuthorized(session.metadata, owner)
          ? session
          : undefined;
      agentName = resolveRunAgentName(sessionId, visible, request.agentName);
      // COR-323 — a session that is missing or not this principal's binds nothing, so the agent
      // must then be named.
      if (visible === undefined && request.agentName === undefined) {
        toBadRequest('"agentName" is required when "sessionId" names no session you can see');
      }
    }
    return ledger.locate({
      callerId: principal,
      agentName: agentName ?? BUREAU_AGENT_NAME,
      requestId,
    });
  }

  /**
   * COR-424 — release a run-creation claim whose request produced no run, so
   * a retry claims afresh. A failed release leaves the claim pending, and a
   * retry then reports the claimed run as not started rather than creating
   * one; the original failure is still what the caller sees.
   */
  async function releaseRunCreationClaim(
    claim: Extract<RunCreationAttempt, { kind: 'claimed' }> | undefined,
    cause: unknown,
  ): Promise<void> {
    if (claim === undefined) return;
    try {
      await claim.release(cause);
    } catch (releaseError) {
      diagnose({
        level: 'error',
        scope: 'run-creation-ledger',
        message: '[bureau] Failed to release a run-creation claim after the run was not created.',
        cause: releaseError,
      });
    }
  }

  return { createRunFromRequest, locateRunCreationReceipt };
}
