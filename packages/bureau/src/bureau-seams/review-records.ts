/**
 * Review records (COR-2376 slice S18): the audit records of an approved call and of a review decision,
 * the grants a decision remembers, the permission mode a run holds, the human waits of a run and the
 * sealing of their answers, resolving any review, reading one, and sweeping the expired. Built by
 * `constructBureau` and reached only through `createBureau`; the parent and nine seams call into it.
 */
import { ANONYMOUS_LOCAL_OWNER, EXPIRY_ACTOR } from '../owner-of-record';
import type { ActiveRun, PermissionMode } from '@lostgradient/operative';
import type { AgentDefinitions } from '../agent-catalog';
import type { AgentFileDefinitionInput } from '../agent-file';
import type {
  ApprovalDecisionSurface,
  PendingHumanWaitReview,
  PendingReview,
  ResolveReviewInput,
  ResolveReviewResult,
  ReviewResolutionFields,
  ReviewStatus,
  SessionPendingReview,
} from '../bureau-types/reviews';
import { type ApprovedCallAudit, approvalGrantsOf } from '../approval-state-records';
import type { BureauChildChat } from '../child-topology-store';
import type {
  BureauCore,
  ReviewAuditAttachment,
  ScheduledFireApprovalEnding,
  SteeringCursor,
} from './core';
import { BureauError, ReviewAnswerInvalidError } from '../bureau-errors';
import {
  type ChatPermissionReading,
  ChatPermissionUnavailableError,
  grantLoosensTool,
} from '../tool-approval';
import type { ConditionalTextValueStore } from '@lostgradient/storage';
import {
  ReviewApprovedEvent,
  ReviewCanceledEvent,
  ReviewDeniedEvent,
  ReviewExpiredEvent,
  ReviewRejectedEvent,
  ReviewRevokedEvent,
  ReviewSupersededEvent,
} from '../events';
import { type ReviewDecisionAuditPayload, resolvedReviewOfAudit } from '../resolved-review-record';
import {
  type SecretAnswerAuditEntry,
  SecretAnswerUnavailableError,
  gateSecretAnswer,
  holdsSealedAnswer,
  secretFieldsOfReview,
  unsealedSecretFields,
} from '../secret-answers';
import type { SessionSteeringState } from '../steering';
import { findRunAgentName, serializeUnknownError } from '../serialization';
import { isTryAgentName } from '../agent-try';
import { reviewCanceledDedupeKey } from '../review-closing-events';
import { validateReviewAnswer } from '../review-answer';

/** The callables review records reads from elsewhere in `constructBureau`. */
export interface ReviewRecordsPeers {
  /** Prunes the persisted invalid-approval review state, retrying. */
  readonly prunePersistedInvalidApprovalReviewStateWithRetry: (
    sessionId: string,
    runId: string,
    reviewId: string,
  ) => Promise<void>;
  /** Releases the approval a scheduled fire held. */
  readonly releaseScheduledFireApproval: (
    runId: string,
    reviewId: string,
    ending: ScheduledFireApprovalEnding,
    scope?: { sessionId?: string | undefined; durablyPruned?: boolean },
  ) => Promise<void>;
  /** Returns the session identifier of a run. */
  readonly getRunSessionIdentifier: (runState: { activeRun: ActiveRun }) => string;
  /** Stops the lazy expiry sweep once no review is held. */
  readonly stopLazyExpirySweepWhenNoneHeld: () => void;
  /** Throws when a decision does not fit the input the review asks for. */
  readonly assertDecisionFitsInput: (input: ResolveReviewInput) => void;
  /** Throws when the expected approval round is stale. */
  readonly assertExpectedReviewRound: (
    input: ResolveReviewInput,
    review: Pick<PendingReview, 'id' | 'kind'> & { readonly round?: number },
  ) => void;
  /** Lists the pending reviews. */
  readonly listPendingReviews: () => SessionPendingReview[];
  /** Releases the review state a terminal run held. */
  readonly releaseTerminalRunReviewState: (runId: string) => void;
  /** Resolves a pending review. */
  readonly resolveReview: (
    input: ResolveReviewInput,
    derived?: Extract<SessionPendingReview, { kind: 'human-wait' }>,
    afterCatchUp?: boolean,
  ) => Promise<ResolveReviewResult>;
  /** Restores run ownership after a run event. */
  readonly restoreRunOwnershipAfterEvent: (
    runId: string,
    sessionId: string,
    principal: string | undefined,
    incarnation: string | undefined,
  ) => Promise<void>;
  /** Returns the owner of a run. */
  readonly runOwner: (runId: string) => Promise<string | undefined>;
  /** Returns the steering state of a session. */
  readonly getSessionSteering: (sessionId: string) => Promise<SessionSteeringState | undefined>;
  /** Folds the durable steering log of a session into its cursor. */
  readonly catchUpSteering: (
    kv: ConditionalTextValueStore,
    sessionId: string,
    incarnation: string,
  ) => Promise<SteeringCursor>;
  /** Returns the durable steering store, when one is configured. */
  readonly durableSteeringStore: () => ConditionalTextValueStore | undefined;
  /** Queues a steering operation behind the others of a session. */
  readonly enqueueSteering: <T>(sessionId: string, operation: () => Promise<T>) => Promise<T>;
}

