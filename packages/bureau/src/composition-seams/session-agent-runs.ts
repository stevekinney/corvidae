/**
 * Session agent runs (COR-2376 slice R2): waiting on the catalog agent's run-options resolver,
 * resolving the agent a session's run uses, rebuilding run dependencies from a session, and
 * resolving the agent of a recovered session. Built by `buildRuntimeComposition` and reached only
 * through `createRuntimeComposition`.
 */
import {
  type AgentSession,
  type DurableRunDeps,
  type JSONValue,
  type OperativeHookMap,
  bureauInvariantsField,
  sessionOriginOf,
} from '@lostgradient/operative';
import {
  BUREAU_AGENT_NAME,
  SESSION_AGENT_DEFINITION_HASH_METADATA_KEY,
  SESSION_AGENT_PLACEHOLDER_INPUT,
  SESSION_AGENT_REVISION_METADATA_KEY,
  agentInstructionsFromRunOptions,
  sessionRecordedPin,
  sessionRecordedRevision,
} from '../session-agent-revision';
import { describeDefinitionDrift } from '../agent-definition-pin';
import type {
  BureauToolbox,
  CatalogAgentRunOptionsResolver,
  CatalogRunRecordedDefinition,
  RuntimeComposition,
  SessionAgentRun,
  SessionAgentRunResolution,
  SkillSnapshot,
} from '../runtime-composition-types';
import type { CompositionCore } from './core';
import { Conversation } from 'conversationalist';
import type { HookRegistry } from '@lostgradient/lifecycle';
import type { RunHookTiers } from '../run-hook-tiers';
import type { SessionTaintSeam, SessionTaintSource } from '../session-taint-seam';
import {
  activeSkillsStepMetadata,
  activeSkillsStepMetadataKey,
  recordRecoveredSkillPolicy,
} from '../skill-step-metadata';
import { agentSkillsRun } from '../agent-skills';
import { copyAgentOwnedRunOptions, sessionExecuteOptions } from '../session-agent-options';
import {
  defaultBureauAgentName,
  grantedTools,
  hasDispatchEvent,
  recoveredOwnerOf,
  recoveredRequestContext,
  wireDurableOptInTools,
} from '../run-request-context';
import { normalizeRunRequestContext } from '../session-request-context.ts';
import { ownerOrLocal } from '../owner-of-record';
import { recoverRunWorkspaceAuthority } from '../run-authority.ts';
import { resolveRunMemoryOwner, resolveSessionOwner } from '../session-authority';
import { serializeUnknownError } from '../serialization';
import { sessionRunMediaOptions } from '../provider-resolution';

/** The callables session agent runs reads from elsewhere in `buildRuntimeComposition`. */
export interface SessionAgentRunsPeers {
  /** The seed and write-back of the taint of one run of a session. */
  readonly sessionTaintSeamFor: (
    sessionId: string,
    runId: string,
    metadata: Readonly<Record<string, JSONValue>> | undefined,
  ) => SessionTaintSeam;
  /** Composes the hook tiers of a run with the agent contributions. */
  readonly composeHooks: (tiers: RunHookTiers) => HookRegistry<OperativeHookMap>;
  /** Reads the skill snapshot a session holds. */
  readonly readSessionSkillSnapshot: (
    session: { readonly metadata: Record<string, JSONValue> } | undefined,
    runId: string,
    agentHasSkills?: boolean,
  ) => SkillSnapshot;
  /** Builds the runtime a run executes with. */
  readonly createRunRuntime: RuntimeComposition['createRunRuntime'];
  /** The media options of a run for a principal. */
  readonly mediaOptionsFor: RuntimeComposition['mediaOptionsFor'];
}

/**
 * Builds the session agent runs of one composition. Synchronous, and registers nothing.
 */
