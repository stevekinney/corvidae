/**
 * Session restore (COR-2376 slice S10): read the skill snapshot of a restored run, decide the
 * toolbox an approval's call runs under, resolve the catalog agent a recovered session run belongs
 * to, restore a terminal review session, and dispose the listeners a run registered. Built by
 * `constructBureau` and reached only through `createBureau`; boot, durable recovery, fire approval
 * restore and review resolution call into it.
 */
import type { AgentDefinitions } from '../agent-catalog';
import type { AgentSession, JSONValue } from '@lostgradient/operative';
import { BUREAU_AGENT_NAME } from '../bureau-construction-support';
import type { BureauCore } from './core';
import { BureauError } from '../bureau-errors';
import {
  SESSION_AGENT_DEFINITION_HASH_METADATA_KEY,
  sessionRecordedRevision,
} from '../session-agent-revision';
import { isScheduledFireAuthority } from '../bureau-invariant-hooks';
import { recordRecoveredSkillPolicy, recoveredSkillPolicyOf } from '../skill-step-metadata';
import {
  type BureauToolbox,
  type SessionAgentRun,
  type SkillSnapshot,
} from '../runtime-composition-types';
import type { PendingReview } from '../types';
import {
  adoptRestoredScheduledFire,
  releaseScheduledFireReviews,
} from '../scheduled-fire-review-state';
import { agentSkillsRun } from '../agent-skills';
import { recoveredRequestContextFromMetadata } from '../session-request-context';
import { resolveRunMemoryOwner, resolveSessionOwner } from '../session-authority';
import { serializeUnknownError } from '../serialization';

/** The callables session restore reads from elsewhere in `constructBureau`. */
export interface SessionRestorePeers {
  /** Prunes the persisted state of an invalid approval review. */
  readonly prunePersistedInvalidApprovalReviewStateWithRetry: (
    sessionId: string,
    runId: string,
    reviewId: string,
  ) => Promise<void>;
  /** Restores the pending approvals of a run. */
  readonly restorePendingApprovalStates: (
    toolbox: BureauToolbox,
    metadata: unknown,
    runId: string,
    sessionId: string,
    committed?: ReadonlySet<string>,
  ) => Promise<void>;
  /** Follows the reviews of a scheduled fire. */
  readonly followFireReviews: (runId: string) => void;
  /** Stops following a fire once no review of it remains. */
  readonly unfollowFireReviewsWhenNoneRemain: (runId: string) => void;
}

