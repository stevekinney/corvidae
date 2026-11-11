/**
 * Fire approval restore (COR-2376 slice S16): closing the reviews of a canceled scheduled fire, reading
 * the approvals a session persisted for a fire, releasing a fire and its approvals, and restoring the
 * pending approvals, their overrides and their peer recoveries at boot, `recoverPeerApproval` included.
 * Built by `constructBureau` and reached only through `createBureau`; the parent, review resolution,
 * approval persistence, run operations, session restore and others call into it.
 */
import {
  AUDIT_PAGE_SIZE,
  type ApprovedCallAudit,
  type CanceledReviewTarget,
  closingStatusOfRound,
  isJsonObject,
  omitKey,
  omitStartedRecord,
  readApprovalResolutionStarted,
  stringValues,
} from '../approval-state-records';
import type { AgentDefinitions } from '../agent-catalog';
import type {
  ApprovalDecisionSurface,
  PendingReview,
  ResolveReviewInput,
  ReviewStatus,
  SessionPendingReview,
} from '../types';
import type { BureauCore, ReviewAuditAttachment, ScheduledFireApprovalEnding } from './core';
import { isScheduledFireAuthority } from '../runtime-composition';
import { type BureauToolbox } from '../runtime-composition-types';
import type { JSONValue, PeerCallJournalEntry } from '@lostgradient/operative';
import { PinnedToolUnavailableError, pinnedToolUnavailable } from '../bureau-errors';
import { ReviewCanceledEvent } from '../events';
import {
  SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS,
  detachBestEffortPromise,
} from '../bureau-construction-support';
import type { SecretAnswerAuditEntry } from '../secret-answers';
import type { SignedPendingToolApproval, ToolExecutionResult } from 'armorer';
import {
  committedFireReviews,
  endContinuingScheduledFire,
  releaseScheduledFireReviews,
  withoutFireApprovals,
} from '../scheduled-fire-review-state';
import { countCheckpointParks } from '../park-ordinals';
import { isTerminalApprovalBindingError } from '../recovered-run-classification';
import { materializeToolResultAsync, resolveToolResult } from 'conversationalist';
import { ownEntry } from '../own-entry';
import { recoveredRequestContextFromMetadata } from '../session-request-context';
import { reviewCanceledDedupeKey } from '../review-closing-events';
import { serializeUnknownError } from '../serialization';

/** The callables fire approval restore reads from elsewhere in `constructBureau`. */
export interface FireApprovalRestorePeers {
  /** Prunes the persisted state of an invalid approval review, retrying the write. */
  readonly prunePersistedInvalidApprovalReviewStateWithRetry: (
    sessionId: string,
    runId: string,
    reviewId: string,
  ) => Promise<void>;
  /** Prunes the persisted resolved review ids under a prefix. */
  readonly prunePersistedResolvedReviewIds: (
    sessionId: string,
    reviewIdPrefix: string,
  ) => Promise<void>;
  /** Reads the approvals a fire committed. */
  readonly readCommittedFireApprovals: (
    runId: string,
    purpose: string,
  ) => Promise<ReadonlySet<string> | undefined>;
  /** Builds the outbox attachment of a review audit. */
  readonly reviewAuditOutboxAttachment: (
    attachment: ReviewAuditAttachment | undefined,
  ) => readonly { namespace: string; payload: JSONValue }[];
  /** Closes the review requests a crashed attempt of a fire abandoned. */
  readonly closeAbandonedFireRequests: (runId: string) => Promise<void>;
  /** Arms the lazy expiry sweep. */
  readonly ensureLazyExpirySweep: () => void;
  /** Reads the review requests and closures a fire recorded in the event history. */
  readonly readFireReviewHistory: (runId: string) => Promise<{
    requested: Set<string>;
    closed: Set<string>;
    open: Map<string, { readonly round: number; readonly canceled: boolean }>;
  }>;
  /** Stops following a fire's reviews once none remains. */
  readonly unfollowFireReviewsWhenNoneRemain: (runId: string) => void;
  /** Builds the audit of an approved call. */
  readonly approvedCallAuditOf: (
    review: Extract<PendingReview, { kind: 'tool-approval' }>,
    approval: { readonly toolName: string; readonly callId: string },
    result: unknown,
  ) => ApprovedCallAudit;
  /** Builds the audit record of a review decision. */
  readonly buildReviewDecisionAuditRecord: (
    review: PendingReview,
    decision: 'approve' | 'deny' | 'reject',
    principal: string,
    reason?: string,
    secretAnswers?: readonly SecretAnswerAuditEntry[],
    answerDigest?: string,
    owner?: string,
    decisionSurface?: ApprovalDecisionSurface,
  ) => ReviewAuditAttachment;
  /** Names the owner a review record carries. */
  readonly ownerForRecord: (runId: string) => Promise<string>;
  /** Records an approved call. */
  readonly recordApprovedCall: (audit: ApprovedCallAudit | undefined) => Promise<void>;
  /** Records a review decision. */
  readonly recordReviewDecision: (
    review: PendingReview,
    decision: 'approve' | 'deny' | 'reject',
    principal: string,
    reason?: string,
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
  ) => Promise<void>;
  /** Records a review status transition. */
  readonly recordReviewStatusTransition: (
    review: PendingReview,
    status: Exclude<ReviewStatus, 'pending' | 'approved' | 'denied' | 'rejected'>,
    principal: string,
    parts?: { readonly audit?: boolean; readonly dispatch?: boolean },
  ) => Promise<void>;
  /** Admits the media of an approved tool result. */
  readonly admitApprovedToolResultMedia: (
    review: Extract<PendingReview, { kind: 'tool-approval' }>,
    executed: ToolExecutionResult,
    materialized: Awaited<ReturnType<typeof materializeToolResultAsync>>,
  ) => Promise<Awaited<ReturnType<typeof materializeToolResultAsync>>>;
  /** Marks a review resolved in this process. */
  readonly markReviewResolvedLocally: (review: SessionPendingReview) => void;
  /** Releases the state a decided review held. */
  readonly releaseDecidedReview: (runId: string, reviewId: string) => Promise<void>;
  /** Revokes the pending approvals of a run. */
  readonly revokePendingApprovalsForRun: (
    runId: string,
    outcome: { status: 'canceled' | 'revoked'; principal: string },
  ) => Promise<void>;
  /** Builds the toolbox a skill policy restores for an approval. */
  readonly skillPolicyToolboxOf: (
    review: Extract<PendingReview, { kind: 'tool-approval' }>,
    registered: BureauToolbox | undefined,
  ) => Promise<BureauToolbox>;
  /** Scans the result of an approved tool call. */
  readonly scanApprovedToolResult: (
    review: Extract<PendingReview, { kind: 'tool-approval' }>,
    executed: ToolExecutionResult,
  ) => Promise<ToolExecutionResult>;
}