export function createSessionAgentRuns(core: CompositionCore, peers: SessionAgentRunsPeers) {
  const {
    options,
    dependencies,
    maximumSteps,
    diagnose,
    runtimeServices,
    catalogResolverGate,
    bureauChildInvariants,
  } = core;

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
    if (core.catalogResolverAbandonedReason !== undefined) {
      return { status: 'abandoned', reason: core.catalogResolverAbandonedReason };
    }
    if (core.catalogAgentRunOptionsResolver) {
      return { status: 'wired', resolver: core.catalogAgentRunOptionsResolver };
    }
    if (dependencies.awaitsCatalogAgentRunOptionsResolver !== true) return { status: 'absent' };
    if (!core.catalogResolverGateOpen) {
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
    if (core.catalogResolverAbandonedReason !== undefined) {
      return { status: 'abandoned', reason: core.catalogResolverAbandonedReason };
    }
    return core.catalogAgentRunOptionsResolver
      ? { status: 'wired', resolver: core.catalogAgentRunOptionsResolver }
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
    session?: SessionTaintSource,
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
      {
        agentName,
        ...(principal === undefined ? {} : { principal }),
        // COR-2105 — an agent that resolves its own guardrails seeds its tracker from the session's
        // taint and writes a new one back. A run with no session has none to hand.
        ...(session === undefined
          ? {}
          : {
              sessionTaint: peers.sessionTaintSeamFor(
                session.sessionId,
                runId === '' ? session.sessionId : runId,
                session.metadata,
              ),
            }),
      },
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
        ...(resolution.agentPin === undefined ? {} : { agentPin: resolution.agentPin }),
        ...(resolution.agentTaintThreshold === undefined
          ? {}
          : { agentTaintThreshold: resolution.agentTaintThreshold }),
        generationMode: resolution.generationMode,
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
    // Rehydrate the active skill set from the last-written snapshot so the
    // recovered toolbox is aware of skills activated in completed pre-crash steps.
    // Completed steps are memoized by Weft and do not re-run their tool executions,
    // so a fresh SkillSession would be unaware of any `activate_skill` calls made
    // before the crash. `activeSkillRecords` is written by createSkillRecordSnapshotHook after
    // each step boundary and is validated here before use (PRRT_kwDORvupsc6MZ1Md).
    // COR-1620: the snapshot it can verify, or none and no tools: a reattached run whose policy
    // cannot be verified, or whose stored skill the catalog refuses, is offered no tool, has its
    // approvals refused at approve, and keeps the snapshot it has.
    // COR-1577 — a recovered named run resumes under its agent, by the catalog path's policy: an
    // agent gone from the catalog fails the run, and a definition that changed since the run
    // started is logged and the current one runs.
    const sessionAgent = await resolveRecoveredSessionAgent(session, runId, agentName);
    const skillSnapshot: SkillSnapshot =
      runId === undefined
        ? { status: 'verified', records: undefined }
        : peers.readSessionSkillSnapshot(
            session,
            runId,
            agentSkillsRun(sessionAgent?.options.hooks) !== undefined,
          );
    const initialActiveSkillRecords =
      skillSnapshot.status === 'verified' ? skillSnapshot.records : undefined;
    let requestContext = recoveredRequestContext(
      session.metadata,
      runId,
      session.id,
      agentName,
      runtimeServices.clock.now,
    );
    if (options.workspace !== undefined && requestContext?.authority.workspace === undefined) {
      const owner = runId === undefined ? undefined : recoveredOwnerOf(session, runId);
      const authority = await recoverRunWorkspaceAuthority(options.workspace, undefined, owner);
      if (authority !== undefined) {
        const context =
          requestContext ??
          normalizeRunRequestContext(
            undefined,
            runId ?? session.id,
            session.id,
            agentName ?? defaultBureauAgentName,
            owner,
          );
        requestContext = { ...context, authority: { ...context.authority, workspace: authority } };
      }
    }
    const runRuntime = await peers.createRunRuntime(
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
        initialActiveSkillRecords,
        skillPolicyUnverifiable: skillSnapshot.status === 'unverifiable',
        sessionAgent,
        memoryOwner: resolveRunMemoryOwner(session.metadata, runId),
        sessionMetadata: session.metadata,
        // COR-1911 — a run of a tried agent resumes as it began, without memory.
        withoutMemory: sessionOriginOf(session.metadata) === 'try',
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
    // COR-1710 — the grant the task started with, not the settings of the moment.
    const grant = grantedTools(
      runId === undefined ? undefined : await dependencies.toolGrantFor?.(runId),
      options,
    );
    const wantsHumanInput = grant.humanInput && runId !== undefined;
    const wantsWakeup = grant.wakeup && runId !== undefined;
    // COR-1709: offered to exactly the runs that are offered `requestHumanInput`.
    const decide =
      runId === undefined
        ? undefined
        : dependencies.decideToolFor?.(recoveredOwnerOf(session, runId), grant.decide);
    if (wantsHumanInput || wantsWakeup || decide !== undefined) {
      runToolbox = wireDurableOptInTools(runRuntime.toolbox, servicesRef, {
        humanInput: wantsHumanInput,
        inputSchemas: grant.inputSchemas,
        wakeup: wantsWakeup,
        ...(decide === undefined ? {} : { decide }),
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
        // COR-2106 — children this run dispatches carry Bureau's tier.
        ...bureauInvariantsField(bureauChildInvariants),
        ...copyAgentOwnedRunOptions(sessionAgent?.options),
        // COR-1577 — the request's cap persisted at the start, then the named agent's, then the
        // Bureau's default; a run with no named agent keeps the Bureau's.
        // The run's owner of record, not its per-run service principal: a managed asset
        // resolves for whoever owns the session, as it did before the crash.
        ...sessionRunMediaOptions(
          sessionAgent,
          peers.mediaOptionsFor(resolveSessionOwner(session.metadata), 'session'),
        ),
        // COR-1707: the caps are the named agent's, as when the run started; a run carries none of
        // its own.
        maximumSteps: sessionAgent?.options.maximumSteps ?? maximumSteps,
        stopWhen: sessionAgent?.options.stopWhen ?? options.stopWhen,
        // COR-1269 — stamped onto this run's hook-plan observations.
        sessionId: session.id,
        // COR-1265 — the completed Bureau tier, snapshotted. A single-tier
        // merge still copies every entry into a fresh registry, so a
        // registration added to `runRuntime.hooks` after this point cannot
        // reach the run that already holds the copy. COR-1577 — a named agent's own tier
        // follows it, as on a catalog dispatch.
        hooks: peers.composeHooks({ bureau: runRuntime.hooks, agent: sessionAgent?.options.hooks }),
        onToolResultTaint: runRuntime.onToolResultTaint,
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
        ...(sessionAgent?.options.maximumTokens !== undefined
          ? { maximumTokens: sessionAgent.options.maximumTokens }
          : {}),
      },
    };
    if (runId !== undefined) {
      dependencies.configureDurableRun?.(
        runId,
        services,
        ownerOrLocal(recoveredOwnerOf(session, runId)),
      );
    }
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
    if (agentName === undefined) return undefined;
    // A composition with no catalog wired (`createBureau` always wires one) has no named agents,
    // so the name is only a label and the run is the Bureau-wide runtime's. A Bureau that is
    // still being built has one coming, and the run waits for it (COR-1586): resuming it under the
    // Bureau-wide runtime would be resuming it under the wrong agent.
    const wired = await awaitCatalogAgentRunOptionsResolver(runId);
    const label = runId === undefined ? 'a recovered run' : `run ${runId}`;
    if (wired.status === 'absent') return undefined;
    if (wired.status === 'abandoned') throw new Error(`${label}: ${wired.reason}`);
    // COR-323 — the implicit Bureau-wide agent no longer exists, so a run stored under it names
    // the cause instead of failing on a missing `generate`.
    if (agentName === BUREAU_AGENT_NAME) {
      throw new Error(
        `${label}: it belongs to the implicit "${BUREAU_AGENT_NAME}" agent, which no longer ` +
          'exists; it is not resumed',
      );
    }
    const owner = resolveSessionOwner(session.metadata);
    const recordedHash = session.metadata[SESSION_AGENT_DEFINITION_HASH_METADATA_KEY];
    const resolution = await resolveSessionAgentRun(
      agentName,
      runId ?? '',
      owner,
      {
        agentDefinitionHash: typeof recordedHash === 'string' ? recordedHash : undefined,
        definitionRevision: sessionRecordedRevision(session.metadata, recordedHash),
        // COR-2230 — the pin this run wrote, when it is the session's latest pinning run.
        ...sessionRecordedPin(session.metadata, runId),
      },
      { sessionId: session.id, metadata: session.metadata },
    );
    if (resolution.status === 'missing-agent') {
      throw new Error(`${label}: catalog agent "${agentName}" is no longer in the catalog`);
    }
    if (resolution.status === 'not-durable-capable') {
      throw new Error(
        `${label}: catalog agent "${agentName}" no longer supports durable definition ` +
          `resolution (OPERATIVE_RESOLVE_RUN_OPTIONS)`,
      );
    }
    if (resolution.status === 'definition-drifted') {
      // The run settles failed, naming both values, instead of resuming under an agent it did not
      // start with (COR-2230).
      throw new Error(
        `${label}: definition-drifted: ${describeDefinitionDrift(agentName, resolution.drift)}`,
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

  return { awaitCatalogAgentRunOptionsResolver, resolveSessionAgentRun, buildRunDepsFromSession };
}