/** Builds the session restore of one Bureau. Synchronous, and registers nothing. */
export function createSessionRestore<D extends AgentDefinitions>(
  core: BureauCore<D>,
  peers: SessionRestorePeers,
) {
  const {
    runtimeServices,
    runtime,
    diagnose,
    dropPendingApprovalOverride,
    runToolboxesByRunId,
    releaseRunScope,
    pendingApprovalOverrides,
    terminalReviewSessions,
    scheduledFireApprovalRuns,
    invalidApprovalReviewIds,
    runRequestContexts,
    scheduledFireReviewState,
  } = core;

  /** COR-1620 — the active-skill snapshot of a restored run, read from its session. */
  function readRestoredSkillSnapshot(
    session: { readonly metadata: Record<string, JSONValue> } | undefined,
    runId: string,
    scheduledFire: boolean,
    agentHasSkills = false,
  ): Promise<SkillSnapshot> {
    return scheduledFire
      ? runtime.readCommittedScheduledSkillSnapshot(session, runId, true, agentHasSkills)
      : Promise.resolve(runtime.readSessionSkillSnapshot(session, runId, agentHasSkills));
  }

  /**
   * COR-1620 — the toolbox whose tools decide whether an approval's call is permitted by the
   * run's active skills. A live run's own toolbox is it. One that recovery built (a restored
   * approval's, a replayed fire's, a reattached session run's) is decided under the snapshot read
   * again now, so a failure that has cleared is not held against it: the same
   * toolbox when the snapshot is what it was built with, and one built with the snapshot read now
   * otherwise. When the snapshot cannot be verified, or a stored skill was refused on recovery,
   * or the run has no toolbox of its own and the base toolbox carries no skills, the approval is
   * refused with `CONFLICT`: it never runs without the policy that governed it.
   */
  async function skillPolicyToolboxOf(
    review: Extract<PendingReview, { kind: 'tool-approval' }>,
    registered: BureauToolbox | undefined,
  ): Promise<BureauToolbox> {
    const restored = registered === undefined ? undefined : recoveredSkillPolicyOf(registered);
    if (registered !== undefined && restored === undefined) return registered;
    if (review.sessionId === undefined) return registered ?? runtime.baseToolbox;
    const refuse = (reason: string): never => {
      throw new BureauError(
        `Cannot approve: the skill policy that governed this call could not be verified (${reason}).`,
        'CONFLICT',
      );
    };
    const scheduledFire = restored?.scheduledFire ?? scheduledFireApprovalRuns.has(review.runId);
    let snapshot: SkillSnapshot;
    let session: Awaited<ReturnType<NonNullable<typeof runtime.sessionStore>['load']>>;
    try {
      session = await runtime.sessionStore?.load(review.sessionId);
      snapshot = await readRestoredSkillSnapshot(
        session,
        review.runId,
        scheduledFire,
        agentSkillsRun(restored?.sessionAgent?.options.hooks) !== undefined,
      );
    } catch (error) {
      return refuse(`its snapshot could not be read: ${serializeUnknownError(error)}`);
    }
    if (snapshot.status === 'unverifiable') return refuse(snapshot.reason);
    const records = snapshot.records ?? [];
    if (registered === undefined || restored === undefined) {
      if (records.length > 0) {
        return refuse('the run has no toolbox of its own to enforce its active skills');
      }
      return runtime.baseToolbox;
    }
    if (restored.recoveredCleanly && JSON.stringify(records) === restored.recordsKey) {
      return registered;
    }
    // An agent's skill client carries the run's active set, so a policy read again is decided on
    // a client of its own: reusing the restored one would add to the set it already holds.
    let policyAgent = restored.sessionAgent;
    if (agentSkillsRun(policyAgent?.options.hooks) !== undefined) {
      const resolved = await resolveRecoveredSessionAgent(
        restored.agentName,
        review.runId,
        session?.metadata ?? {},
        review.sessionId,
      );
      if (resolved === 'unavailable') return refuse('its agent can no longer be resolved');
      policyAgent = resolved;
    }
    const policyRuntime = await runtime.createRunRuntime(
      {
        message:
          typeof session?.metadata['lastUserMessage'] === 'string'
            ? session.metadata['lastUserMessage']
            : '',
        sessionId: review.sessionId,
        runId: review.runId,
        agentName: restored.agentName,
        requestContext: runRequestContexts.get(review.runId),
      },
      {
        sessionAgent: policyAgent,
        sessionMetadata: session?.metadata,
        initialActiveSkillRecords: records,
        memoryOwner: resolveRunMemoryOwner(session?.metadata ?? {}, review.runId),
      },
    );
    const recovery = await policyRuntime.skillsRecovered;
    if (recovery.refused.length > 0) {
      return refuse(`a stored skill was refused on recovery: ${recovery.refused.join(', ')}`);
    }
    return policyRuntime.toolbox;
  }

  /**
   * COR-1577 — the catalog agent a recovered session run belongs to, and `'unavailable'` when the agent cannot be resolved, which is reported rather than
   * thrown so one run's lost agent never stops the rest of recovery.
   */
  async function resolveRecoveredSessionAgent(
    agentName: string,
    runId: string,
    metadata: Record<string, JSONValue>,
    sessionId: string,
  ): Promise<SessionAgentRun | undefined | 'unavailable'> {
    if (agentName === BUREAU_AGENT_NAME) {
      // COR-323 — the implicit Bureau-wide agent no longer exists: a run stored under it is
      // reported, not resumed on something it never named.
      diagnose({
        level: 'warn',
        scope: 'recovery',
        message:
          `[bureau] Run "${runId}" belongs to the implicit "${BUREAU_AGENT_NAME}" agent, which ` +
          'no longer exists; it is not resumed.',
      });
      return 'unavailable';
    }
    // COR-1524: the definition THIS run started with. A session's metadata names only its latest
    // run's, and a session's runs may be of different agents, so the run's own reference decides
    // and the session's hash is what an older record without one falls back to.
    const reference = await core.fileAgents?.snapshots.reference(runId);
    const ownReference =
      reference !== undefined && reference.id === agentName ? reference : undefined;
    const recordedHash =
      ownReference === undefined
        ? metadata[SESSION_AGENT_DEFINITION_HASH_METADATA_KEY]
        : ownReference.hash;
    const resolution = await runtime.resolveSessionAgentRun(
      agentName,
      runId,
      resolveSessionOwner(metadata),
      {
        agentDefinitionHash: typeof recordedHash === 'string' ? recordedHash : undefined,
        // COR-1584: the revision the run's own reference recorded. Only a reference written before
        // references named one falls back to the session's metadata, which names its latest run's.
        definitionRevision:
          ownReference?.definitionRevision ?? sessionRecordedRevision(metadata, recordedHash),
      },
      { sessionId, metadata },
    );
    if (resolution.status === 'resolved') return resolution.run;
    diagnose({
      level: 'warn',
      scope: 'recovery',
      message:
        `[bureau] Run "${runId}" belongs to catalog agent "${agentName}", which could not be ` +
        `resolved (${resolution.status}); its restored state stays unavailable.`,
    });
    return 'unavailable';
  }

  async function restoreTerminalReviewSession(
    session: Pick<AgentSession, 'id' | 'agentName' | 'metadata' | 'updatedAt'>,
    restoredRunId?: string,
    committed?: ReadonlySet<string>,
  ): Promise<void> {
    const runId = restoredRunId ?? session.metadata['lastRunId'];
    if (
      typeof runId !== 'string' ||
      (runId === session.metadata['lastRunId'] && session.metadata['lastRunStatus'] === 'running')
    )
      return;
    const hasPendingOverride = Object.keys(
      (session.metadata['pendingApprovalOverrides'] as Record<string, unknown> | undefined) ?? {},
    ).some((reviewId) => reviewId.startsWith(`approval:${runId}:`));
    if (!hasPendingOverride) return;

    const requestContext = recoveredRequestContextFromMetadata(
      session.metadata,
      runId,
      session.id,
      session.agentName,
      runtimeServices.clock.now,
    );
    if (!requestContext) {
      const overrides = session.metadata['pendingApprovalOverrides'];
      if (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
        for (const reviewId of Object.keys(overrides)) {
          if (!reviewId.startsWith(`approval:${runId}:`)) continue;
          invalidApprovalReviewIds.add(reviewId);
          dropPendingApprovalOverride(reviewId);
          await peers.prunePersistedInvalidApprovalReviewStateWithRetry(
            session.id,
            runId,
            reviewId,
          );
          diagnose({
            level: 'warn',
            scope: 'approval-recovery',
            message:
              `[bureau] Failed to restore request authority for "${reviewId}"; ` +
              'the affected review will remain unavailable while other runs recover.',
          });
        }
      }
      terminalReviewSessions.delete(runId);
      return;
    }
    const recoveredAgentName = requestContext.agentId ?? session.agentName;
    // COR-1577 — a named run's approvals resume against that agent's own tools. COR-323: so do a
    // schedule fire's, which runs as its named catalog agent.
    const scheduledFire = isScheduledFireAuthority(session.metadata, runId);
    const recoveredSessionAgent = await resolveRecoveredSessionAgent(
      recoveredAgentName,
      runId,
      session.metadata,
      session.id,
    );
    if (recoveredSessionAgent === 'unavailable') {
      terminalReviewSessions.delete(runId);
      return;
    }
    // COR-1613: the approval is decided under the run's active skills as of its last committed
    // snapshot, as the run that raised it would decide it now. A fire's are the ones its
    // committed steps recorded; a session run's are the last snapshot of its session. COR-1620:
    // a snapshot that cannot be verified restores no skills, and each approve reads it again.
    const skillSnapshot = await readRestoredSkillSnapshot(
      session,
      runId,
      scheduledFire,
      agentSkillsRun(recoveredSessionAgent?.options.hooks) !== undefined,
    );
    const initialActiveSkillRecords =
      skillSnapshot.status === 'verified' ? skillSnapshot.records : undefined;
    const runRuntime = await runtime.createRunRuntime(
      {
        message:
          typeof session.metadata['lastUserMessage'] === 'string'
            ? session.metadata['lastUserMessage']
            : '',
        sessionId: session.id,
        runId,
        agentName: recoveredAgentName,
        requestContext,
      },
      {
        sessionAgent: recoveredSessionAgent,
        sessionMetadata: session.metadata,
        initialActiveSkillRecords,
        memoryOwner: resolveRunMemoryOwner(session.metadata, runId),
      },
    );
    // The skills must be back before a call is decided under their policy.
    const skillRecovery = await runRuntime.skillsRecovered;
    recordRecoveredSkillPolicy(runRuntime.toolbox, {
      scheduledFire,
      agentName: recoveredAgentName,
      sessionAgent: recoveredSessionAgent,
      recordsKey: JSON.stringify(initialActiveSkillRecords ?? []),
      recoveredCleanly: skillSnapshot.status === 'verified' && skillRecovery.refused.length === 0,
    });
    const terminalReviewSession = terminalReviewSessions.get(runId);
    if (terminalReviewSession) {
      terminalReviewSessions.set(runId, {
        ...terminalReviewSession,
        agentName: recoveredAgentName,
      });
    }
    runRequestContexts.set(runId, requestContext);
    runToolboxesByRunId.set(runId, runRuntime.toolbox);
    if (scheduledFire) adoptRestoredScheduledFire(scheduledFireReviewState, runId);
    await peers.restorePendingApprovalStates(
      runRuntime.toolbox,
      session.metadata,
      runId,
      session.id,
      committed,
    );
    if (
      !Array.from(pendingApprovalOverrides.keys()).some((reviewId) =>
        reviewId.startsWith(`approval:${runId}:`),
      )
    ) {
      terminalReviewSessions.delete(runId);
      runRequestContexts.delete(runId);
      runToolboxesByRunId.delete(runId);
      releaseRunScope(runId);
      releaseScheduledFireReviews(scheduledFireReviewState, runId);
      peers.unfollowFireReviewsWhenNoneRemain(runId);
    } else if (scheduledFire) {
      // COR-1621: a restored approval of a fire can be closed by a peer, whose closing is in the
      // fire's history.
      peers.followFireReviews(runId);
    }
  }

  function disposeRegisteredStreamListeners(listeners: Array<() => void>): void {
    while (listeners.length > 0) {
      const disposeListener = listeners.pop();
      disposeListener?.();
    }
  }

  return {
    skillPolicyToolboxOf,
    resolveRecoveredSessionAgent,
    restoreTerminalReviewSession,
    disposeRegisteredStreamListeners,
  };
}