/** Builds the fire approval restore of one Bureau. Synchronous, and registers nothing. */
export function createFireApprovalRestore<D extends AgentDefinitions>(
  core: BureauCore<D>,
  peers: FireApprovalRestorePeers,
) {
  const {
    options,
    workspace,
    pluginRegistry,
    runtimeServices,
    emitter,
    runtime,
    diagnose,
    dropPendingApprovalOverride,
    runToolboxesByRunId,
    releaseRunScope,
    resolvedReviewIds,
    pendingApprovalOverrides,
    pendingApprovalRounds,
    interruptedApprovals,
    approvalRequestedAt,
    terminalReviewSessions,
    scheduledFireApprovalRuns,
    invalidApprovalReviewIds,
    runRequestContexts,
    scheduledFireReviewState,
    isTransportIssuedAuthority,
    sessionPersistenceRetryDelayMilliseconds,
    sessionPersistenceSleep,
  } = core;

  /**
   * COR-1596 — whether the engine's own status for a run is that it was canceled. The engine
   * spells it `cancelled` (Weft's `WorkflowStatus`); Bureau's settlement and task states spell it
   * `canceled`. This is the one place the engine's spelling is compared, so a check written
   * against the wrong one cannot pass a test and fail in production.
   */
  function isEngineCancelled(status: string): boolean {
    return status === 'cancelled';
  }

  /**
   * COR-1596 — what the engine says of a fire, the truth for whether it was canceled, as the
   * checkpoint is the truth for which approvals it committed; no bookkeeping order decides either.
   * `ended` is any status but cancelled, terminal or not: those fires' committed approvals are
   * still the operator's to decide. `absent` is a run the engine no longer holds, and
   * `unreadable` one whose status could not be read, which is diagnosed once.
   */
  async function readFireEngineStatus(
    runId: string,
    consequence: string,
  ): Promise<'cancelled' | 'ended' | 'absent' | 'unreadable'> {
    const durable = runtime.durable;
    if (durable === undefined) return 'unreadable';
    try {
      const state = await durable.engine.get(runId);
      if (state === null) return 'absent';
      return isEngineCancelled(state.status) ? 'cancelled' : 'ended';
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'recovery',
        message: `[bureau] Could not read the engine status of schedule fire "${runId}", so ${consequence}: ${serializeUnknownError(error)}`,
        cause: error,
      });
      return 'unreadable';
    }
  }

  /**
   * COR-1613 — the status a review's round was closed with in the audit trail: approved, denied,
   * rejected, expired, revoked or canceled, or `undefined` when no terminal record of the round
   * exists. A re-gated approval keeps its id across rounds and each round it leaves is recorded, so
   * a round's record closes that round alone; `superseded` is not terminal. The whole trail of the
   * run is read, a page at a time. Without an audit trail there is nothing to read.
   */
  async function terminalAuditStatusOf(review: CanceledReviewTarget): Promise<string | undefined> {
    if (core.auditTrailInstance === undefined) return undefined;
    const round = review.kind === 'tool-approval' ? review.round : undefined;
    let after: { timestampMs: number; sequence: number } | undefined;
    for (;;) {
      const page = await core.auditTrailInstance.query({
        runId: review.runId,
        limit: AUDIT_PAGE_SIZE,
        ...(after === undefined ? {} : { after }),
      });
      for (const record of page) {
        const status = closingStatusOfRound(record, review.id, round);
        if (status !== undefined) return status;
      }
      const last = page.at(-1);
      if (last === undefined || page.length < AUDIT_PAGE_SIZE) return undefined;
      after = { timestampMs: last.timestampMs, sequence: last.sequence ?? -1 };
    }
  }

  /**
   * COR-1622 — whether the durable history holds the `review.canceled` of a review's round, by the
   * deduplication key it is written with (COR-1621). The events this process dispatched are written
   * asynchronously, so they are waited for first. A history written before the key existed is not
   * found here, and a Bureau with no history has none to be missing it.
   */
  async function canceledRecordedInHistory(review: CanceledReviewTarget): Promise<boolean> {
    if (core.eventHistoryInstance === undefined) return true;
    const owner = { kind: 'run', id: review.runId } as const;
    await core.durableEventProducerInstance?.waitForActiveWrites(owner);
    return core.eventHistoryInstance.wasRecorded(
      owner,
      'review.canceled',
      reviewCanceledDedupeKey(review.id, review.round),
    );
  }

  /** The canceled closings in flight in this process, by review and round (COR-1613). */
  const closingCanceledReviews = new Map<string, Promise<void>>();

  /**
   * COR-1613 — closes a canceled fire's review, an approval or a human wait, in the audit trail
   * and the durable history, at most once: it writes only when the review has no terminal record
   * yet for its round. A process that died after the engine recorded the cancel and before this
   * write leaves the review open, and the next boot closes it here, so the guarantee holds across
   * sequential restarts (two peers booting at the same moment are out of scope). Within this
   * process the closing is fenced: a second caller for the same review, such as the cancel and
   * the settlement that follows it, waits for the first instead of reading the trail before the
   * first has written.
   */
  function closeCanceledFireReview(
    review: PendingReview,
    principal: string,
    known: { readonly historyHoldsCancel?: boolean } = {},
  ): Promise<void> {
    return closeCanceledReviewTarget(
      {
        id: review.id,
        runId: review.runId,
        kind: review.kind,
        round: review.kind === 'tool-approval' ? review.round : 0,
      },
      principal,
      () => review,
      known,
    );
  }

  /**
   * COR-1622 — closes a canceled review by what finding its records needs, and builds the review
   * (`full`) only when its audit record is to be written. A review that cannot be built is not
   * written from a guess: nothing is written, and the closing fails to be reported and retried at
   * the next boot.
   *
   * The history is already known to hold the review's `review.canceled` when `known` says so (read
   * at boot), so only its audit half is checked, and an event written before the deduplication key
   * existed is not written again.
   */
  function closeCanceledReviewTarget(
    target: CanceledReviewTarget,
    principal: string,
    full: () => PendingReview | undefined,
    known: { readonly historyHoldsCancel?: boolean } = {},
  ): Promise<void> {
    const key = `${target.id}:${target.round}`;
    const inFlight = closingCanceledReviews.get(key);
    if (inFlight !== undefined) return inFlight;
    const closing = (async () => {
      // COR-1622: the audit record and the history event are two writes, and either can be the one
      // that is missing (the history append failed, or the process died between them), so each is
      // checked on its own and only the missing one is written. A round another status closed is
      // left as it was decided.
      const status = await terminalAuditStatusOf(target);
      if (status !== undefined && status !== 'canceled') return;
      const auditMissing = status === undefined;
      const historyHoldsCancel =
        known.historyHoldsCancel === true || (await canceledRecordedInHistory(target));
      if (!auditMissing && historyHoldsCancel) return;
      const review = auditMissing ? full() : undefined;
      if (review !== undefined) {
        await peers.recordReviewStatusTransition(review, 'canceled', principal, {
          audit: true,
          dispatch: !historyHoldsCancel,
        });
        return;
      }
      // Without an audit trail there is no record to build a review for.
      if (auditMissing && core.auditTrailInstance !== undefined) {
        throw new Error(
          `Review "${target.id}" cannot be rebuilt from what the fire committed, so its canceled record is not written`,
        );
      }
      // Only the history event is missing, and it needs no more than the review's identity.
      await core.fireReviewSeeds.pending(target.runId);
      emitter.dispatch(
        new ReviewCanceledEvent(target.id, target.runId, principal, target.kind, target.round),
      );
    })().finally(() => {
      closingCanceledReviews.delete(key);
    });
    closingCanceledReviews.set(key, closing);
    return closing;
  }

  /** COR-1613 — a canceled fire's parked human waits, read before they are forgotten. */
  async function closeCanceledFireHumanWaits(runId: string, principal: string): Promise<void> {
    for (const review of core.runHumanWaits.list()) {
      if (review.runId === runId) await closeCanceledFireReview(review, principal);
    }
  }

  /**
   * COR-1622 — the reviews of a canceled fire that nothing has closed, read at boot, closed once
   * each, whether or not the fire's task is settled (a settlement never waits for a close, so a
   * settled task can still hold an open request). Two sources make the list:
   *
   * - each request the fire's durable history holds that no closing has ended, at the round it
   *   stands at, which is how a close that failed once is retried: the audit record and the
   *   history event are checked on their own, and only the missing one is written;
   * - the human wait the fire's checkpoint ends on, for a wait whose request the history never
   *   got. The checkpoint is read strictly: a malformed latest step could name the wrong park, so
   *   it closes nothing, and a later boot with a readable checkpoint closes the right one.
   *
   * A task of another kind has none. Each review is closed on its own, so one that cannot be
   * leaves the others; the failures are reported, and the next boot tries again.
   */
  async function closeOpenReviewsOfCanceledFire(runId: string): Promise<void> {
    const record = await core.tasks.record(runId);
    const durable = runtime.durable;
    if (record === undefined || record.kind !== 'schedule-fire' || durable === undefined) return;
    const failures: string[] = [];
    // The fire's committed steps, read strictly: they are the only description of a canceled
    // review that is left (its session left with the cancel). A step that cannot be read could
    // name the wrong review, so it describes nothing, and a record that needs it is not written.
    let committed: ReturnType<typeof committedFireReviews> | undefined;
    let outstanding: ReturnType<typeof countCheckpointParks>['outstanding'];
    try {
      const steps = await durable.checkpointStore.loadSteps(runId, { strict: true });
      committed = committedFireReviews(runId, steps);
      outstanding = countCheckpointParks(steps).outstanding;
    } catch (error) {
      failures.push(`its checkpoint could not be read strictly: ${serializeUnknownError(error)}`);
    }
    const base = {
      runId,
      sessionId: record.contextId,
      agentName: record.agentName ?? undefined,
      requestedAt: Date.parse(record.createdAt) || 0,
      ageMilliseconds: 0,
      status: 'pending',
    } as const;
    /** The review the checkpoint committed under `id`, as the live revoke would have built it. */
    const rebuild = (target: CanceledReviewTarget): PendingReview | undefined => {
      const described = committed?.get(target.id);
      if (described === undefined || described.kind !== target.kind) return undefined;
      // The checkpoint holds only the approval its step first raised. A re-gated round's approval
      // lived in the session, which the cancel cleared, so a record built for it here would carry
      // round 0's reason and action under a later round. Such a round is reported, not written.
      if (described.kind === 'tool-approval' && target.round > 0) return undefined;
      return described.kind === 'tool-approval'
        ? {
            ...base,
            kind: 'tool-approval',
            id: target.id,
            approval: described.approval,
            round: target.round,
          }
        : {
            ...base,
            kind: 'human-wait',
            id: target.id,
            signalName: described.signalName,
            prompt: described.prompt,
            ...(described.inputSchema === undefined ? {} : { inputSchema: described.inputSchema }),
          };
    };
    const kindOf = (id: string): CanceledReviewTarget['kind'] =>
      id.startsWith('human-wait:') ? 'human-wait' : 'tool-approval';
    const candidates = new Map<string, CanceledReviewTarget>();
    // The candidates whose history already holds a `review.canceled`: their audit half is what may
    // be missing.
    const canceledInHistory = new Set<string>();
    try {
      const history = await peers.readFireReviewHistory(runId);
      for (const [id, { round, canceled }] of history.open) {
        const kind = kindOf(id);
        candidates.set(id, { id, runId, kind, round: kind === 'human-wait' ? 0 : round });
        if (canceled) canceledInHistory.add(id);
      }
    } catch (error) {
      failures.push(`its history could not be read: ${serializeUnknownError(error)}`);
    }
    if (outstanding !== undefined) {
      const id = `human-wait:${runId}:${outstanding.signalName}:${outstanding.ordinal}`;
      if (!candidates.has(id)) candidates.set(id, { id, runId, kind: 'human-wait', round: 0 });
    }
    for (const target of candidates.values()) {
      try {
        await closeCanceledReviewTarget(target, 'system:run-abort', () => rebuild(target), {
          historyHoldsCancel: canceledInHistory.has(target.id),
        });
      } catch (error) {
        failures.push(`review "${target.id}" could not be closed: ${serializeUnknownError(error)}`);
      }
    }
    if (failures.length > 0) {
      diagnose({
        level: 'error',
        scope: 'recovery',
        message: `[bureau] Not every review of canceled schedule fire "${runId}" was closed, and the next boot tries again: ${failures.join('; ')}`,
      });
    }
  }

  /**
   * COR-1622 — the boot's retry of every canceled fire's open closes: the fires whose task is
   * settled as canceled, whose closes `reconcileTaskRecords` never reaches because it settles only
   * what is unsettled. A fire still unsettled is closed as it is settled.
   */
  async function retryCanceledFireCloses(): Promise<void> {
    for (let offset = 0; ;) {
      const page = await core.tasks.enumerate({ status: 'canceled', limit: 100, offset });
      for (const view of page.tasks) await closeOpenReviewsOfCanceledFire(view.id);
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
  }

  /**
   * COR-1613 — the review a fire's persisted approval stands for, built from the session's own
   * record in the shape the live revoke builds, for the boot that has nothing in memory.
   */
  async function persistedFireApprovalReview(
    runId: string,
    sessionId: string,
    reviewId: string,
  ): Promise<Extract<PendingReview, { kind: 'tool-approval' }> | undefined> {
    const session = await runtime.sessionStore?.load(sessionId);
    const persisted = session?.metadata['pendingApprovalOverrides'];
    const approval = isJsonObject(persisted) ? ownEntry(persisted, reviewId) : undefined;
    if (session === undefined || !isJsonObject(approval)) return undefined;
    const rounds = session.metadata['pendingApprovalRounds'];
    const round = isJsonObject(rounds) ? ownEntry(rounds, reviewId) : undefined;
    return {
      kind: 'tool-approval',
      id: reviewId,
      runId,
      sessionId,
      agentName: session.agentName,
      approval: approval as unknown as Extract<
        PendingReview,
        { kind: 'tool-approval' }
      >['approval'],
      requestedAt: 0,
      ageMilliseconds: 0,
      status: 'pending',
      round: typeof round === 'number' ? round : 0,
    };
  }

  /**
   * The approval a session records as pending for a review, with the round it stands at (the
   * session decides: COR-1596), or `undefined` when it records none.
   */
  function persistedApprovalOf(
    metadata: Record<string, JSONValue> | undefined,
    reviewId: string,
  ):
    | { approval: Extract<PendingReview, { kind: 'tool-approval' }>['approval']; round: number }
    | undefined {
    const persisted = metadata?.['pendingApprovalOverrides'];
    const approval = isJsonObject(persisted) ? ownEntry(persisted, reviewId) : undefined;
    if (!isJsonObject(approval)) return undefined;
    const rounds = metadata?.['pendingApprovalRounds'];
    const round = isJsonObject(rounds) ? ownEntry(rounds, reviewId) : undefined;
    return {
      approval: approval as unknown as Extract<
        PendingReview,
        { kind: 'tool-approval' }
      >['approval'],
      round: typeof round === 'number' && Number.isInteger(round) && round > 0 ? round : 0,
    };
  }

  function persistedPeerRecoveryResult(
    metadata: Record<string, JSONValue> | undefined,
    reviewId: string,
  ): ToolExecutionResult | undefined {
    const results = metadata?.['approvalPeerRecoveryResults'];
    const raw = isJsonObject(results) ? ownEntry(results, reviewId) : undefined;
    if (!isJsonObject(raw)) return undefined;
    if (
      typeof raw['callId'] !== 'string' ||
      typeof raw['toolCallId'] !== 'string' ||
      typeof raw['toolName'] !== 'string' ||
      (raw['outcome'] !== 'success' && raw['outcome'] !== 'error') ||
      !Object.prototype.hasOwnProperty.call(raw, 'content')
    )
      return undefined;
    return raw as unknown as ToolExecutionResult;
  }

  async function persistPeerRecoveryResult(
    sessionId: string,
    reviewId: string,
    result: ToolExecutionResult,
    commitGuard?: () => Promise<boolean>,
  ): Promise<boolean> {
    if (runtime.sessionStore === undefined) return false;
    const committed = await runtime.sessionStore.update(sessionId, async (session) => {
      if (session === undefined) return undefined;
      if (commitGuard !== undefined && !(await commitGuard())) return undefined;
      const results = isJsonObject(session.metadata['approvalPeerRecoveryResults'])
        ? session.metadata['approvalPeerRecoveryResults']
        : {};
      if (ownEntry(results, reviewId) !== undefined) {
        return persistedPeerRecoveryResult(session.metadata, reviewId) === undefined
          ? undefined
          : session;
      }
      return {
        ...session,
        metadata: {
          ...session.metadata,
          approvalPeerRecoveryResults: {
            ...results,
            [reviewId]: JSON.parse(JSON.stringify(result)) as JSONValue,
          },
        },
      };
    });
    return committed !== undefined;
  }

  /**
   * COR-1621 — takes the approval a peer re-gated into this process's own copy of the review: the
   * session holds it at a round beyond the one held here, so this process lists the round the
   * session holds, and its toolbox learns the binding that round was issued under, as a restore
   * teaches it. Does nothing when this process already holds that round or a later one (its own
   * re-gate recorded the event it is now hearing back). Returns whether the copy moved.
   */
  async function adoptPersistedApprovalRound(
    runId: string,
    reviewId: string,
    persisted: {
      approval: Extract<PendingReview, { kind: 'tool-approval' }>['approval'];
      round: number;
    },
  ): Promise<boolean> {
    if (persisted.round <= (pendingApprovalRounds.get(reviewId) ?? 0)) return false;
    const restoreApproval = (
      runToolboxesByRunId.get(runId) as unknown as
        { restoreApproval?: (approval: SignedPendingToolApproval) => Promise<void> } | undefined
    )?.restoreApproval;
    if (restoreApproval !== undefined && persisted.approval.approvalBinding) {
      try {
        await restoreApproval.call(
          runToolboxesByRunId.get(runId),
          persisted.approval as SignedPendingToolApproval,
        );
      } catch (error) {
        if (!isTerminalApprovalBindingError(error)) throw error;
        diagnose({
          level: 'warn',
          scope: 'approval-recovery',
          message:
            `[bureau] The binding of round ${persisted.round} of approval "${reviewId}" could not be ` +
            'restored here, so approving it here will be refused.',
          cause: error,
        });
      }
    }
    // Moved only once the binding is restored: a restore that throws leaves this copy at the
    // round it held, so the next read of the session adopts the round again rather than finding
    // it already held and never restoring the binding.
    pendingApprovalOverrides.set(reviewId, persisted.approval);
    pendingApprovalRounds.set(reviewId, persisted.round);
    return true;
  }

  /**
   * COR-1621 — how long an approval or a wait is given to reach durable state before its absence
   * from it reads as another process having closed it. A review is registered in memory as its
   * step records it, and the session's own record of it can land a moment later, so a read of
   * durable state that finds it missing right then proves nothing.
   */
  const FIRE_REVIEW_PERSISTENCE_GRACE_MILLISECONDS = 30_000;

  /**
   * COR-1621 — the `eventKind` a re-read hands `releaseClosedReview` for a review the durable
   * state says is closed: there is no event, so it is not the name of one. `releaseClosedReview`
   * reads `review.approved` as a possible re-gate and anything else as a closing, and a re-read
   * has already settled which of the two the review is, so it must never match that kind.
   */
  const REREAD_CLOSURE = 'reread';

  /**
   * COR-1621 — reads a fire's reviews held here again from durable state, for the cases where
   * the events that would have said what happened are not to be trusted: the history's retention
   * overtook the subscription, or a reaction to an event failed past its retries. An approval the
   * session records as decided, or no longer records and is older than the grace a record needs
   * to land, is dropped as another process closed it; one the session holds at a later round is
   * refreshed; a human wait the engine no longer parks on is dropped the same way.
   */
  async function rereadFireReviews(runId: string): Promise<number | undefined> {
    const sessionId = terminalReviewSessions.get(runId)?.sessionId;
    const heldIds = Array.from(pendingApprovalOverrides.keys()).filter((id) =>
      id.startsWith(`approval:${runId}:`),
    );
    // One review that cannot be read again must not keep the fire's others from being: each is
    // tried, and the first failure is thrown after them all, so the pass still counts as failed.
    const failures: unknown[] = [];
    // When the youngest review that could not yet be verified has had its grace.
    let retryAt: number | undefined;
    const retryNoEarlierThan = (at: number): void => {
      retryAt = retryAt === undefined ? at : Math.max(retryAt, at);
    };
    if (heldIds.length > 0) {
      const sessions = runtime.sessionStore;
      // Nothing to read the approvals against: they cannot be verified, which is not the same as
      // the session being gone, so the fire stays marked and is tried again.
      if (sessionId === undefined || sessions === undefined) {
        throw new Error(
          `The approvals held of schedule fire "${runId}" cannot be verified against its session: ${
            sessions === undefined ? 'there is no session store' : 'no session is recorded for it'
          }`,
        );
      }
      const session = await sessions.load(sessionId);
      if (session === undefined) {
        // The session is gone (deleted by a peer): so are the approvals it held.
        for (const id of heldIds) {
          try {
            await core.tasks.reviewClosedElsewhere(runId, id, REREAD_CLOSURE);
          } catch (error) {
            failures.push(error);
          }
        }
      } else {
        const decided = Array.isArray(session.metadata['resolvedReviewIds'])
          ? new Set(stringValues(session.metadata['resolvedReviewIds']))
          : new Set<string>();
        for (const id of heldIds) {
          try {
            const persisted = persistedApprovalOf(session.metadata, id);
            if (persisted !== undefined && !decided.has(id)) {
              await adoptPersistedApprovalRound(runId, id, persisted);
              continue;
            }
            const requestedAt = approvalRequestedAt.get(id) ?? 0;
            if (
              decided.has(id) ||
              runtimeServices.clock.now() - requestedAt >=
                FIRE_REVIEW_PERSISTENCE_GRACE_MILLISECONDS
            ) {
              await core.tasks.reviewClosedElsewhere(runId, id, REREAD_CLOSURE);
            } else {
              // Not yet in the session, and young enough that it may not have landed: it is read
              // again when its grace ends, not counted as verified.
              retryNoEarlierThan(requestedAt + FIRE_REVIEW_PERSISTENCE_GRACE_MILLISECONDS);
            }
          } catch (error) {
            failures.push(error);
          }
        }
      }
    }
    try {
      const wait = await core.runHumanWaits.rereadClosed(
        runId,
        FIRE_REVIEW_PERSISTENCE_GRACE_MILLISECONDS,
      );
      if (wait.closed !== undefined) {
        await core.tasks.reviewClosedElsewhere(runId, wait.closed, REREAD_CLOSURE);
      }
      if (wait.retryAt !== undefined) retryNoEarlierThan(wait.retryAt);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) throw failures[0];
    return retryAt;
  }

  /** Whether this process still holds an approval of the fire: one that is expired counts. */
  function holdsFireApproval(runId: string): boolean {
    for (const id of pendingApprovalOverrides.keys()) {
      if (id.startsWith(`approval:${runId}:`)) return true;
    }
    return false;
  }

  /**
   * COR-1596 — takes the fire's approvals that `drop` names out of its session, durably, through
   * the one function that knows every key an approval is recorded under
   * (`withoutFireApprovals`). Retried like every post-decision session write.
   */
  async function pruneFireApprovalsFromSession(
    sessionId: string,
    runId: string,
    drop: (reviewId: string) => boolean,
  ): Promise<void> {
    const sessionStore = runtime.sessionStore;
    if (sessionStore === undefined) return;
    let lastError: unknown;
    for (let attempt = 1; attempt <= SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS; attempt += 1) {
      try {
        await sessionStore.update(sessionId, (session) => {
          if (session === undefined) return undefined;
          const patch = withoutFireApprovals(session.metadata, runId, drop);
          return patch === undefined
            ? undefined
            : { ...session, metadata: { ...session.metadata, ...patch } };
        });
        return;
      } catch (error) {
        lastError = error;
        if (attempt < SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS) {
          await sessionPersistenceSleep(sessionPersistenceRetryDelayMilliseconds);
        }
      }
    }
    throw lastError;
  }

  /**
   * COR-1596 — the in-memory end of a fire's approval state, once it holds no approval: its
   * request context and toolbox (which keeps the fire's services alive), its entries in the maps,
   * and whoever follows its task is told. An approval that expired but was not yet swept still
   * counts as held, so a sibling's decision cannot strand it unswept. Synchronous, for the
   * resolution paths that cannot wait.
   */
  function endScheduledFireWhenNoApprovalRemains(runId: string): void {
    if (!scheduledFireApprovalRuns.has(runId) || holdsFireApproval(runId)) return;
    runRequestContexts.delete(runId);
    runToolboxesByRunId.delete(runId);
    releaseRunScope(runId);
    if (releaseScheduledFireReviews(scheduledFireReviewState, runId)) {
      detachBestEffortPromise(core.tasks.announceChanged(runId));
    }
    peers.unfollowFireReviewsWhenNoneRemain(runId);
  }

  /**
   * COR-1596 — ends one approval of a fire, in both homes. `durablyPruned` is set by a decision,
   * whose own session write already took the approval out in the same commit as the decision's
   * fence.
   */
  async function releaseScheduledFireApproval(
    runId: string,
    reviewId: string,
    ending: ScheduledFireApprovalEnding,
    scope: { sessionId?: string | undefined; durablyPruned?: boolean } = {},
  ): Promise<void> {
    const sessionId = scope.sessionId ?? terminalReviewSessions.get(runId)?.sessionId;
    const heldHere = pendingApprovalOverrides.has(reviewId) || scheduledFireApprovalRuns.has(runId);
    // Hidden from the list first, so the approval is not offered while the prune is in flight or
    // after it fails.
    if (ending === 'invalid') invalidApprovalReviewIds.add(reviewId);
    else if (ending !== 'abandoned' && heldHere) resolvedReviewIds.add(reviewId);
    // The in-memory override is dropped, and the fire ended, only once the session prune has
    // committed. A prune that fails leaves the override in memory and in the session, and the
    // fire's next release finds it through `fireApprovalIds` and retries (COR-1613).
    if (scope.durablyPruned !== true && sessionId !== undefined) {
      await pruneFireApprovalsFromSession(sessionId, runId, (id) => id === reviewId);
    }
    dropPendingApprovalOverride(reviewId);
    endScheduledFireWhenNoApprovalRemains(runId);
  }

  /** The review ids of a fire's approvals this process holds or its session records. */
  async function fireApprovalIds(runId: string, sessionId: string | undefined): Promise<string[]> {
    const prefix = `approval:${runId}:`;
    const ids = new Set(
      Array.from(pendingApprovalOverrides.keys()).filter((id) => id.startsWith(prefix)),
    );
    const session =
      sessionId === undefined ? undefined : await runtime.sessionStore?.load(sessionId);
    const persisted = session?.metadata['pendingApprovalOverrides'];
    if (isJsonObject(persisted)) {
      for (const id of Object.keys(persisted)) if (id.startsWith(prefix)) ids.add(id);
    }
    return Array.from(ids);
  }

  /**
   * COR-1596 — how a fire ends, and what it owes its approvals then. `settled` reconciles the
   * session with the checkpoint, the only source of truth for which approvals exist: each one the
   * run never committed ends as abandoned. `canceled` ends every approval, bindings revoked, so
   * none can be restored to run a tool for a run that was canceled. `removed` (the fire's task
   * left retention) ends whatever is left and retires the decision fence, which the task was the
   * last thing to name. Each ends through {@link releaseScheduledFireApproval}.
   */
  async function releaseScheduledFire(
    runId: string,
    ending: 'settled' | 'canceled' | 'removed',
    scope: { sessionId?: string | undefined } = {},
  ): Promise<void> {
    const recorded = scope.sessionId === undefined ? await core.tasks.record(runId) : undefined;
    const sessionId =
      scope.sessionId ?? terminalReviewSessions.get(runId)?.sessionId ?? recorded?.contextId;
    if (ending === 'canceled') {
      await peers.revokePendingApprovalsForRun(runId, {
        status: 'canceled',
        principal: 'system:run-abort',
      });
    }
    // COR-1613: a request an attempt that never committed announced is closed.
    try {
      await peers.closeAbandonedFireRequests(runId);
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'durable-event-history',
        message: `[bureau] Could not close the abandoned review requests of schedule fire "${runId}": ${serializeUnknownError(error)}`,
        cause: error,
      });
    }
    if (ending === 'settled') {
      const committed = await peers.readCommittedFireApprovals(
        runId,
        'its session is not reconciled with it',
      );
      if (committed === undefined) return;
      for (const id of await fireApprovalIds(runId, sessionId)) {
        if (!committed.has(id)) {
          await releaseScheduledFireApproval(runId, id, 'abandoned', { sessionId });
        }
      }
      return;
    }
    // Canceled or removed: the fire takes no further step, and nothing of its approvals stays,
    // whatever revoked it first.
    endContinuingScheduledFire(scheduledFireReviewState, runId);
    for (const id of await fireApprovalIds(runId, sessionId)) {
      // COR-1613: an approval only the session still records (a boot found it) is closed before
      // it is released, so its request does not stay open in the history.
      if (ending === 'canceled' && sessionId !== undefined && !resolvedReviewIds.has(id)) {
        const review = await persistedFireApprovalReview(runId, sessionId, id);
        if (review !== undefined) await closeCanceledFireReview(review, 'system:run-abort');
      }
      await releaseScheduledFireApproval(
        runId,
        id,
        ending === 'canceled' ? 'canceled' : 'removed',
        {
          sessionId,
        },
      );
    }
    if (ending === 'removed' && sessionId !== undefined) {
      await peers.prunePersistedResolvedReviewIds(sessionId, `approval:${runId}:`);
      await peers.prunePersistedResolvedReviewIds(sessionId, `human-wait:${runId}:`);
    }
    endScheduledFireWhenNoApprovalRemains(runId);
  }

  /**
   * COR-1596 — which of a fire's persisted approvals a boot may restore, by the two truths: the
   * engine's status says whether the fire was canceled, and the checkpoint says which approvals
   * it committed. `'not-a-fire'` leaves a session run's approvals to the restore they always had;
   * `'none'` restores nothing, having released a canceled fire's approvals or, when the status
   * or the checkpoint cannot be read, having left them for the next boot; otherwise the committed
   * ids.
   */
  async function restorableBootApprovals(
    metadata: Record<string, JSONValue>,
    runId: string,
    sessionId: string,
  ): Promise<'not-a-fire' | 'none' | ReadonlySet<string>> {
    if (!isScheduledFireAuthority(metadata, runId)) return 'not-a-fire';
    const engineStatus = await readFireEngineStatus(
      runId,
      'its tool approvals are not restored this boot',
    );
    if (engineStatus === 'cancelled') {
      // The prune lands through the session's own record of the fire's approvals; none was ever
      // restored here, so there is no binding to revoke. The process that took the cancel may
      // have died before it wrote the review's `canceled` record, so the release closes each
      // approval it finds, once, from the session's own record of it (COR-1613).
      await releaseScheduledFire(runId, 'canceled', { sessionId });
      return 'none';
    }
    if (engineStatus === 'absent' || engineStatus === 'unreadable') return 'none';
    return (
      (await peers.readCommittedFireApprovals(
        runId,
        'its tool approvals are not restored this boot',
      )) ?? 'none'
    );
  }

  function restorePendingApprovalOverrides(
    metadata: unknown,
    runId: string,
    committed?: ReadonlySet<string>,
  ): void {
    const metadataRecord =
      metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>)
        : undefined;
    const overrides = metadataRecord?.['pendingApprovalOverrides'];
    const resolutionStarted = readApprovalResolutionStarted(
      metadataRecord?.['approvalResolutionStartedIds'] as JSONValue | undefined,
    );
    if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) return;
    // A review the session records as decided is not pending, whatever override it still holds.
    const decidedReviewIds = new Set(
      Array.isArray(metadataRecord?.['resolvedReviewIds'])
        ? stringValues(metadataRecord['resolvedReviewIds'])
        : [],
    );
    const rounds = metadataRecord?.['pendingApprovalRounds'];
    for (const [reviewId, approval] of Object.entries(overrides as Record<string, unknown>)) {
      if (!reviewId.startsWith(`approval:${runId}:`)) continue;
      if (invalidApprovalReviewIds.has(reviewId)) continue;
      if (decidedReviewIds.has(reviewId)) continue;
      if (committed !== undefined && !committed.has(reviewId)) continue;
      if (approval && typeof approval === 'object' && !Array.isArray(approval)) {
        // COR-1717: a started-but-uncommitted approval is listed again, marked interrupted. The
        // tool is never re-run here; resolving it runs the normal approval path once.
        const started = resolutionStarted.find((record) => record.id === reviewId);
        if (started !== undefined) interruptedApprovals.set(reviewId, started.startedAt);
        pendingApprovalOverrides.set(
          reviewId,
          approval as Extract<PendingReview, { kind: 'tool-approval' }>['approval'],
        );
        const round =
          typeof rounds === 'object' && rounds !== null && !Array.isArray(rounds)
            ? ownEntry(rounds as Record<string, unknown>, reviewId)
            : undefined;
        if (typeof round === 'number' && Number.isInteger(round) && round > 0) {
          pendingApprovalRounds.set(reviewId, round);
        }
      }
    }
    // COR-1622: a restored approval is held, and expires, like one raised here.
    if (pendingApprovalOverrides.size > 0) peers.ensureLazyExpirySweep();
  }

  const peerRecoveryRetryKeys = new Set<string>();

  /** COR-2051 — attach to a journaled peer task after an approved resolution lost its caller. */
  async function recoverPeerApproval(
    sessionId: string,
    runId: string,
    initialMetadata: Record<string, JSONValue>,
  ): Promise<void> {
    const leaseTtlMilliseconds = 30_000;
    const started = readApprovalResolutionStarted(initialMetadata['approvalResolutionStartedIds']);
    for (const marker of started) {
      let journalEntry: PeerCallJournalEntry | undefined;
      try {
        const recovery = marker.peerRecovery;
        if (recovery === undefined || recovery.request.reviewId !== marker.id) continue;
        const session = await runtime.sessionStore?.load(sessionId);
        const currentMetadata = session?.metadata;
        const currentMarker = readApprovalResolutionStarted(
          currentMetadata?.['approvalResolutionStartedIds'],
        ).find((candidate) => candidate.id === marker.id);
        if (
          currentMarker?.peerRecovery === undefined ||
          currentMarker.peerRecovery.request.reviewId !== marker.id
        )
          continue;
        const currentRecovery = currentMarker.peerRecovery;
        const persisted = persistedApprovalOf(currentMetadata, marker.id);
        if (persisted === undefined || persisted.approval.callId === undefined) continue;
        if (
          persisted.round !== currentRecovery.request.round ||
          persisted.approval.approvalBinding?.toolDefinitionRevision !==
            currentRecovery.toolDefinitionRevision ||
          persisted.approval.approvalToken === undefined
        )
          continue;
        const adapter = options.recoverableStartedApprovals?.get(
          currentRecovery.toolDefinitionRevision,
        );
        if (adapter === undefined || adapter.version !== 1) continue;
        const restoreApproval = (
          runToolboxesByRunId.get(runId) as unknown as {
            restoreApproval?: (approval: SignedPendingToolApproval) => Promise<void>;
          }
        )?.restoreApproval;
        if (restoreApproval === undefined) continue;
        try {
          await restoreApproval(persisted.approval as SignedPendingToolApproval);
        } catch (error) {
          // A consumed binding is the expected post-attach state. Every other binding failure
          // (bad signature, expiry, revocation, or a missing state record) fails closed.
          if ((error as { code?: unknown })?.code !== 'already-consumed') continue;
        }
        const decision = await core.reviewDecisions.inspect(currentRecovery.request);
        if (decision.outcome !== 'matching' || decision.recorded) continue;
        const authority = runRequestContexts.get(runId);
        if (
          authority !== undefined &&
          isTransportIssuedAuthority(authority) &&
          (core.requestAuthorityValidator === undefined ||
            !(await core.requestAuthorityValidator(authority)))
        )
          continue;
        const review: Extract<PendingReview, { kind: 'tool-approval' }> = {
          kind: 'tool-approval',
          id: marker.id,
          runId,
          sessionId,
          agentName: terminalReviewSessions.get(runId)?.agentName,
          approval: persisted.approval,
          requestedAt: 0,
          ageMilliseconds: 0,
          status: 'pending',
          round: persisted.round,
        };
        const policyToolbox = await peers.skillPolicyToolboxOf(
          review,
          runToolboxesByRunId.get(runId),
        );
        if (
          !policyToolbox.tools().some((tool) => tool.id === currentRecovery.toolDefinitionRevision)
        )
          continue;
        journalEntry = await core.peerCalls.read({
          parentRunId: runId,
          operationKey: currentRecovery.durableOperationKey,
        });
        if (
          journalEntry === undefined ||
          typeof journalEntry.taskId !== 'string' ||
          journalEntry.taskId.length === 0 ||
          typeof journalEntry.contextId !== 'string' ||
          journalEntry.contextId.length === 0 ||
          !/^[0-9a-f]{64}$/.test(journalEntry.requestDigest)
        )
          continue;

        const token = runtimeServices.identifiers.next('approval-recovery');
        const leaseOf = (
          leaseMetadata: Record<string, JSONValue>,
        ): Record<string, JSONValue> | undefined => {
          const leases = leaseMetadata['approvalPeerRecoveryLeases'];
          const lease = isJsonObject(leases) ? ownEntry(leases, marker.id) : undefined;
          return isJsonObject(lease) ? lease : undefined;
        };
        const leaseValue = (): Record<string, JSONValue> => ({
          token,
          round: persisted.round,
          expiresAt: runtimeServices.clock.now() + leaseTtlMilliseconds,
          operationKey: currentRecovery.durableOperationKey,
        });
        const acquireLease = async (): Promise<boolean> => {
          const committed = await runtime.sessionStore?.update(sessionId, (leaseSession) => {
            if (leaseSession === undefined) return undefined;
            const current = leaseOf(leaseSession.metadata);
            if (
              current !== undefined &&
              typeof current['expiresAt'] === 'number' &&
              current['expiresAt'] > runtimeServices.clock.now()
            )
              return undefined;
            const leases = isJsonObject(leaseSession.metadata['approvalPeerRecoveryLeases'])
              ? leaseSession.metadata['approvalPeerRecoveryLeases']
              : {};
            return {
              ...leaseSession,
              metadata: {
                ...leaseSession.metadata,
                approvalPeerRecoveryLeases: { ...leases, [marker.id]: leaseValue() },
              },
            };
          });
          return committed !== undefined;
        };
        const ownsLease = async (): Promise<boolean> => {
          const leaseSession = await runtime.sessionStore?.load(sessionId);
          const lease = leaseSession === undefined ? undefined : leaseOf(leaseSession.metadata);
          return (
            lease?.['token'] === token &&
            lease['round'] === persisted.round &&
            lease['operationKey'] === currentRecovery.durableOperationKey &&
            typeof lease['expiresAt'] === 'number' &&
            lease['expiresAt'] > runtimeServices.clock.now()
          );
        };
        const recoveryStateCurrent = async (): Promise<boolean> => {
          if (!(await ownsLease())) return false;
          const freshSession = await runtime.sessionStore?.load(sessionId);
          const freshMarker = readApprovalResolutionStarted(
            freshSession?.metadata['approvalResolutionStartedIds'],
          ).find((candidate) => candidate.id === marker.id);
          if (
            freshMarker?.peerRecovery === undefined ||
            freshMarker.peerRecovery.request.reviewId !== marker.id ||
            freshMarker.peerRecovery.durableOperationKey !== currentRecovery.durableOperationKey
          )
            return false;
          const freshApproval = persistedApprovalOf(freshSession?.metadata, marker.id);
          if (freshApproval === undefined || freshApproval.round !== currentRecovery.request.round)
            return false;
          const freshDecision = await core.reviewDecisions.inspect(currentRecovery.request);
          return freshDecision.outcome === 'matching' && !freshDecision.recorded;
        };
        const recoveryAuthorityCurrent = async (): Promise<boolean> => {
          const freshSession = await runtime.sessionStore?.load(sessionId);
          if (freshSession === undefined) return false;
          const context = recoveredRequestContextFromMetadata(
            freshSession.metadata,
            runId,
            sessionId,
            freshSession.agentName,
            runtimeServices.clock.now,
          );
          if (context === undefined) return workspace === undefined;
          if (!isTransportIssuedAuthority(context)) return true;
          return (
            core.requestAuthorityValidator !== undefined &&
            (await core.requestAuthorityValidator(context))
          );
        };
        if (!(await acquireLease())) {
          const retryKey = `${sessionId}:${marker.id}:${String(persisted.round)}`;
          if (!peerRecoveryRetryKeys.has(retryKey)) {
            peerRecoveryRetryKeys.add(retryKey);
            runtimeServices.timers.setTimeout(() => {
              peerRecoveryRetryKeys.delete(retryKey);
              void (async () => {
                const retrySession = await runtime.sessionStore?.load(sessionId);
                if (retrySession !== undefined) {
                  await recoverPeerApproval(sessionId, runId, retrySession.metadata);
                }
              })().catch((error: unknown) => {
                diagnose({
                  level: 'warn',
                  scope: 'approval-recovery',
                  message: `[bureau] Peer approval recovery retry failed for "${marker.id}".`,
                  cause: error,
                });
              });
            }, leaseTtlMilliseconds + 1);
          }
          continue;
        }
        const controller = new AbortController();
        const renewal = runtimeServices.timers.setInterval(
          () => {
            void (async () => {
              const renewed = await runtime.sessionStore?.update(sessionId, (renewalSession) => {
                if (renewalSession === undefined) return undefined;
                const current = leaseOf(renewalSession.metadata);
                if (current?.['token'] !== token) return undefined;
                const leases = isJsonObject(renewalSession.metadata['approvalPeerRecoveryLeases'])
                  ? renewalSession.metadata['approvalPeerRecoveryLeases']
                  : {};
                return {
                  ...renewalSession,
                  metadata: {
                    ...renewalSession.metadata,
                    approvalPeerRecoveryLeases: { ...leases, [marker.id]: leaseValue() },
                  },
                };
              });
              if (renewed === undefined) controller.abort();
            })().catch((error: unknown) => {
              controller.abort();
              diagnose({
                level: 'warn',
                scope: 'approval-recovery',
                message: `[bureau] Peer approval recovery lease renewal failed for "${marker.id}"; attachment aborted.`,
                cause: error,
              });
            });
          },
          Math.max(1, Math.floor(leaseTtlMilliseconds / 3)),
        );
        try {
          if (!(await recoveryStateCurrent())) continue;
          const freshSession = await runtime.sessionStore?.load(sessionId);
          const freshApproval = persistedApprovalOf(freshSession?.metadata, marker.id);
          if (freshApproval === undefined) continue;
          let result = persistedPeerRecoveryResult(freshSession?.metadata, marker.id);
          if (result === undefined) {
            // The authority may be revoked during the lease/state reads above. Revalidate at the
            // last possible point before invoking the external attachment adapter.
            if (!(await recoveryAuthorityCurrent())) continue;
            result = await adapter.attach({
              sessionId,
              runId,
              reviewId: marker.id,
              callId: freshApproval.approval.callId,
              toolDefinitionRevision: currentRecovery.toolDefinitionRevision,
              durableOperationKey: currentRecovery.durableOperationKey,
              arguments: currentRecovery.arguments,
              journalEntry,
              signal: controller.signal,
            });
          }
          if (!(await recoveryStateCurrent())) continue;
          if (
            result === undefined ||
            result === null ||
            typeof result !== 'object' ||
            result.callId !== freshApproval.approval.callId ||
            result.toolCallId !== freshApproval.approval.callId ||
            result.toolName !== freshApproval.approval.toolName ||
            !Object.prototype.hasOwnProperty.call(result, 'content') ||
            (result.outcome !== 'success' && result.outcome !== 'error')
          )
            continue;
          const resultCheckpointed =
            persistedPeerRecoveryResult(freshSession?.metadata, marker.id) !== undefined ||
            (await persistPeerRecoveryResult(sessionId, marker.id, result, recoveryStateCurrent));
          if (!resultCheckpointed || !(await recoveryStateCurrent())) continue;
          const input: ResolveReviewInput = {
            id: marker.id,
            decision: 'approve',
            principal: currentRecovery.request.principal,
            round: currentRecovery.request.round,
            arguments: currentRecovery.arguments,
            ...(currentRecovery.request.reason === undefined
              ? {}
              : { reason: currentRecovery.request.reason }),
          };
          // COR-2299: scanned as the other approved-call write is, before the row is committed.
          const scannedResult = await peers.scanApprovedToolResult(review, result);
          const materialized = await materializeToolResultAsync(scannedResult);
          const admitted = await peers.admitApprovedToolResultMedia(
            review,
            scannedResult,
            materialized,
          );
          const auditAttachment = peers.buildReviewDecisionAuditRecord(
            review,
            'approve',
            input.principal,
            input.reason,
            [],
            currentRecovery.request.digest,
            await peers.ownerForRecord(runId),
          );
          const committed = await runtime.sessionStore?.update(
            sessionId,
            async (finalSession) => {
              if (finalSession === undefined) return undefined;
              const lease = leaseOf(finalSession.metadata);
              if (
                lease?.['token'] !== token ||
                lease['round'] !== persisted.round ||
                lease['operationKey'] !== currentRecovery.durableOperationKey ||
                typeof lease['expiresAt'] !== 'number' ||
                lease['expiresAt'] <= runtimeServices.clock.now()
              )
                return undefined;
              const finalMarker = readApprovalResolutionStarted(
                finalSession.metadata['approvalResolutionStartedIds'],
              ).find((candidate) => candidate.id === marker.id);
              const currentApproval = persistedApprovalOf(finalSession.metadata, marker.id);
              if (
                finalMarker?.peerRecovery === undefined ||
                finalMarker.peerRecovery.durableOperationKey !==
                  currentRecovery.durableOperationKey ||
                currentApproval === undefined ||
                currentApproval.round !== persisted.round
              )
                return undefined;
              const finalDecision = await core.reviewDecisions.inspect(currentRecovery.request);
              if (finalDecision.outcome !== 'matching' || finalDecision.recorded) return undefined;
              const recoveredContext = recoveredRequestContextFromMetadata(
                finalSession.metadata,
                runId,
                sessionId,
                finalSession.agentName,
                runtimeServices.clock.now,
              );
              if (recoveredContext === undefined) return undefined;
              if (
                isTransportIssuedAuthority(recoveredContext) &&
                (core.requestAuthorityValidator === undefined ||
                  !(await core.requestAuthorityValidator(recoveredContext)))
              )
                return undefined;
              const leases = isJsonObject(finalSession.metadata['approvalPeerRecoveryLeases'])
                ? finalSession.metadata['approvalPeerRecoveryLeases']
                : {};
              const results = isJsonObject(finalSession.metadata['approvalPeerRecoveryResults'])
                ? finalSession.metadata['approvalPeerRecoveryResults']
                : {};
              const pending = isJsonObject(finalSession.metadata['pendingApprovalOverrides'])
                ? finalSession.metadata['pendingApprovalOverrides']
                : {};
              const rounds = isJsonObject(finalSession.metadata['pendingApprovalRounds'])
                ? finalSession.metadata['pendingApprovalRounds']
                : {};
              const resolved = Array.isArray(finalSession.metadata['resolvedReviewIds'])
                ? stringValues(finalSession.metadata['resolvedReviewIds'])
                : [];
              const priorDecisions = isJsonObject(finalSession.metadata['resolvedReviewDecisions'])
                ? finalSession.metadata['resolvedReviewDecisions']
                : {};
              return {
                ...finalSession,
                conversationHistory: resolveToolResult(
                  finalSession.conversationHistory,
                  currentApproval.approval.callId,
                  admitted,
                ),
                metadata: {
                  ...finalSession.metadata,
                  approvalResolutionStartedIds: omitStartedRecord(
                    finalSession.metadata['approvalResolutionStartedIds'],
                    marker.id,
                  ),
                  pendingApprovalOverrides: omitKey(pending, marker.id),
                  pendingApprovalRounds: omitKey(rounds, marker.id),
                  approvalPeerRecoveryResults: omitKey(results, marker.id),
                  approvalPeerRecoveryLeases: omitKey(leases, marker.id),
                  resolvedReviewIds: [...new Set([...resolved, marker.id])],
                  resolvedReviewDecisions: {
                    ...priorDecisions,
                    [marker.id]: {
                      decision: 'approve',
                      principal: input.principal,
                      ...(input.reason === undefined ? {} : { reason: input.reason }),
                    },
                  },
                },
              };
            },
            {
              outbox: peers.reviewAuditOutboxAttachment({
                ...auditAttachment,
                decisionRequest: currentRecovery.request,
                detail: {
                  ...(auditAttachment.detail as Record<string, unknown>),
                  decisionRequest: currentRecovery.request,
                },
              }),
            },
          );
          if (committed === undefined) continue;
          peers.markReviewResolvedLocally(review);
          await peers.releaseDecidedReview(runId, marker.id);
          await peers.recordReviewDecision(review, 'approve', input.principal, input.reason, {
            auditAlreadyAppended: true,
            answerDigest: currentRecovery.request.digest,
          });
          await peers.recordApprovedCall(
            peers.approvedCallAuditOf(review, persisted.approval, result),
          );
        } finally {
          runtimeServices.timers.clearInterval(renewal);
          await runtime.sessionStore?.update(sessionId, (cleanupSession) => {
            if (cleanupSession === undefined) return undefined;
            const current = leaseOf(cleanupSession.metadata);
            if (current?.['token'] !== token) return undefined;
            const leases = isJsonObject(cleanupSession.metadata['approvalPeerRecoveryLeases'])
              ? cleanupSession.metadata['approvalPeerRecoveryLeases']
              : {};
            return {
              ...cleanupSession,
              metadata: {
                ...cleanupSession.metadata,
                approvalPeerRecoveryLeases: omitKey(leases, marker.id),
              },
            };
          });
        }
      } catch (error) {
        diagnose({
          level: 'warn',
          scope: 'approval-recovery',
          message: `[bureau] Peer approval recovery for "${marker.id}" did not complete; leaving it interrupted.`,
          cause: error,
        });
      }
    }
  }

  function persistedApprovalRunIds(metadata: unknown): Set<string> {
    const metadataRecord =
      metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>)
        : undefined;
    const runIds = new Set<string>();
    const lastRunId = metadataRecord?.['lastRunId'];
    if (typeof lastRunId === 'string') runIds.add(lastRunId);
    const pending = metadataRecord?.['pendingApprovalOverrides'];
    const authorities = metadataRecord?.['lastRequestAuthorities'];
    if (
      pending &&
      typeof pending === 'object' &&
      !Array.isArray(pending) &&
      authorities &&
      typeof authorities === 'object' &&
      !Array.isArray(authorities)
    ) {
      for (const authorityRunId of Object.keys(authorities)) {
        if (
          Object.keys(pending).some((reviewId) =>
            reviewId.startsWith(`approval:${authorityRunId}:`),
          )
        ) {
          runIds.add(authorityRunId);
        }
      }
    }
    return runIds;
  }

  async function restorePendingApprovalStates(
    toolbox: BureauToolbox,
    metadata: unknown,
    runId: string,
    sessionId: string,
    committed?: ReadonlySet<string>,
  ): Promise<void> {
    const restoreApproval = (
      toolbox as unknown as {
        restoreApproval?: (approval: SignedPendingToolApproval) => Promise<void>;
      }
    ).restoreApproval;
    if (!restoreApproval) return;
    const metadataRecord =
      metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>)
        : undefined;
    const overrides = metadataRecord?.['pendingApprovalOverrides'];
    if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) return;
    const decidedReviewIds = new Set(
      Array.isArray(metadataRecord?.['resolvedReviewIds'])
        ? stringValues(metadataRecord['resolvedReviewIds'])
        : [],
    );
    // A peer approval marker is written after the binding has been consumed by the original
    // process. `restoreApproval` quite correctly refuses consumed bindings, but removing the
    // persisted approval here would also remove the only durable handle the trusted adapter can
    // use to attach to the already-started task.
    const peerRecoveryIds = new Set(
      readApprovalResolutionStarted(
        metadataRecord?.['approvalResolutionStartedIds'] as JSONValue | undefined,
      )
        .filter((record) => record.peerRecovery !== undefined)
        .map((record) => record.id),
    );
    for (const [reviewId, approval] of Object.entries(overrides as Record<string, unknown>)) {
      if (!reviewId.startsWith(`approval:${runId}:`)) continue;
      if (decidedReviewIds.has(reviewId)) continue;
      if (committed !== undefined && !committed.has(reviewId)) continue;
      if (peerRecoveryIds.has(reviewId)) continue;
      if (approval && typeof approval === 'object' && !Array.isArray(approval)) {
        if (!(approval as { approvalBinding?: unknown }).approvalBinding) continue;
        try {
          // COR-1872: the call resumes at the tool version its run recorded, or not at all.
          const unavailable = pinnedToolUnavailable(toolbox, approval);
          if (unavailable !== undefined) {
            // COR-1879: the plugin whose tool the run pinned reports the run it waited on.
            pluginRegistry.notePinnedUnavailable(unavailable.toolId, runId);
            throw unavailable;
          }
          await restoreApproval(approval as SignedPendingToolApproval);
        } catch (error) {
          if (
            !(error instanceof PinnedToolUnavailableError) &&
            !isTerminalApprovalBindingError(error)
          ) {
            throw error;
          }
          if (scheduledFireApprovalRuns.has(runId)) {
            await releaseScheduledFireApproval(runId, reviewId, 'invalid', { sessionId });
          } else {
            invalidApprovalReviewIds.add(reviewId);
            dropPendingApprovalOverride(reviewId);
            await peers.prunePersistedInvalidApprovalReviewStateWithRetry(
              sessionId,
              runId,
              reviewId,
            );
          }
          diagnose({
            level: 'warn',
            scope: 'approval-recovery',
            message:
              `[bureau] Failed to restore approval binding for "${reviewId}"` +
              (error instanceof PinnedToolUnavailableError
                ? ` (${error.reason}: ${error.toolId})`
                : '') +
              '; the affected review will remain unavailable while other runs recover.',
            cause: error,
          });
        }
      }
    }
  }

  return {
    readFireEngineStatus,
    closeCanceledFireReview,
    closeCanceledFireHumanWaits,
    closeOpenReviewsOfCanceledFire,
    retryCanceledFireCloses,
    persistedApprovalOf,
    adoptPersistedApprovalRound,
    rereadFireReviews,
    holdsFireApproval,
    endScheduledFireWhenNoApprovalRemains,
    releaseScheduledFireApproval,
    releaseScheduledFire,
    restorableBootApprovals,
    restorePendingApprovalOverrides,
    recoverPeerApproval,
    persistedApprovalRunIds,
    restorePendingApprovalStates,
  };
}
