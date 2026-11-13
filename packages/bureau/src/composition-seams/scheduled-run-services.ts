/**
 * Scheduled run services (COR-2376 slice R2): reporting a schedule fire's session and services to
 * the host, persisting the session a fire creates, recovering the schedule and session of a
 * fire, reading the skill snapshot of a fire, and building the services of a scheduled run. Built by
 * `buildRuntimeComposition` and reached only through `createRuntimeComposition`.
 * `settleScheduledFire` stays in the parent: the engine listeners above the seam block call it.
 */
import {
  type AgentSession,
  type DurableRunDeps,
  type JSONValue,
  type OnStepHook,
  type OperativeHookMap,
  type PersistedSessionTaint,
  SESSION_ORIGIN_METADATA_KEY,
  SESSION_OWNER_METADATA_KEY,
  SESSION_TAINT_METADATA_KEY,
  type ScheduledAgentRunInput,
  type SessionStore,
  type SessionSummary,
  appendAgentInput,
  bureauInvariantsField,
  createAgentSession,
  isScheduledAgentRunInput,
  payloadText,
  readSessionTaint,
  reservedIdentifierReason,
} from '@lostgradient/operative';
import type {
  CatalogAgentRunOptionsResolver,
  CatalogRunRecordedDefinition,
  RuntimeComposition,
  ScheduledFireServicesNotice,
  ScheduledSessionNotice,
  SessionAgentRun,
  SessionAgentRunResolution,
  SkillSnapshot,
} from '../runtime-composition-types';
import type { CompositionCore } from './core';
import type { SessionTaintSource } from '../session-taint-seam';
import {
  Conversation,
  type ConversationHistory,
  createConversationHistory,
} from 'conversationalist';
import type { HookRegistry } from '@lostgradient/lifecycle';
import {
  KEYS,
  type WorkflowServicesResolution,
  type WorkflowServicesResolverInfo,
  decode,
  deserializeCheckpoint,
} from '@lostgradient/weft';
import {
  type RecoveredScheduleMarker,
  decodeScheduleRunMarker,
  hasPersistedScheduleMarker,
  persistedScheduleMarker,
  recoveredMarkerSessionId,
  removeLastScheduledFireTranscript,
} from '../schedule-run-marker';
import type { RunHookTiers } from '../run-hook-tiers';
import {
  SessionOwnerConflictError,
  isPlainAuthorityRecord,
  isSessionAuthorityAuthorized,
} from '../session-authority';
import type { SkillActivationRecord } from '../skills';
import type { ToolRequestContext } from 'armorer';
import {
  activeSkillSessionMetadataForStep,
  activeSkillsFromStepMetadata,
  activeSkillsStepMetadata,
  activeSkillsStepMetadataKey,
  describe,
  isSkillActivationRecordArray,
  recordRecoveredSkillPolicy,
  recordedAgentStep,
} from '../skill-step-metadata';
import { agentSkillsRun } from '../agent-skills';
import { type AgentDefinitionPin, describeDefinitionDrift } from '../agent-definition-pin';
import { sessionPinMetadata, sessionRecordedPin } from '../session-agent-revision';
import { appendConversationMessages, sessionRunMediaOptions } from '../provider-resolution';
import { committedFireApprovalIds } from '../scheduled-fire-review-state';
import {
  createSchedulerServiceRequestContext,
  defaultBureauAgentName,
  grantedTools,
  hasDispatchEvent,
  wireDurableOptInTools,
} from '../run-request-context';
import { mayUseAutomationInput, recoverRunWorkspaceAuthority } from '../run-authority.ts';
import { ownerOrLocal } from '../owner-of-record';
import { registerTrailingOnStep, scheduledFireApprovalMetadata } from '../bureau-invariant-hooks';
import { scheduledAgentRunOptions } from '../session-agent-options';
import { serializeUnknownError } from '../serialization';
import { storedScheduleInput, workflowScheduleBinding } from '../workflow-schedule.ts';

/** The callables scheduled run services reads from elsewhere in `buildRuntimeComposition`. */
export interface ScheduledRunServicesPeers {
  /** The media options of a run for a principal. */
  readonly mediaOptionsFor: RuntimeComposition['mediaOptionsFor'];
  /** Builds the runtime a run executes with. */
  readonly createRunRuntime: RuntimeComposition['createRunRuntime'];
  /** Composes the hook tiers of a run with the agent contributions. */
  readonly composeHooks: (tiers: RunHookTiers) => HookRegistry<OperativeHookMap>;
  /** Waits for the catalog agent run-options resolver a reader found unset. */
  readonly awaitCatalogAgentRunOptionsResolver: (
    runId: string | undefined,
  ) => Promise<
    | { status: 'wired'; resolver: CatalogAgentRunOptionsResolver }
    | { status: 'absent' }
    | { status: 'abandoned'; reason: string }
  >;
  /** Resolves the catalog agent a session run executes. */
  readonly resolveSessionAgentRun: (
    agentName: string,
    runId: string,
    principal?: string,
    recorded?: CatalogRunRecordedDefinition,
    session?: SessionTaintSource,
  ) => Promise<SessionAgentRunResolution>;
}