/** Builds the review records of one Bureau. Synchronous, and registers nothing. */
export function createReviewRecords<D extends AgentDefinitions>(
  core: BureauCore<D>,
  peers: ReviewRecordsPeers,
) {
  const {
    runtimeServices,
    store,
    emitter,
    runSessionIncarnations,
    runtime,
    diagnose,
    catalogRunIds,
    resolvedReviewIds,
    resolvingReviewIds,
    reviewResolutionCleanupPending,
    pendingApprovalOverrides,
    pendingApprovalRounds,
    approvalRequestedAt,
    terminalReviewSessions,
    scheduledFireApprovalRuns,
    invalidApprovalReviewIds,
    runAttribution,
  } = core;

  /**
   * COR-1828, COR-1990 — the `remembered` and `loosened` fields of a resolution that was asked to
   * remember a tool: whether the grant was stored with the decision, and whether it makes the tool's
   * next ask in the chat be skipped, which a grant that was not stored never does. Nothing when no
   * tool was named.
   */
  async function grantFieldsOf(
    rememberTool: string | undefined,
    stored: boolean,
    review: PendingReview,
  ): Promise<{ remembered?: boolean; loosened?: boolean }> {
    if (rememberTool === undefined) return {};
    return { remembered: stored, loosened: stored && (await grantLoosensReview(review)) };
  }

  /**
   * COR-1990 — whether the grant a tool approval stored makes the tool's next ask in its chat be
   * skipped, read as the next call is decided: the agent's `approvals` for the tool and the
   * chat's permission mode now. Only an agent the file catalog builds reads a grant (that catalog is
   * the one place `approvalGrantsOfRun` is wired in), and that is a file agent and a tried agent,
   * which `files.ephemeral` builds the same way: a file agent is weighed by its file's definition,
   * and a tried agent by the definition it was built from, held in the `tryAgents` registry. A code
   * agent's toolbox and a plugin agent's belong to the host, which asks again whatever the chat
   * holds, so they answer `false`, as does a tried agent whose registry entry is gone (its context
   * was deleted): the Bureau cannot show the grant will be read, and a notice that promised
   * otherwise would fail open. The decision has committed, so a read that fails answers `false` and
   * never throws: the person is told the grant did not loosen the tool, and the grant is still held.
   */
  async function grantLoosensReview(review: PendingReview): Promise<boolean> {
    if (review.kind !== 'tool-approval') return false;
    try {
      const definition = await weighableDefinitionOf(review.agentName);
      // No definition to weigh: the grant is not read for this agent, so it loosens nothing.
      if (definition === undefined) return false;
      const catalog = new Map(Object.entries(core.agentToolCatalog));
      const tools = Object.fromEntries(
        (definition.tools ?? []).flatMap((name) => {
          const tool = catalog.get(name);
          return tool === undefined ? [] : [[name, tool]];
        }),
      );
      const mode = await permissionModeOfSession(
        review.sessionId,
        runSessionIncarnations.get(review.runId),
      );
      return grantLoosensTool({
        toolApproval: definition.approvals ?? undefined,
        tools,
        reportedName: review.approval.toolName,
        mode,
      });
    } catch {
      return false;
    }
  }

  /**
   * The tools and `approvals` of the agent `agentName` as its toolbox is built from them: a tried
   * agent's from the registry, a file agent's from its file, and nothing for any other agent.
   */
  async function weighableDefinitionOf(
    agentName: string | undefined,
  ): Promise<Pick<AgentFileDefinitionInput, 'tools' | 'approvals'> | undefined> {
    if (agentName === undefined) return undefined;
    if (isTryAgentName(agentName)) return core.tryAgents.definitionOf(agentName);
    const detail = await core.fileAgents?.files.detail(agentName);
    return detail?.definition ?? undefined;
  }

  /**
   * AB-391: builds the exact `AuditTrail.record()` payload a review
   * transition's durable write needs, WITHOUT writing it — used both to
   * append it as a `session.attachment` outbox entry (coupled to the
   * preceding session-store commit) and, for a path with no such commit to
   * couple to, to write it directly. Kept as one function so the two paths
   * can never drift on shape.
   */
  /**
   * COR-2009 — the audit record of an approved call that ran. It ran outside the run's step loop,
   * so the action stream that audits a run's own tool calls never sees it; the audit log's
   * "Refunded order 4472" is this record: the tool, its call, the review that approved it and how
   * it ended, never its arguments or result.
   */
  function approvedCallAuditOf(
    review: Extract<PendingReview, { kind: 'tool-approval' }>,
    approval: { readonly toolName: string; readonly callId: string },
    result: unknown,
  ): ApprovedCallAudit {
    const outcome =
      result !== null && typeof result === 'object' && 'outcome' in result
        ? result.outcome
        : undefined;
    return {
      runId: review.runId,
      type: 'tool.settled',
      detail: {
        agentName: review.agentName,
        toolName: approval.toolName,
        toolCallId: approval.callId,
        reviewId: review.id,
        ...(typeof outcome === 'string' ? { status: outcome } : {}),
      },
    };
  }

  /** Writes an approved call's audit record, when the resolution ran one. Best effort. */
  async function recordApprovedCall(audit: ApprovedCallAudit | undefined): Promise<void> {
    if (audit !== undefined) await core.auditTrailInstance?.record(audit);
  }

  function buildReviewDecisionAuditRecord(
    review: PendingReview,
    decision: 'approve' | 'deny' | 'reject',
    principal: string,
    reason?: string,
    secretAnswers: readonly SecretAnswerAuditEntry[] = [],
    // COR-1828: a human wait's approved answer as a digest over its reference form.
    answerDigest?: string,
    // COR-1828: the owner of record of the review's run, read while the run is live, so the
    // resolved-review record a replay writes later names it whatever became of the run.
    owner?: string,
    // COR-2292: where the person decided, which the resolved-review record keeps when given.
    decisionSurface?: ApprovalDecisionSurface,
  ): ReviewAuditAttachment {
    const secretFields = review.kind === 'human-wait' ? secretFieldsOfReview(review) : [];
    const decisionSuffix =
      decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'denied';
    return {
      runId: review.runId,
      type: `review.${review.kind}.${decisionSuffix}`,
      detail: {
        // The audit record names the review as it was asked, not the schema it asked with (COR-1487):
        // that already lives in the checkpoint, and up to 32 KiB of it would repeat in every record.
        // COR-1920: the fields it marked secret stay, so a retry after the review closed can still
        // keep them out of a digest.
        review:
          review.kind === 'human-wait'
            ? ({
                ...Object.fromEntries(
                  Object.entries(review).filter(([key]) => key !== 'inputSchema'),
                ),
                ...(secretFields.length > 0 ? { secretFields } : {}),
              } as unknown as PendingReview)
            : review,
        // The schema's absence is not the form's: this marker is how a closed wait is known to
        // have shown a form (COR-1674).
        ...(review.kind === 'human-wait' && review.inputSchema !== undefined
          ? { inputForm: true }
          : {}),
        decision,
        ...(reason !== undefined ? { reason } : {}),
        // COR-1920: a secret answer is named by its field and a digest of its ciphertext, never
        // by its value.
        ...(secretAnswers.length > 0 ? { secretAnswers } : {}),
        // COR-1828: what the resolved-review record keeps of the answer.
        ...(answerDigest !== undefined ? { answerDigest } : {}),
        ...(owner !== undefined ? { owner } : {}),
        ...(decisionSurface !== undefined ? { decisionSurface } : {}),
      },
      principal,
    };
  }

  /**
   * COR-1828 — keeps the record of a decided review, from the payload of the audit entry that
   * stands for the decision. Called by each writer of that entry, so the record is as durable as
   * the entry: a decision that rode the session commit is recorded when its outbox entry is
   * replayed (at `decidedAt`, the commit's time), and any other when its audit entry is written. A
   * payload that is not a decision (an expiry, a revocation) writes nothing. The owner rides in the
   * payload's `detail`, read while the run was live. A failure to write throws: on a replay it
   * leaves the outbox entry unacknowledged for the next drain, as a failed audit write does.
   */
  async function recordResolvedReview(
    payload: ReviewDecisionAuditPayload,
    decidedAt: number,
  ): Promise<void> {
    if (!payload.type.startsWith('review.')) return;
    const resolved = resolvedReviewOfAudit(payload, decidedAt);
    if (resolved === undefined) return;
    if (await core.resolvedReviewStore.record(resolved)) return;
    // A record already held is the same decision replayed, unless another decision won the review.
    const held = await core.resolvedReviewStore.get(resolved.review.id);
    if (
      held !== undefined &&
      (held.decision !== resolved.decision || held.decidedBy !== resolved.decidedBy)
    ) {
      diagnose({
        level: 'error',
        scope: 'audit-trail',
        message: `[bureau] The resolved-review record of "${resolved.review.id}" already holds ${held.decision} by "${held.decidedBy}"; ${resolved.decision} by "${resolved.decidedBy}" was not kept.`,
      });
    }
  }

  /** The owner of record a decision's records name: the run's, or the local owner of a run no one holds. */
  async function ownerForRecord(runId: string): Promise<string> {
    try {
      return (await peers.runOwner(runId)) ?? ANONYMOUS_LOCAL_OWNER;
    } catch {
      return ANONYMOUS_LOCAL_OWNER;
    }
  }

  /** {@link recordResolvedReview} for a writer that cannot retry it: a failure is diagnosed, not thrown. */
  async function recordResolvedReviewBestEffort(
    payload: ReviewDecisionAuditPayload,
  ): Promise<void> {
    try {
      await recordResolvedReview(payload, runtimeServices.clock.now());
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'audit-trail',
        message: `[bureau] Could not keep the resolved-review record of "${payload.runId}": ${serializeUnknownError(error)}`,
        cause: error,
      });
    }
  }

  async function recordReviewDecision(
    review: PendingReview,
    decision: 'approve' | 'deny' | 'reject',
    principal: string,
    reason?: string,
    // AB-391: `true` when the caller already appended this decision's audit
    // record as a `session.attachment` outbox entry (via
    // `persistReviewResolutionWithRetry`'s `auditAttachment` parameter) and
    // has drained it — the durable write already happened, or is pending a
    // later drain, so writing it again here would duplicate it. `false`
    // (the default) is the ONLY path with no preceding session-store commit
    // to couple to (`resolveReview`'s `keepPending` re-gate branch), where
    // the direct write below remains correct exactly as it always was.
    requestOptions?: {
      auditAlreadyAppended?: boolean;
      secretAnswers?: readonly SecretAnswerAuditEntry[] | undefined;
      answerDigest?: string | undefined;
      owner?: string | undefined;
      /** COR-2292: where the person decided, for the audit entry written here. */
      decisionSurface?: ApprovalDecisionSurface | undefined;
      /**
       * COR-1828: `false` for a decision that left the review pending (a re-gated approval), whose
       * resolved-review record would name a decision nothing acted on and, being written once,
       * would hide the real one.
       */
      decisionIsFinal?: boolean;
    },
  ): Promise<void> {
    // COR-1622: a close follows the request it closes in the history, and the request of a fire's
    // first review waits for its seed read.
    await core.fireReviewSeeds.pending(review.runId);
    if (!requestOptions?.auditAlreadyAppended) {
      const directAudit = buildReviewDecisionAuditRecord(
        review,
        decision,
        principal,
        reason,
        requestOptions?.secretAnswers,
        requestOptions?.answerDigest,
        requestOptions?.owner ?? (await ownerForRecord(review.runId)),
        requestOptions?.decisionSurface,
      );
      await core.auditTrailInstance?.record(directAudit);
      // COR-1828: this entry rode no session commit, so no replay will keep the record.
      if (requestOptions?.decisionIsFinal !== false) {
        await recordResolvedReviewBestEffort(directAudit);
      }
    }

    // AB-224: the live counterpart of the durable write above — dispatched
    // alongside it, never instead of it, closing the live-side gap AB-87's
    // matrix named ("a typed review.*... family not built"). Carries only
    // id/runId/principal/kind; actor/decision content (arguments, reasons)
    // stays privileged to the durable audit trail per AB-87's redaction
    // column.
    if (decision === 'approve') {
      emitter.dispatch(new ReviewApprovedEvent(review.id, review.runId, principal, review.kind));
    } else if (decision === 'reject') {
      emitter.dispatch(new ReviewRejectedEvent(review.id, review.runId, principal, review.kind));
    } else {
      emitter.dispatch(new ReviewDeniedEvent(review.id, review.runId, principal, review.kind));
    }
    // COR-1577: a catalog run's review has no session whose ownership could need restoring.
    if (review.sessionId !== undefined) {
      await peers.restoreRunOwnershipAfterEvent(
        review.runId,
        review.sessionId,
        runAttribution.get(review.runId)?.principal,
        runSessionIncarnations.get(review.runId),
      );
    }
  }

  /**
   * COR-1828 — the tools a person allowed for the rest of the chat `runId` belongs to, read from
   * the session's metadata when a tool call is decided. A run that no session holds (a
   * `bureau.run()` run, or one this process does not hold) has no chat, and a session that cannot be
   * read counts as having none, so the call asks.
   */
  async function approvalGrantsOfRun(runId: string): Promise<ReadonlySet<string>> {
    const sessions = runtime.sessionStore;
    if (sessions === undefined) return new Set();
    try {
      const sessionId = await sessionIdOfRun(runId);
      if (sessionId === undefined) return new Set();
      const session = await sessions.load(sessionId);
      return new Set(approvalGrantsOf(session?.metadata));
    } catch {
      return new Set();
    }
  }

  /**
   * The session `runId` belongs to, or `undefined` for a run no session holds. A run this process
   * holds names its session; one recovered after a restart is found by its task record, which
   * every session run writes before it starts.
   */
  async function sessionIdOfRun(runId: string): Promise<string | undefined> {
    const runState = store.getRun(runId);
    const live = runState === undefined ? '' : peers.getRunSessionIdentifier(runState);
    const task = live !== '' ? undefined : await core.tasks.get(runId);
    return live !== '' ? live : task?.contextId;
  }

  /**
   * COR-1936 — the permission mode of the chat `runId` belongs to, read when a tool call is
   * decided: the mode the session's steering holds, caught up from the durable log first (so a
   * mode another process admitted is seen), so a steer is in force for the calls decided after it.
   * `undefined` for a run no session holds, which has no chat to steer. A chat that was never
   * steered is `on-changes`. A read that fails rejects, and the approval hook treats that as
   * `read-only`.
   *
   * COR-1955 — a child run reads the mode of the chat its record is stamped with
   * ({@link BureauChildChat}), the root of its delegation chain, and never of an ancestor: a parent
   * that ended and was retained away has no records left to find a chat by. A child cannot be put
   * to a person, so it is `askable: false`, and the stricter of the chat's mode and the child's own
   * `on-changes`: `allow-all` skips the asks of a chat's person, and a child has none. A child
   * whose chain started in no chat has no mode. A chat deleted since the child started rejects,
   * naming the chat, so the child is held to `read-only` and told why.
   */
  async function permissionModeOfRun(runId: string): Promise<ChatPermissionReading | undefined> {
    const child = await core.childTopologyStore.get(runId);
    if (child === undefined) return await permissionModeOfChatRun(runId);
    if (child.chat === undefined) return undefined;
    const { contextId, incarnation } = child.chat;
    const current = await runtime.sessionStore?.load(contextId);
    if (current?.incarnation !== incarnation) {
      throw new ChatPermissionUnavailableError(
        `the chat "${contextId}" this child run belongs to was deleted, so only read-only calls are allowed.`,
      );
    }
    const mode = await permissionModeOfSession(contextId, incarnation);
    return { mode: mode === 'allow-all' ? 'on-changes' : mode, askable: false };
  }

  /** The mode of the chat `runId` itself belongs to; `undefined` for a run no chat holds. */
  async function permissionModeOfChatRun(runId: string): Promise<PermissionMode | undefined> {
    if (runtime.sessionStore === undefined) return undefined;
    const sessionId = await sessionIdOfRun(runId);
    if (sessionId === undefined) return undefined;
    const incarnation = runSessionIncarnations.get(runId);
    const kv = peers.durableSteeringStore();
    if (incarnation !== undefined && kv !== undefined) {
      // Pinned to the incarnation the run started in: a chat deleted, or deleted and recreated,
      // by another process rejects (the hook counts that as `read-only`) instead of reading
      // the replacement's mode, or none.
      const current = await runtime.sessionStore.load(sessionId);
      if (current?.incarnation !== incarnation) {
        throw new BureauError(
          `Session "${sessionId}" no longer has incarnation "${incarnation}".`,
          'CONFLICT',
        );
      }
    }
    // A run with no incarnation yet (a fresh schedule fire whose session does not exist) has no
    // chat to steer.
    return await permissionModeOfSession(sessionId, incarnation);
  }

  /** The mode a session's steering holds, `on-changes` before any was set. */
  async function permissionModeOfSession(
    sessionId: string,
    incarnation: string | undefined,
  ): Promise<PermissionMode> {
    // Read through the log catch-up, not the gate alone: another process on a shared durable
    // backend may have admitted a mode since this process last polled.
    const kv = peers.durableSteeringStore();
    if (incarnation !== undefined && kv !== undefined) {
      const cursor = await peers.enqueueSteering(sessionId, () =>
        peers.catchUpSteering(kv, sessionId, incarnation),
      );
      return cursor.gate.getDesiredState().permissionMode ?? 'on-changes';
    }
    const steering = await peers.getSessionSteering(sessionId);
    return steering?.permissionMode ?? 'on-changes';
  }

  /**
   * COR-1955 — the chat `parentRunId` runs in, as its children are stamped: its session and the
   * incarnation it started in. `undefined` for a run that belongs to no chat.
   */
  async function chatOfParentRun(parentRunId: string): Promise<BureauChildChat | undefined> {
    if (runtime.sessionStore === undefined) return undefined;
    const contextId = await sessionIdOfRun(parentRunId);
    if (contextId === undefined) return undefined;
    const known = runSessionIncarnations.get(parentRunId);
    const session = known === undefined ? await runtime.sessionStore.load(contextId) : undefined;
    const incarnation = known ?? session?.incarnation;
    return incarnation === undefined ? undefined : { contextId, incarnation };
  }

  /**
   * Derives a {@link ReviewStatus} from a `review.*` audit record's `type`
   * suffix (AB-46). `getReview` uses this to reconstruct a resolved review's
   * status from the chronologically-last matching audit entry. `resolveReview`
   * writes a `review.*.superseded` audit entry from `resumeApproval`'s
   * re-gate branch (AB-224, see `recordReviewStatusTransition` below) — the
   * case is handled explicitly here (rather than falling through to
   * `'denied'`) both for that write and for any externally-produced record.
   */
  function reviewStatusFromAuditType(type: string): ReviewStatus {
    switch (type.split('.').pop()) {
      case 'approved':
        return 'approved';
      case 'rejected':
        return 'rejected';
      case 'expired':
        return 'expired';
      case 'revoked':
        return 'revoked';
      case 'canceled':
        return 'canceled';
      case 'superseded':
        return 'superseded';
      case 'denied':
      default:
        return 'denied';
    }
  }

  /**
   * Writes a `review.<kind>.<status>` audit entry, and dispatches the live
   * `review.*` counterpart (AB-224), for a status transition that is NOT one
   * of `resolveReview`'s decision outcomes (approve/deny/reject) — namely
   * `sweepExpiredReviews`'s `'expired'` transition,
   * `revokePendingApprovalsForRun`'s `'canceled'`/`'revoked'` transitions,
   * and `resolveReview`'s own `resumeApproval` re-gate branch's `'superseded'`
   * transition (AB-46/AB-224). The durable write is a no-op when no audit
   * trail is configured, matching `recordReviewDecision`; the live dispatch
   * always fires regardless. `review` is embedded in `detail.review` with its
   * own `status` field forced to `status` — every caller passes a review
   * whose `status` still reads `'pending'` (it came from a live scan of
   * `listPendingReviews()`), and embedding that stale value verbatim would
   * make `detail.review.status` disagree with both the audit `type` and the
   * top-level `detail.status`, exactly the inconsistency `getReview`'s
   * audit-trail reconstruction and any other audit consumer must not see.
   */
  async function recordReviewStatusTransition(
    review: PendingReview,
    status: Exclude<ReviewStatus, 'pending' | 'approved' | 'denied' | 'rejected'>,
    principal: string,
    // COR-1622: `audit: false` leaves the audit record alone, because it is already there and the
    // history event is what is being written; `dispatch: false` writes no event, because the
    // history already holds it and the audit record is what is being written.
    parts: { readonly audit?: boolean; readonly dispatch?: boolean } = {},
  ): Promise<void> {
    // COR-1622: a close follows the request it closes in the history.
    await core.fireReviewSeeds.pending(review.runId);
    // AB-391: `expired` (`sweepExpiredReviews`), `revoked`/`canceled`
    // (`revokePendingApprovalsForRun`), and `superseded` (`resolveReview`'s
    // re-gate branch) each have no preceding session-store commit this
    // durable write could be coupled to via the outbox — see
    // `recordReviewDecision`'s own doc comment for the transitions that DO.
    // This keeps writing directly, exactly as before.
    // COR-1621: a canceled review round is closed once across instances, so its record carries the
    // key two instances that observe the same cancel of the same round share. Every other status is written as it
    // was. A keyed write rejects on a storage failure where the unkeyed one never does, so that
    // rejection is diagnosed here and the closing goes on, as a failed unkeyed write always did.
    const round = review.kind === 'tool-approval' ? review.round : 0;
    try {
      if (parts.audit !== false)
        await core.auditTrailInstance?.record({
          runId: review.runId,
          type: `review.${review.kind}.${status}`,
          detail: { review: { ...review, status }, status },
          principal,
          ...(status === 'canceled'
            ? { dedupeKey: reviewCanceledDedupeKey(review.id, round) }
            : {}),
        });
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'audit-trail',
        message: `[bureau] Could not record the ${status} closing of review "${review.id}": ${serializeUnknownError(error)}`,
        cause: error,
      });
    }

    // AB-224: live counterpart, same rationale as `recordReviewDecision`
    // above. `approve`/`deny`/`reject` never reach this function — they
    // dispatch from `recordReviewDecision` instead — so the switch below is
    // exhaustive over exactly `expired | revoked | canceled | superseded`.
    if (parts.dispatch !== false) {
      switch (status) {
        case 'expired':
          emitter.dispatch(new ReviewExpiredEvent(review.id, review.runId, principal, review.kind));
          break;
        case 'revoked':
          emitter.dispatch(new ReviewRevokedEvent(review.id, review.runId, principal, review.kind));
          break;
        case 'canceled':
          emitter.dispatch(
            new ReviewCanceledEvent(review.id, review.runId, principal, review.kind, round),
          );
          break;
        case 'superseded':
          emitter.dispatch(
            new ReviewSupersededEvent(review.id, review.runId, principal, review.kind),
          );
          break;
      }
    }
    // COR-1577: a catalog run's review has no session whose ownership could need restoring.
    if (review.sessionId !== undefined) {
      await peers.restoreRunOwnershipAfterEvent(
        review.runId,
        review.sessionId,
        runAttribution.get(review.runId)?.principal,
        runSessionIncarnations.get(review.runId),
      );
    }
  }

  /**
   * The run a review id addresses. Ids are `approval:${runId}:${callId}` /
   * `human-wait:${runId}:${signalName}:${parkOrdinal}` — the run id is always the second
   * colon-delimited segment.
   */
  function reviewRunId(id: string): string | undefined {
    const [, runId] = id.split(':');
    return runId === undefined || runId === '' ? undefined : runId;
  }

  /**
   * COR-1579 — a run's pending human waits, derived from durable state. See the
   * {@link Bureau.pendingHumanWaitsOfRun} doc comment.
   */
  async function pendingHumanWaitsOfRun(runId: string): Promise<PendingHumanWaitReview[]> {
    // COR-2009: a workflow file's instance waiting at a review step.
    const workflowWaits = core.workflowReviewWaits.ofRun(runId);
    if (workflowWaits.length > 0) return workflowWaits;
    if (store.getRun(runId) !== undefined || core.runHumanWaits.holds(runId)) {
      const local: PendingReview[] = [...peers.listPendingReviews(), ...core.runHumanWaits.list()];
      return local.filter(
        (review): review is PendingHumanWaitReview =>
          review.kind === 'human-wait' && review.runId === runId,
      );
    }
    const derived = await core.runHumanWaits.derive(runId);
    return derived === undefined ? [] : [derived];
  }

  /**
   * COR-1579 — the human wait `id` names when this process lists no review under it: the park of
   * a run another process holds, derived by its run id. `undefined` for anything this process
   * already answers for (a listed review, or one whose resolution is still being cleaned up).
   */
  async function derivedHumanWait(id: string): Promise<PendingHumanWaitReview | undefined> {
    if (!id.startsWith('human-wait:') || reviewResolutionCleanupPending.has(id)) return undefined;
    if (
      peers.listPendingReviews().some((review) => review.id === id) ||
      core.runHumanWaits.has(id)
    ) {
      return undefined;
    }
    const runId = reviewRunId(id);
    if (runId === undefined) return undefined;
    const pending = await pendingHumanWaitsOfRun(runId);
    return pending.find((review) => review.id === id);
  }

  /**
   * COR-1804 — returns the input to resolve, or refuses, before any resolver claims the review, an
   * approval of a human wait whose `payload` does not satisfy the schema the wait was parked with (the model's per-call
   * `answerSchema`, else the author's per-signal one). Every answer reaches a human wait through
   * {@link resolveAnyReview}, so this is the one place the answer is judged, whichever path
   * (`bureau.reviews.resolve`, `tasks.respond`, an AG-UI resume) carried it. A wait with no schema
   * takes any answer, and a deny or reject carries none. The refusal changes nothing: the review
   * stays pending. A review this process cannot find is left to the resolver that reports it.
   */
  async function humanWaitAnswerFittingItsSchema(
    input: ResolveReviewInput,
  ): Promise<ResolveReviewInput> {
    if (input.decision !== 'approve') return input;
    // The caller owns `payload`, and this reads the review across awaits: the answer that is
    // checked is a copy taken now, and it is the copy that is delivered when a schema applies.
    let snapshot: unknown = input.payload;
    try {
      snapshot = structuredClone(input.payload);
    } catch {
      // Not cloneable, so not JSON: a schema refuses it below, and a wait without one takes it as given.
    }
    // COR-1920: a review that has closed is read back from the audit trail, which keeps the fields
    // its schema marked secret, so a same-decision retry seals them and digests alike.
    // A tool approval carries no answer, so only a human wait's id is looked up.
    if (!input.id.startsWith('human-wait:')) return input;
    const review = await getReview(input.id);
    // The shared gate (COR-1920): the answer names its review, which this path seals for.
    await gateSecretAnswer({ candidates: [input.id], read: async () => review, seals: true });
    if (review?.kind !== 'human-wait') return input;
    const sealed = await sealHumanWaitAnswer(review, snapshot);
    if (review.inputSchema === undefined) {
      return sealed.sealed === snapshot ? input : { ...input, payload: sealed.sealed };
    }
    const issues = validateReviewAnswer(review.inputSchema, sealed.plaintext);
    if (issues.length > 0) throw new ReviewAnswerInvalidError(issues);
    return snapshot === undefined ? input : { ...input, payload: sealed.sealed };
  }

  /**
   * COR-1920 — the answer to a human wait with each field its question marks secret sealed: the
   * plaintext, to check against the schema, and the sealed answer, to deliver or keep. An answer
   * with no secret field is both. Refused as `NOT_CONFIGURED` (`encryption`) when the Bureau has no
   * key or no storage to keep a secret in, and as a {@link ReviewAnswerInvalidError} when a field
   * holds a sealed answer that is not this question's.
   */
  async function sealHumanWaitAnswer(
    review: PendingHumanWaitReview,
    answer: unknown,
  ): Promise<{ readonly plaintext: unknown; readonly sealed: unknown }> {
    const fields = secretFieldsOfReview(review);
    if (fields.length === 0) return { plaintext: answer, sealed: answer };
    if (runtime.secretAnswers === undefined) {
      throw new BureauError(
        'This question asks for a secret, and the Bureau has no key or storage to keep one in (set "answerEncryption" and "storage").',
        'NOT_CONFIGURED',
        'encryption',
      );
    }
    const outcome = await runtime.secretAnswers.seal({ reviewId: review.id, fields, answer });
    if (!outcome.ok) throw new ReviewAnswerInvalidError(outcome.issues);
    return outcome;
  }

  /**
   * COR-1920 — refuses a human-wait approval whose payload holds a secret field unsealed. Both
   * delivery paths call it before their decision record digests the payload, so nothing of a
   * secret's plaintext is digested, claimed, or signalled. A deny or a reject delivers its own
   * marker, which carries no answer.
   */
  function refuseUnsealedSecrets(
    review: PendingReview,
    payload: unknown,
    decision: ResolveReviewInput['decision'],
  ): void {
    if (
      review.kind === 'human-wait' &&
      decision === 'approve' &&
      unsealedSecretFields(payload, secretFieldsOfReview(review)).length > 0
    ) {
      throw new BureauError(
        `Review "${review.id}" was answered with a secret that was not sealed`,
        'BAD_REQUEST',
      );
    }
  }

  /**
   * COR-1920 — stores the sealed secret answers a human-wait payload carries for the run that
   * asked, and returns the payload to signal, each reduced to its `{ secretRef }`, with what the
   * audit entry says of them. Both delivery paths call it after their decision is claimed and
   * before the signal: the record is written once, so every same-decision re-drive signals the
   * reference to the secret the first claimant stored.
   */
  async function prepareHumanWaitDelivery(
    review: PendingHumanWaitReview,
    payload: unknown,
    principal: string,
    decision: ResolveReviewInput['decision'],
  ): Promise<{ readonly payload: unknown; readonly audit: readonly SecretAnswerAuditEntry[] }> {
    // Checked again here, after the claim: a sealed payload is the only kind this stores.
    refuseUnsealedSecrets(review, payload, decision);
    if (!holdsSealedAnswer(payload)) return { payload, audit: [] };
    if (runtime.secretAnswers === undefined) {
      throw new BureauError(
        'This answer holds a secret, and the Bureau has no key or storage to keep one in.',
        'NOT_CONFIGURED',
        'encryption',
      );
    }
    try {
      return await runtime.secretAnswers.store(
        review,
        payload,
        runAttribution.get(review.runId)?.principal ?? principal,
      );
    } catch (error) {
      if (error instanceof SecretAnswerUnavailableError) {
        throw new BureauError(`Review "${review.id}" holds a secret it cannot store`, 'CONFLICT');
      }
      throw error;
    }
  }

  /**
   * `bureau.resolveReview`: a catalog park this process lists resolves through the engine by run
   * id (COR-1577), a park another process holds is derived first (COR-1579), and every other
   * review resolves through the session path.
   */
  async function resolveAnyReview(requested: ResolveReviewInput): Promise<ResolveReviewResult> {
    // COR-1828: the engine's human waits skip `resolveReview`, so the shape of the decision is refused here.
    peers.assertDecisionFitsInput(requested);
    const input = await humanWaitAnswerFittingItsSchema(requested);
    if (core.runHumanWaits.has(input.id)) {
      peers.assertExpectedReviewRound(input, { id: input.id, kind: 'human-wait' });
      return core.runHumanWaits.resolve(input);
    }
    // COR-2009: a workflow file's review step resolves through the engine by run id, fenced and
    // audited as a run's park is.
    const workflowWait = await workflowReviewOf(input.id);
    if (workflowWait !== undefined) {
      peers.assertExpectedReviewRound(input, workflowWait);
      return resolveWorkflowReview(input, workflowWait);
    }
    const derived = await derivedHumanWait(input.id);
    // COR-1613: a schedule fire's wait goes through the engine by run id, as a catalog run's does,
    // though it names the session the fire runs in; a session run's keeps the session path.
    if (
      derived !== undefined &&
      (derived.sessionId === undefined || core.runHumanWaits.isDerivedFire(derived))
    ) {
      peers.assertExpectedReviewRound(input, derived);
      return core.runHumanWaits.resolve(input, derived);
    }
    return peers.resolveReview(
      input,
      derived?.sessionId === undefined ? undefined : { ...derived, sessionId: derived.sessionId },
    );
  }

  /**
   * COR-2009 — the workflow review `id` names. A review the session index lists, or one of a run
   * this process holds in its run store, is never a workflow's, and is answered without reading the
   * engine: an extra read would let the index hear of a settlement before its own path decides.
   */
  async function workflowReviewOf(id: string): Promise<PendingHumanWaitReview | undefined> {
    const held = core.workflowReviewWaits.find(id);
    if (held !== undefined) return held;
    const runId = reviewRunId(id);
    if (runId === undefined || store.getRun(runId) !== undefined) return undefined;
    if (peers.listPendingReviews().some((review) => review.id === id)) return undefined;
    return core.workflowReviewWaits.lookup(id);
  }

  /**
   * COR-2009 — resolves the review of a workflow file's review step. The decision is claimed,
   * delivered on the step's signal, and audited by `runHumanWaits.resolve`, as a run's park is;
   * once it lands the review leaves the list, and a refusal reads the instance again, since the
   * engine then says the wait is over or the review was decided elsewhere.
   */
  async function resolveWorkflowReview(
    input: ResolveReviewInput,
    review: PendingHumanWaitReview,
  ): Promise<ResolveReviewResult> {
    let result: ResolveReviewResult;
    try {
      result = await core.runHumanWaits.resolve(input, review);
    } catch (error) {
      await core.workflowReviewWaits.refresh(review.runId).catch(() => undefined);
      throw error;
    }
    core.workflowReviewWaits.markResolved(review.id);
    return result;
  }

  /**
   * Look up one review by id, live or resolved (AB-46). See the
   * {@link Bureau.getReview} doc comment.
   */
  async function getReview(
    id: string,
  ): Promise<(PendingReview & ReviewResolutionFields) | undefined> {
    const pending = peers.listPendingReviews().find((candidate) => candidate.id === id);
    if (pending) return pending;
    // COR-1577: the park of a `bureau.run()` run, which no session holds.
    const runWait = core.runHumanWaits.find(id);
    if (runWait) return runWait;
    // COR-2009: a workflow file's instance waiting at a review step.
    const workflowWait = await workflowReviewOf(id);
    if (workflowWait) return workflowWait;
    // COR-1579: the park of a run another process holds.
    const derived = await derivedHumanWait(id);
    if (derived) return derived;
    // COR-1828: the audit trail is where a closed review is read from, with what it was asked. A
    // Bureau with none, or whose trail no longer holds it, reads the review's own record, which
    // says who decided it and when and keeps what was asked and answered.
    const recorded = async (): Promise<(PendingReview & ReviewResolutionFields) | undefined> => {
      const found = await core.resolvedReviewStore.get(id);
      if (found === undefined) return undefined;
      return {
        ...found.review,
        resolvedBy: found.decidedBy,
        resolvedAt: found.decidedAt,
        ...(found.reason === undefined ? {} : { resolutionReason: found.reason }),
        ...(found.answerDigest === undefined ? {} : { answerDigest: found.answerDigest }),
        ...(found.secretRefs === undefined ? {} : { secretRefs: found.secretRefs }),
        ...(found.decisionSurface === undefined ? {} : { decisionSurface: found.decisionSurface }),
      };
    };
    if (!core.auditTrailInstance) return recorded();

    const runId = reviewRunId(id);
    if (!runId) return undefined;

    const records = await core.auditTrailInstance.query({ runId });
    let match: (typeof records)[number] | undefined;
    for (const record of records) {
      if (!record.type.startsWith('review.')) continue;
      const detail = record.detail;
      if (detail === null || typeof detail !== 'object') continue;
      // COR-1934: a deleted chat's entry keeps the review's identity and nothing it asked, so it
      // cannot stand for the review.
      if ((detail as Record<string, unknown>)['redacted'] === true) continue;
      const reviewDetail = (detail as Record<string, unknown>)['review'];
      if (reviewDetail === null || typeof reviewDetail !== 'object') continue;
      if ((reviewDetail as Record<string, unknown>)['id'] !== id) continue;
      // `query()` returns chronological (oldest-first) order — the last
      // match found in iteration order IS the chronologically-last one.
      match = record;
    }
    if (!match) return recorded();

    // A record written before `round` existed has none at runtime, whatever the type says.
    const reviewDetail = (match.detail as Record<string, unknown>)['review'] as PendingReview;
    // A decision says more than a closing does: its note, and what it kept of the answer.
    const decision = resolvedReviewOfAudit(
      { runId, type: match.type, detail: match.detail, principal: match.principal ?? '' },
      match.timestampMs,
    );
    return {
      ...reviewDetail,
      ...(reviewDetail.kind === 'tool-approval' ? { round: reviewDetail.round ?? 0 } : {}),
      status: reviewStatusFromAuditType(match.type),
      // Who decided it, and when, as the audit trail recorded the decision.
      ...(match.principal === undefined ? {} : { resolvedBy: match.principal }),
      resolvedAt: match.timestampMs,
      ...(decision?.reason === undefined ? {} : { resolutionReason: decision.reason }),
      ...(decision?.answerDigest === undefined ? {} : { answerDigest: decision.answerDigest }),
      ...(decision?.secretRefs === undefined ? {} : { secretRefs: decision.secretRefs }),
      ...(decision?.decisionSurface === undefined
        ? {}
        : { decisionSurface: decision.decisionSurface }),
    };
  }

  /**
   * Expiry sweep (AB-46), run by every maintenance pass and by the lazy timer
   * armed while an approval is held: scans every tool-approval review past its
   * binding's `expiresAt` that is not already resolved, transitions each to
   * `status: 'expired'`, writes one `review.tool-approval.expired` audit entry
   * per review attributed to the synthetic principal `'system:expiry'`, and
   * returns the count swept. `human-wait` reviews are never swept — their
   * expiry is Weft's own wait timeout. `now` defaults to the bureau's own clock.
   */
  async function sweepExpiredReviews(now?: number): Promise<number> {
    const effectiveNow = now ?? runtimeServices.clock.now();
    let sweptCount = 0;
    const { runs } = store.getState();

    for (const [runId, runState] of runs) {
      // COR-1302: see `listPendingReviews`.
      if (catalogRunIds.has(runId)) continue;
      const sessionId = peers.getRunSessionIdentifier(runState);
      const agentName = findRunAgentName(runState);
      const stepCompletedTimestamps = runState.actions
        .filter((action) => action.type === 'step.completed')
        .map((action) => action.timestamp);

      for (const [stepIndex, step] of runState.steps.entries()) {
        for (const result of step.results) {
          if (result.outcome !== 'action_required' || !result.pendingApproval) continue;
          const id = `approval:${runId}:${result.pendingApproval.callId}`;
          // A decision in flight owns the review: the next tick expires it if it lets go.
          if (resolvedReviewIds.has(id) || invalidApprovalReviewIds.has(id)) continue;
          if (resolvingReviewIds.has(id)) continue;
          const approval = pendingApprovalOverrides.get(id) ?? result.pendingApproval;
          if (approval.approvalBinding === undefined) continue;
          if (approval.approvalBinding.expiresAt > effectiveNow) continue;

          resolvedReviewIds.add(id);
          sweptCount += 1;
          const requestedAt = stepCompletedTimestamps[stepIndex] ?? effectiveNow;
          const review: PendingReview = {
            kind: 'tool-approval',
            id,
            runId,
            sessionId,
            agentName,
            approval,
            requestedAt,
            ageMilliseconds: effectiveNow - requestedAt,
            status: 'expired',
            round: pendingApprovalRounds.get(id) ?? 0,
          };
          await recordReviewStatusTransition(review, 'expired', EXPIRY_ACTOR);
        }
      }
    }

    // COR-1596: an approval of a run that is not on the store (a schedule fire's, or a session
    // run's the boot restored) is expired by the same rule, and its state ends with it.
    for (const [runId, terminalReview] of terminalReviewSessions) {
      for (const [id, approval] of pendingApprovalOverrides) {
        if (!id.startsWith(`approval:${runId}:`)) continue;
        if (resolvedReviewIds.has(id) || invalidApprovalReviewIds.has(id)) continue;
        if (resolvingReviewIds.has(id)) continue;
        if (approval.approvalBinding === undefined) continue;
        if (approval.approvalBinding.expiresAt > effectiveNow) continue;

        // Read before the drop, which deletes it: the record keeps the round the approval was at.
        const round = pendingApprovalRounds.get(id) ?? 0;
        const requestedAt = approvalRequestedAt.get(id) ?? terminalReview.requestedAt;
        resolvedReviewIds.add(id);
        sweptCount += 1;
        await recordReviewStatusTransition(
          {
            kind: 'tool-approval',
            id,
            runId,
            sessionId: terminalReview.sessionId,
            agentName: terminalReview.agentName,
            approval,
            requestedAt,
            ageMilliseconds: effectiveNow - requestedAt,
            status: 'expired',
            round,
          },
          'expired',
          EXPIRY_ACTOR,
        );
        if (scheduledFireApprovalRuns.has(runId)) {
          await peers.releaseScheduledFireApproval(runId, id, 'expired');
        } else {
          core.dropPendingApprovalOverride(id);
          await peers.prunePersistedInvalidApprovalReviewStateWithRetry(
            terminalReview.sessionId,
            runId,
            id,
          );
        }
      }
      if (
        !Array.from(pendingApprovalOverrides.keys()).some((id) =>
          id.startsWith(`approval:${runId}:`),
        )
      ) {
        terminalReviewSessions.delete(runId);
        peers.releaseTerminalRunReviewState(runId);
      }
    }

    // Whatever this sweep released, the timer is only needed while an approval is still held.
    peers.stopLazyExpirySweepWhenNoneHeld();
    return sweptCount;
  }

  return {
    grantFieldsOf,
    approvedCallAuditOf,
    recordApprovedCall,
    buildReviewDecisionAuditRecord,
    recordResolvedReview,
    ownerForRecord,
    recordResolvedReviewBestEffort,
    recordReviewDecision,
    approvalGrantsOfRun,
    permissionModeOfRun,
    chatOfParentRun,
    recordReviewStatusTransition,
    pendingHumanWaitsOfRun,
    sealHumanWaitAnswer,
    refuseUnsealedSecrets,
    prepareHumanWaitDelivery,
    resolveAnyReview,
    getReview,
    sweepExpiredReviews,
  };
}