/**
 * Builds the scheduled run services of one composition. Synchronous, and registers nothing.
 */
export function createScheduledRunServices(
  core: CompositionCore,
  peers: ScheduledRunServicesPeers,
) {
  const {
    options,
    dependencies,
    maximumSteps,
    systemPrompt,
    diagnose,
    runtimeServices,
    scheduledFireScheduleIds,
    pendingScheduledTaints,
    pendingTaintKey,
    durableStorage,
    durable,
    skillsConfigured,
    bureauChildInvariants,
  } = core;

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
    agentPin: AgentDefinitionPin | undefined,
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
      const heldTaintKey = pendingTaintKey(sessionId, runId);
      const heldTaint = pendingScheduledTaints.get(heldTaintKey);
      let taintWritten: PersistedSessionTaint | undefined;
      const saved = await store.update(sessionId, (existing: AgentSession | undefined) => {
        // The updater can run again after a lost race, so it decides every time.
        taintWritten =
          heldTaint !== undefined && readSessionTaint(existing?.metadata) === undefined
            ? heldTaint
            : undefined;
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
            // COR-2230 — what the fire's code agent was when it started, named by the fire, so a
            // fire recovered after the agent moved is refused and no other run reads it. A fire
            // beside a run another run owns leaves that run's pin alone, as it leaves its skills.
            ...(sessionOwnedByAnotherRunningRun ? {} : sessionPinMetadata(agentPin, runId)),
            // COR-718 — the fire's run is owned by the schedule's owner, recorded
            // where a restart rehydrates run owners from, and a session this fire
            // creates takes the same owner. An existing session keeps its own.
            lastRunOwningPrincipals: {
              ...(isPlainAuthorityRecord(next.metadata['lastRunOwningPrincipals'])
                ? next.metadata['lastRunOwningPrincipals']
                : {}),
              [runId]: owner,
            },
            // COR-1645 — and its origin, written once with the owner: a session a fire creates is
            // not a chat a person started, while one a fire continues keeps the origin it has.
            ...(existing === undefined
              ? { [SESSION_OWNER_METADATA_KEY]: owner, [SESSION_ORIGIN_METADATA_KEY]: 'schedule' }
              : {}),
            // COR-2105 — a taint the fire raised before its session existed is stored with it.
            ...(taintWritten === undefined
              ? {}
              : { [SESSION_TAINT_METADATA_KEY]: { ...taintWritten } }),
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
      if (heldTaint !== undefined) {
        pendingScheduledTaints.delete(heldTaintKey);
        if (taintWritten !== undefined && saved !== undefined) {
          try {
            dependencies.onSessionTainted?.({
              sessionId,
              runId: taintWritten.runId,
              detector: taintWritten.detector,
              provenance: taintWritten.provenance,
              confidence: taintWritten.confidence,
            });
          } catch (error) {
            diagnose({
              level: 'warn',
              scope: 'guardrails',
              message: `[bureau] The taint of session "${sessionId}" could not be published: ${serializeUnknownError(error)}`,
              cause: error,
            });
          }
        }
      }
      // COR-1482: the first save of a fresh session gives it its incarnation, which the fire's
      // task is bound to once, so `bureau.tasks.list({ contextId })` finds the fire.
      if (!bound && saved !== undefined) {
        bound = true;
        await reportScheduledSession({ runId, sessionId, incarnation: saved.incarnation });
      }
    };
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
    agentHasSkills = false,
  ): Promise<SkillSnapshot> {
    const none: SkillSnapshot = { status: 'verified', records: undefined };
    if (!recovering || !session) return none;

    const metadata = session.metadata;
    const lastFireRunId = metadata['lastScheduledFireRunId'];
    const recordsRunId = metadata['activeSkillRecordsRunId'];
    // Without skills there is no policy to verify, and whatever the session holds is not it.
    if (!skillsConfigured && !agentHasSkills && recordsRunId !== runId) return none;
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
    agentHasSkills = false,
  ): SkillSnapshot {
    if (session === undefined) {
      return { status: 'unverifiable', reason: 'its session is not found' };
    }
    const metadata = session.metadata;
    const recordsRunId = metadata['activeSkillRecordsRunId'];
    const lastRunId = metadata['lastRunId'];
    // Without skills there is no policy to verify, and whatever the session holds is not it.
    if (!skillsConfigured && !agentHasSkills && recordsRunId !== runId)
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
    const scheduleAuthority =
      options.workspace === undefined
        ? undefined
        : await recoverRunWorkspaceAuthority(
            options.workspace,
            scheduledInput.workspaceAuthority,
            scheduledInput.principal,
          );
    if (
      options.workspace !== undefined &&
      (scheduleAuthority === undefined || scheduledInput.authorityHold !== undefined)
    ) {
      if (recoveredScheduleId !== undefined)
        dependencies.onScheduleAuthorityDenied?.(recoveredScheduleId);
      return { status: 'unavailable', reason: 'Workspace authority unavailable.' };
    }
    const owner = scheduleAuthority?.authorizingOwner ?? ownerOrLocal(scheduledInput.principal);
    if (
      options.workspace !== undefined &&
      !(await mayUseAutomationInput(
        scheduledInput.input,
        peers.mediaOptionsFor(owner, 'session').contentSourceResolver,
      ))
    ) {
      if (recoveredScheduleId !== undefined)
        dependencies.onScheduleAuthorityDenied?.(recoveredScheduleId);
      return { status: 'unavailable', reason: 'Automation input unavailable.' };
    }
    await dependencies.onScheduledFire?.({
      runId,
      scheduleId: recoveredScheduleId,
      sessionId,
      agentName,
      owner,
      message: payloadText(scheduledInput.input),
      ...(info.schedule?.manual === true ? { manual: true as const } : {}),
    });

    // COR-323 — a fire runs as a named catalog agent: its own `generate`, tools, stop condition,
    // and instructions. The implicit Bureau-wide agent no longer exists, so a schedule stored under
    // it (or under an agent that has left the catalog) fails its fire with a diagnostic instead of
    // running on something it never named.
    // A composition with no catalog wired (only a direct `createRuntimeComposition` caller has
    // none; `createBureau` always wires one) has no named agents, so the name is a label and the
    // fire runs the composition's own `generate`, as a recovered session run does.
    let fireAgent: SessionAgentRun | undefined;
    // A recovered fire resolves the definition its first attempt recorded (COR-1524).
    const firePriorReference = await dependencies.agentRunReferences?.reference(runId);
    const catalogWiring = await peers.awaitCatalogAgentRunOptionsResolver(runId);
    if (catalogWiring.status !== 'absent') {
      // COR-2105 — the session's taint seeds the agent's guardrails. A reserved id is refused below
      // before anything is read, so it is not read here either.
      const taintSession =
        reservedIdentifierReason('scheduled session', sessionId) === undefined
          ? await store.load(sessionId)
          : undefined;
      const agentResolution =
        agentName === defaultBureauAgentName
          ? undefined
          : await peers.resolveSessionAgentRun(
              agentName,
              runId,
              owner,
              {
                ...(firePriorReference === undefined || firePriorReference.id !== agentName
                  ? { agentDefinitionHash: undefined }
                  : {
                      agentDefinitionHash: firePriorReference.hash,
                      definitionRevision: firePriorReference.definitionRevision,
                    }),
                // COR-2230 — what this fire's first attempt pinned, when it got as far as writing
                // it: a fire recovered after its code agent moved is refused.
                ...sessionRecordedPin(taintSession?.metadata ?? {}, runId),
              },
              { sessionId, metadata: taintSession?.metadata },
            );
      if (agentResolution?.status !== 'resolved') {
        return {
          status: 'unavailable',
          reason:
            agentResolution === undefined
              ? `scheduled fire ${info.workflowId} names the implicit agent "${agentName}", which no longer runs: schedule it under a catalog agent`
              : agentResolution.status === 'definition-drifted'
                ? `scheduled fire ${info.workflowId} cannot run agent "${agentName}": definition-drifted: ${describeDefinitionDrift(agentName, agentResolution.drift)}`
                : `scheduled fire ${info.workflowId} cannot run agent "${agentName}": ${agentResolution.status}`,
        };
      }
      fireAgent = agentResolution.run;
      if (fireAgent.agentBinding !== undefined && firePriorReference === undefined) {
        await dependencies.agentRunReferences?.record(fireAgent.agentBinding, runId);
      }
    }

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
    // COR-323 — a fire runs as its named agent, and a continued session keeps the system prompt
    // of the agent that began it, so a session another agent owns is refused rather than run
    // under instructions that are not the fire's own.
    if (fireAgent !== undefined && existing !== undefined && existing.agentName !== agentName) {
      return {
        status: 'unavailable',
        reason: `scheduled fire ${info.workflowId} runs agent "${agentName}" but session "${sessionId}" belongs to agent "${existing.agentName}"`,
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
      const firePrompt = fireAgent?.instructions ?? systemPrompt;
      if (firePrompt) {
        conversation.appendSystemMessage(firePrompt);
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
      agentSkillsRun(fireAgent?.options.hooks) !== undefined,
    );
    const initialActiveSkillRecords =
      skillSnapshot.status === 'verified' ? skillSnapshot.records : undefined;
    const schedulerContext = createSchedulerServiceRequestContext(runId, agentName, sessionId);
    const requestContext: ToolRequestContext =
      scheduleAuthority === undefined
        ? schedulerContext
        : {
            ...schedulerContext,
            authority: { ...schedulerContext.authority, workspace: scheduleAuthority },
          };

    // COR-1546 — the fire's run writes into the schedule owner's memory, not the scheduler's.
    const runRuntime = await peers.createRunRuntime(
      { message: payloadText(scheduledInput.input), sessionId, runId, agentName, requestContext },
      {
        initialActiveSkillRecords,
        skillPolicyUnverifiable: skillSnapshot.status === 'unverifiable',
        memoryOwner: owner,
        sessionMetadata: existing?.metadata,
        sessionAgent: fireAgent,
        admitDispatch:
          options.workspace === undefined || recoveredScheduleId === undefined
            ? undefined
            : async () => {
                let admitted = false;
                try {
                  const current = workflowScheduleBinding(
                    await storedScheduleInput(durable!.engine, recoveredScheduleId),
                  );
                  admitted =
                    current.authorityHold === undefined &&
                    current.workspaceAuthority?.actorId === scheduleAuthority?.actorId;
                } catch {
                  // Unreadable or malformed durable authority must request the same pause.
                }
                if (!admitted) dependencies.onScheduleAuthorityDenied?.(recoveredScheduleId);
                return admitted;
              },
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
    // COR-1709: a fire is offered `decide` as it is offered `requestHumanInput`, as its owner.
    // COR-1710 — the grant recorded on the fire's task when it was first admitted.
    const fireGrant = grantedTools(await dependencies.toolGrantFor?.(runId), options);
    const fireDecide =
      durable === undefined ? undefined : dependencies.decideToolFor?.(owner, fireGrant.decide);
    const fireToolbox =
      (fireGrant.humanInput && durable !== undefined) || fireDecide !== undefined
        ? wireDurableOptInTools(runRuntime.toolbox, humanInputServices, {
            humanInput: fireGrant.humanInput && durable !== undefined,
            inputSchemas: fireGrant.inputSchemas,
            wakeup: false,
            runId,
            ...(fireDecide === undefined ? {} : { decide: fireDecide }),
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
        sessionAgent: fireAgent,
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
        // COR-2106 — children this run dispatches carry Bureau's tier.
        ...bureauInvariantsField(bureauChildInvariants),
        ...scheduledAgentRunOptions(fireAgent?.options, requestContext),
        ...sessionRunMediaOptions(fireAgent, peers.mediaOptionsFor(owner, 'session')),
        maximumSteps: fireAgent?.options.maximumSteps ?? maximumSteps,
        stopWhen: fireAgent?.options.stopWhen ?? options.stopWhen,
        // AB-260: the bureau's single composed RuntimeServices instance,
        // snapshotted into every run it starts — including a scheduled fire.
        runtime: runtimeServices,
        // The session write-back runs AFTER the runtime's own onStep hooks so
        // recurring fires accumulate and a stateless fire is observable.
        // COR-1269 — stamped onto this run's hook-plan observations.
        sessionId,
        // COR-1265 criterion 8 — merged AFTER the trailing registration, so the
        // Bureau tier is complete before it becomes the merge's `bureau` tier
        // and the trailing hook is offset with every other Bureau entry rather
        // than beside them at a raw priority.
        hooks: peers.composeHooks({
          bureau: registerTrailingOnStep(
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
              fireAgent?.agentPin,
            ),
          ),
          agent: fireAgent?.options.hooks,
        }),
        onToolResultTaint: runRuntime.onToolResultTaint,
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

  return {
    loadScheduleIdForRecoveredRun,
    loadExistingScheduledSessionId,
    readCommittedScheduledSkillSnapshot,
    readSessionSkillSnapshot,
    buildScheduledRunServices,
  };
}
