/**
 * Review resolution (COR-2376 slice S15): listing the pending reviews, the guards a decision must
 * pass (the human wait, the approval round, the claim and the input), the write of an approval's
 * outcome to its session, and `resolveReview` itself. Built by `constructBureau` and reached only
 * through `createBureau`; approval persistence, fire approval restore, review records, run
 * creation, run operations, session forks and steering call into it.
 */
import {
  APPROVAL_DECISION_METADATA_KEY,
  type ApprovalDecisionRecord,
  approvalDecisionMetadata,
  decisionSurfaceOf,
  withFirstDecisionSurface,
} from '../approval-decision-metadata';
import {
  APPROVAL_OUTCOME_NOT_WRITTEN_MESSAGE,
  ApprovalOutcomeNotWrittenError,
  BureauError,
  ReviewRoundChangedError,
} from '../bureau-errors';
import {
  type ActiveRun,
  HumanWaitParkedEvent,
  type JSONValue,
  TOOL_TIMING_METADATA_KEY,
  type ToolTiming,
  admitToolResultMedia,
  bureauInvariantsField,
  createStepGeneratedMediaAdmitter,
  humanInputSchemaOf,
} from '@lostgradient/operative';
import type { AgentDefinitions } from '../agent-catalog';
import type {
  ApprovalDecisionSurface,
  ApprovalPeerRecovery,
  PendingHumanWaitReview,
  PendingReview,
  ResolveReviewInput,
  ResolveReviewResult,
  ReviewStatus,
  SessionPendingReview,
} from '../types';
import { type ApprovedCallAudit, isJsonObject } from '../approval-state-records';
import type { BureauCore, ReviewAuditAttachment, ScheduledFireApprovalEnding } from './core';
import type { BureauToolbox } from '../runtime-composition';
import {
  DURABLE_FORCIBLY_TERMINABLE_STATUSES,
  terminalActionTimestamp,
} from '../durable-run-waits';
import { type ReviewDecisionRequest, digestReviewDelivery } from '../review-decision-record';
import {
  SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS,
  resumeRefusedBeforeExecution,
} from '../bureau-construction-support';
import type { SecretAnswerAuditEntry } from '../secret-answers';
import { type SignedPendingToolApproval, type ToolExecutionResult, formatToolName } from 'armorer';
import { createAssetGeneratedMediaAdmitter } from '../assets/generated-media-admitter';
import { findRunAgentName, serializeUnknownError } from '../serialization';
import { getOwn, materializeToolResultAsync, resolveToolResult } from 'conversationalist';
import { humanWaitDecisionPayload, humanWaitDecisionRequest } from '../run-human-waits';
import { isTerminalApprovalBindingError } from '../recovered-run-classification';
import { ownEntry } from '../own-entry';
import { ownerOrLocal } from '../owner-of-record';
import { recoveredRequestContextFromMetadata } from '../session-request-context';

/** The callables review resolution reads from elsewhere in `constructBureau`. */
export interface ReviewResolutionPeers {
  /** Builds the peer recovery an approval records, when its tool is recoverable. */
  readonly peerRecoveryForApproval: (
    review: Extract<PendingReview, { kind: 'tool-approval' }>,
    input: ResolveReviewInput,
    request: ReviewDecisionRequest,
  ) => ApprovalPeerRecovery | undefined;
  /** Records that an approval resolution started, retrying the write. */
  readonly persistApprovalResolutionStartedWithRetry: (
    sessionId: string,
    reviewId: string,
    peerRecovery?: ApprovalPeerRecovery,
  ) => Promise<void>;
  /** Records the pending approval override of a review, retrying the write. */
  readonly persistPendingApprovalOverrideWithRetry: (
    sessionId: string,
    reviewId: string,
    approval: Extract<PendingReview, { kind: 'tool-approval' }>['approval'],
  ) => Promise<void>;
  /** Records a review resolution, retrying the write. */
  readonly persistReviewResolutionWithRetry: (
    sessionId: string,
    reviewId: string,
    removePendingApproval: boolean,
    runId: string,
    decision: 'approve' | 'deny' | 'reject',
    principal: string,
    reason: string | undefined,
    auditAttachment?: ReviewAuditAttachment,
    rememberTool?: string,
    commitGuard?: () => Promise<boolean>,
  ) => Promise<boolean>;
  /** Adopts the approval round a session persisted. */
  readonly adoptPersistedApprovalRound: (
    runId: string,
    reviewId: string,
    persisted: {
      approval: Extract<PendingReview, { kind: 'tool-approval' }>['approval'];
      round: number;
    },
  ) => Promise<boolean>;
  /** Ends a scheduled fire once none of its approvals remains. */
  readonly endScheduledFireWhenNoApprovalRemains: (runId: string) => void;
  /** Reads the approval a session persisted for a review. */
  readonly persistedApprovalOf: (
    metadata: Record<string, JSONValue> | undefined,
    reviewId: string,
  ) =>
    | { approval: Extract<PendingReview, { kind: 'tool-approval' }>['approval']; round: number }
    | undefined;
  /** Reads the engine status of a scheduled fire. */
  readonly readFireEngineStatus: (
    runId: string,
    consequence: string,
  ) => Promise<'cancelled' | 'ended' | 'absent' | 'unreadable'>;
  /** Releases a scheduled fire. */
  readonly releaseScheduledFire: (
    runId: string,
    ending: 'settled' | 'canceled' | 'removed',
    scope?: { sessionId?: string | undefined },
  ) => Promise<void>;
  /** Releases the approval a scheduled fire holds. */
  readonly releaseScheduledFireApproval: (
    runId: string,
    reviewId: string,
    ending: ScheduledFireApprovalEnding,
    scope?: { sessionId?: string | undefined; durablyPruned?: boolean },
  ) => Promise<void>;
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
  /** Reads the grant fields of an approval. */
  readonly grantFieldsOf: (
    rememberTool: string | undefined,
    stored: boolean,
    review: PendingReview,
  ) => Promise<{ remembered?: boolean; loosened?: boolean }>;
  /** Names the owner a review record carries. */
  readonly ownerForRecord: (runId: string) => Promise<string>;
  /** Prepares the delivery of a human wait decision. */
  readonly prepareHumanWaitDelivery: (
    review: PendingHumanWaitReview,
    payload: unknown,
    principal: string,
    decision: ResolveReviewInput['decision'],
  ) => Promise<{ readonly payload: unknown; readonly audit: readonly SecretAnswerAuditEntry[] }>;
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
  /** Refuses a decision whose secrets are not sealed. */
  readonly refuseUnsealedSecrets: (
    review: PendingReview,
    payload: unknown,
    decision: ResolveReviewInput['decision'],
  ) => void;
  /** Names the session of an active run. */
  readonly getRunSessionIdentifier: (runState: { activeRun: ActiveRun }) => string;
  /** Drains the outbox. */
  readonly drainOutbox: () => Promise<void>;
  /** Delivers a human wait decision to its session. */
  readonly deliverHumanWaitDecision: (
    review: Extract<SessionPendingReview, { kind: 'human-wait' }>,
    payload: unknown,
  ) => Promise<void>;
  /** Builds the toolbox a skill policy restores for an approval. */
  readonly skillPolicyToolboxOf: (
    review: Extract<PendingReview, { kind: 'tool-approval' }>,
    registered: BureauToolbox | undefined,
  ) => Promise<BureauToolbox>;
  /** Reads the ordinal of a human wait park. */
  readonly humanWaitParkOrdinal: (
    runId: string,
    actions: readonly { type: string; detail: unknown }[],
  ) => number;
  /** Scans the outcome of an approved call, when it is a tool result. */
  readonly scannedApprovedOutcome: (
    review: Extract<PendingReview, { kind: 'tool-approval' }>,
    result: unknown,
  ) => Promise<ToolExecutionResult>;
}

/** Builds the review resolution of one Bureau. Synchronous, and registers nothing. */
export function createReviewResolution<D extends AgentDefinitions>(
  core: BureauCore<D>,
  peers: ReviewResolutionPeers,
) {
  const {
    assetServiceHolder,
    runtimeServices,
    store,
    runtime,
    diagnose,
    interruptedFields,
    dropPendingApprovalOverride,
    catalogRunIds,
    runToolboxesByRunId,
    runScopedContexts,
    releaseRunScope,
    resolvedReviewIds,
    resolvingReviewIds,
    reviewResolutionCleanupPending,
    pendingApprovalOverrides,
    pendingApprovalRounds,
    approvalRequestedAt,
    terminalReviewSessions,
    scheduledFireApprovalRuns,
    continuingScheduledFires,
    invalidApprovalReviewIds,
    runAttribution,
    runRequestContexts,
    recoveredRunIds,
    isTransportIssuedAuthority,
    sessionPersistenceRetryDelayMilliseconds,
    sessionPersistenceSleep,
  } = core;

  function listPendingReviews(): SessionPendingReview[] {
    const now = runtimeServices.clock.now();
    const reviews: SessionPendingReview[] = [];
    const { runs } = store.getState();

    for (const [runId, runState] of runs) {
      // COR-1302: reviews stay scoped to `createRun`'s session-owned runs, as
      // they were before `bureau.run()` runs were registered on `store`.
      if (catalogRunIds.has(runId)) continue;
      const sessionId = peers.getRunSessionIdentifier(runState);
      const agentName = findRunAgentName(runState);

      // Tool-approval: any step result still needing approval, across every
      // step (not just the last) — the run may have continued past it.
      const stepCompletedTimestamps = runState.actions
        .filter((action) => action.type === 'step.completed')
        .map((action) => action.timestamp);

      for (const [stepIndex, step] of runState.steps.entries()) {
        for (const result of step.results) {
          if (result.outcome !== 'action_required' || !result.pendingApproval) continue;
          const id = `approval:${runId}:${result.pendingApproval.callId}`;
          if (resolvedReviewIds.has(id) || invalidApprovalReviewIds.has(id)) continue;
          const approval = pendingApprovalOverrides.get(id) ?? result.pendingApproval;
          // AB-46 read-time filter: a tool-approval review past its binding's
          // `expiresAt` is excluded here with no write — `sweepExpiredReviews`
          // performs the write that transitions it to `'expired'`. An
          // unsigned approval (no `approvalBinding`) never expires this way.
          if (approval.approvalBinding !== undefined && approval.approvalBinding.expiresAt <= now) {
            continue;
          }
          const requestedAt = stepCompletedTimestamps[stepIndex] ?? now;
          reviews.push({
            kind: 'tool-approval',
            id,
            runId,
            sessionId,
            agentName,
            approval,
            requestedAt,
            ageMilliseconds: now - requestedAt,
            status: 'pending',
            round: pendingApprovalRounds.get(id) ?? 0,
            ...interruptedFields(id),
          });
        }
      }

      // Human-wait: the run is still parked iff it has a HumanWaitParkedEvent
      // action and its status is still 'running'. The park event fires
      // MID-step (from inside the `requestHumanInput` tool's `execute`,
      // called by `runStep`), so that same step's own trailing events —
      // `tools.executed`, `step.generated`, `step.completed` — are always
      // recorded AFTER it, even though the run is genuinely still parked at
      // that point (`ctx.waitForSignal` only runs once the whole step loop
      // exits). Requiring the park event to be the literal last action
      // therefore misses every real parked run — this instead takes the
      // MOST RECENT park event (a later step's `requestHumanInput` call
      // last-write-wins over an earlier one, mirroring the durable
      // workflow's own accumulation) and relies on `status === 'running'`
      // to exclude a run that has already resumed and finished — resuming
      // via `ctx.waitForSignal` runs the workflow straight through to
      // completion, so `runState.status` leaves `'running'` the moment a
      // parked run is actually resumed.
      let parkedAction: (typeof runState.actions)[number] | undefined;
      for (let index = runState.actions.length - 1; index >= 0; index--) {
        const action = runState.actions[index];
        if (action?.type === HumanWaitParkedEvent.type) {
          parkedAction = action;
          break;
        }
      }

      if (runState.status === 'running' && parkedAction !== undefined) {
        const rawDetail = parkedAction.detail;
        const detail: Record<string, unknown> | undefined =
          rawDetail !== null && typeof rawDetail === 'object'
            ? (rawDetail as Record<string, unknown>)
            : undefined;
        const signalName = detail?.['signalName'];
        if (typeof signalName === 'string' && signalName.length > 0) {
          // The park ordinal (the nth park of this run, 0-based) differentiates
          // repeated parks on the same signal, so a re-park after an earlier
          // park resolved is not suppressed by the earlier park's
          // `resolvedReviewIds` entry. Unlike a timestamp it is unique under a
          // frozen clock, and it survives recovery:
          // `reconstructHumanWaitReviewIfParked` seeds it from the durable
          // checkpoint's count of prior parks.
          const id = `human-wait:${runId}:${signalName}:${peers.humanWaitParkOrdinal(runId, runState.actions)}`;
          if (!resolvedReviewIds.has(id)) {
            const promptValue = detail?.['prompt'];
            const prompt = typeof promptValue === 'string' ? promptValue : undefined;
            const inputSchema = humanInputSchemaOf(detail?.['inputSchema']);
            reviews.push({
              kind: 'human-wait',
              id,
              runId,
              sessionId,
              agentName,
              signalName,
              prompt,
              ...(inputSchema === undefined ? {} : { inputSchema }),
              requestedAt: parkedAction.timestamp,
              ageMilliseconds: now - parkedAction.timestamp,
              status: 'pending',
            });
          }
        }
      }
    }

    for (const [runId, terminalReview] of terminalReviewSessions) {
      for (const [reviewId, approval] of pendingApprovalOverrides) {
        if (!reviewId.startsWith(`approval:${runId}:`)) continue;
        if (resolvedReviewIds.has(reviewId) || invalidApprovalReviewIds.has(reviewId)) continue;
        if (reviews.some((review) => review.id === reviewId)) continue;
        if (approval.approvalBinding !== undefined && approval.approvalBinding.expiresAt <= now) {
          continue;
        }
        // COR-1596: each approval of a fire that continues is listed at its own time.
        const requestedAt = approvalRequestedAt.get(reviewId) ?? terminalReview.requestedAt;
        reviews.push({
          kind: 'tool-approval',
          id: reviewId,
          runId,
          sessionId: terminalReview.sessionId,
          agentName: terminalReview.agentName,
          approval,
          requestedAt,
          ageMilliseconds: now - requestedAt,
          status: 'pending',
          round: pendingApprovalRounds.get(reviewId) ?? 0,
          ...interruptedFields(reviewId),
        });
      }
    }

    return reviews;
  }

  /**
   * A review that was decided, whose session write has landed. A fire's approval ends through
   * {@link releaseScheduledFireApproval}, its decision's own commit having pruned the session
   * (`durablyPruned`), so a decision is one more ending through the one release; any other run's
   * review ends the way it always did.
   */
  async function releaseDecidedReview(runId: string, reviewId: string): Promise<void> {
    if (scheduledFireApprovalRuns.has(runId)) {
      await peers.releaseScheduledFireApproval(runId, reviewId, 'resolved', {
        durablyPruned: true,
      });
      return;
    }
    releaseTerminalRunReviewState(runId);
  }

  function releaseTerminalRunReviewState(runId: string): void {
    const runState = store.getRun(runId);
    // COR-1596: a fire's approvals outlive a run that was never on the store, and end only when
    // it holds none, an expired one not yet swept included.
    if (runState === undefined) {
      peers.endScheduledFireWhenNoApprovalRemains(runId);
      return;
    }
    if (runState.status === 'running') return;
    for (const review of listPendingReviews()) {
      if (review.runId === runId) return;
    }
    runRequestContexts.delete(runId);
    runToolboxesByRunId.delete(runId);
    releaseRunScope(runId);
    recoveredRunIds.delete(runId);
  }

  /** Whether this process holds the run and it has not recorded its end. */
  function isRunStillGoing(runId: string): boolean {
    const runState = store.getRun(runId);
    if (runState === undefined) return false;
    return (
      (runState.status === 'running' || runState.status === 'aborting') &&
      terminalActionTimestamp(runState.actions) === undefined
    );
  }

  /**
   * COR-855 — writes the outcome of a resolved tool approval into the session's
   * conversation, replacing the pending `action_required` tool-result row in
   * place (its id and position stay). Bureau settles a run whose tool call needs
   * approval and runs the approved tool out of band, so nothing else ever
   * replaces that row, and the next run started on the session would be shown
   * the approval as still pending.
   *
   * The tool has already run (or been refused) by now, so a failure here cannot
   * undo the resolution: it is retried like every other post-resolution write,
   * then returned for `resolveReview` to throw once the decision is recorded.
   * Reporting success would let the next run start from the stale
   * `action_required` row and ask for the approval again. A Bureau with no
   * session store has no conversation to write.
   *
   * A run that is still going when its approval is resolved (one without
   * `stopWhen: pendingApproval()`) can write its own copy of the conversation
   * over this one at its terminal save, so a host serving approvals configures it.
   */
  /**
   * When each approved call ran, by review id (COR-2014): the Bureau runs an approved call itself
   * (`resumeApproval`), so it times the run, and the outcome it writes over the call's waiting row
   * says when the call ran rather than when it was asked for.
   */
  const approvalRunTimes = new Map<string, ToolTiming>();

  /**
   * The metadata the outcome's row is written with: the waiting row's own, with no time the asking
   * left on it, and the time the approved call ran when it ran.
   */
  function approvalOutcomeMetadata(
    waiting: Readonly<Record<string, JSONValue>> | undefined,
    ran: ToolTiming | undefined,
    decided: ApprovalDecisionRecord,
  ): Record<string, JSONValue> {
    const { [TOOL_TIMING_METADATA_KEY]: _asked, ...kept } = waiting ?? {};
    // COR-2292: a row already decided keeps the surface its first decision recorded, or none.
    const held = Object.hasOwn(kept, APPROVAL_DECISION_METADATA_KEY)
      ? kept[APPROVAL_DECISION_METADATA_KEY]
      : undefined;
    return {
      ...(ran === undefined ? kept : { ...kept, [TOOL_TIMING_METADATA_KEY]: { ...ran } }),
      // COR-2016: who decided and when, so a page that was not there can say so.
      ...approvalDecisionMetadata(withFirstDecisionSurface(decided, held)),
    };
  }

  /**
   * The sentence the tool asked with, when it wrote one of its own: a message equal to the policy's
   * reason is the reason again, not a sentence the tool chose.
   */
  function askedOf(review: Extract<PendingReview, { kind: 'tool-approval' }>): string | undefined {
    const action = review.approval.action;
    const message = action?.type === 'approval' ? action.message : undefined;
    return message === undefined || message.trim() === '' || message === review.approval.reason
      ? undefined
      : message.trim();
  }

  async function writeApprovalOutcomeToSession(
    review: Extract<PendingReview, { kind: 'tool-approval' }>,
    input: ResolveReviewInput,
    result: unknown,
  ): Promise<ApprovalOutcomeNotWrittenError | undefined> {
    const sessionStore = runtime.sessionStore;
    if (!sessionStore) return undefined;
    const callId = review.approval.callId;
    const refusal = input.decision === 'reject' ? 'Tool call rejected' : 'Tool call denied';
    const message = input.reason === undefined ? refusal : `${refusal}: ${input.reason}`;
    const decidedAtISO = runtimeServices.clock.nowISO();
    const asked = askedOf(review);
    const outcome =
      input.decision === 'approve'
        ? await peers.scannedApprovedOutcome(review, result)
        : {
            callId,
            toolCallId: callId,
            toolName: review.approval.toolName,
            outcome: 'error' as const,
            content: message,
            result: message,
          };
    let lastError: unknown;
    try {
      // Collected before the write: a resumed tool may stream its output.
      const materialized = await materializeToolResultAsync(outcome);
      const toolResult =
        input.decision === 'approve'
          ? await admitApprovedToolResultMedia(review, outcome, materialized)
          : materialized;
      // The run's own terminal save is in flight when its approval is resolved
      // at once; the row to replace is not stored until it lands.
      await core.sessionPersistence.drain();
      // Read after the drain: a run that has not settled has not stored its
      // conversation, so a missing row says nothing about whether the row exists.
      const stillGoing = isRunStillGoing(review.runId);
      // COR-1596: a fire that is to take another step writes its whole conversation back then,
      // from a copy that holds the approval's row as it was, so the outcome is lost as it is
      // for a session run that is still going, and the resolver is told the same way.
      const continuingFire = continuingScheduledFires.has(review.runId);
      for (let attempt = 1; attempt <= SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS; attempt += 1) {
        try {
          let missing = false;
          await sessionStore.update(review.sessionId, (session) => {
            if (session === undefined) return undefined;
            const history = session.conversationHistory;
            const holdsRow = history.ids.some(
              (id) => getOwn(history.messages, id)?.toolResult?.callId === callId,
            );
            if (!holdsRow) {
              missing = true;
              return undefined;
            }
            const waiting = history.ids
              .map((id) => getOwn(history.messages, id))
              .find((row) => row?.toolResult?.callId === callId);
            const ran = input.decision === 'approve' ? approvalRunTimes.get(review.id) : undefined;
            return {
              ...session,
              conversationHistory: resolveToolResult(history, callId, toolResult, {
                metadata: approvalOutcomeMetadata(waiting?.metadata, ran, {
                  decision: input.decision,
                  decidedBy: input.principal,
                  decidedAt: decidedAtISO,
                  ...(input.reason === undefined ? {} : { reason: input.reason }),
                  ...(asked === undefined ? {} : { asked }),
                  ...(input.decisionSurface === undefined
                    ? {}
                    : { decisionSurface: input.decisionSurface }),
                }),
              }),
            };
          });
          if (continuingFire) {
            lastError = new Error(
              'the fire has another step to take, and its write-back would put the pending row over this outcome',
            );
            break;
          }
          if (!missing) {
            approvalRunTimes.delete(review.id);
            return undefined;
          }
          // A conversation that never held a row for the call (a review restored
          // from persisted metadata alone) shows no approval as pending, so there is
          // nothing stale to replace. A run that is still going is different: its
          // row is not stored yet, and the terminal save would put the stale one
          // there, so the outcome is lost unless the caller is told.
          if (!stillGoing) {
            approvalRunTimes.delete(review.id);
            return undefined;
          }
          lastError = new Error(
            'the run is still going and has not stored the conversation the row is in',
          );
          break;
        } catch (error) {
          lastError = error;
          if (attempt < SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS) {
            await sessionPersistenceSleep(sessionPersistenceRetryDelayMilliseconds);
          }
        }
      }
    } catch (error) {
      lastError = error;
    }
    diagnose({
      level: 'error',
      scope: 'session-persistence',
      message: `[bureau] Could not write the outcome of review "${review.id}" into session "${review.sessionId}": ${serializeUnknownError(lastError)}. The conversation still shows the approval as pending.`,
    });
    // A fixed sentence: it reaches a client's screen, and the storage error's text
    // (which can name keys and paths) stays in the diagnostic above.
    return new ApprovalOutcomeNotWrittenError(APPROVAL_OUTCOME_NOT_WRITTEN_MESSAGE);
  }

  /**
   * COR-792 — an approved tool's media reaches the session as a run's does: admitted as the run
   * owner's managed assets, or the result becomes the error that names the refused part. The
   * session's own commit then claims the row's assets.
   */
  async function admitApprovedToolResultMedia(
    review: Extract<PendingReview, { kind: 'tool-approval' }>,
    executed: ToolExecutionResult,
    materialized: Awaited<ReturnType<typeof materializeToolResultAsync>>,
  ): Promise<Awaited<ReturnType<typeof materializeToolResultAsync>>> {
    if (materialized.parts === undefined) return materialized;
    const service = assetServiceHolder.current;
    const port =
      service === undefined
        ? undefined
        : createAssetGeneratedMediaAdmitter(
            service,
            ownerOrLocal(runAttribution.get(review.runId)?.principal),
          );
    const step = { step: 0, runId: review.runId };
    const [admitted] = await admitToolResultMedia(
      createStepGeneratedMediaAdmitter({ port, ...step, signal: new AbortController().signal }),
      [{ ...executed, content: materialized.content, parts: materialized.parts }],
      step,
    );
    return materializeToolResultAsync(admitted!);
  }

  /** What a session-path resolution claims in the durable decision record (COR-1579). */
  function sessionDecisionRequest(
    review: SessionPendingReview,
    input: ResolveReviewInput,
  ): ReviewDecisionRequest {
    if (review.kind === 'human-wait') {
      return humanWaitDecisionRequest(review.id, input, humanWaitDecisionPayload(input));
    }
    return {
      reviewId: review.id,
      round: review.round,
      decision: input.decision,
      principal: input.principal,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      digest: digestReviewDelivery(
        Object.prototype.hasOwnProperty.call(input, 'arguments') ? input.arguments : null,
      ),
    };
  }

  /**
   * Refuses to approve a session human wait whose run's authority is not current, before the
   * decision is claimed: a human wait's claim is never released, so a refusal must come first.
   * A process that holds the run checks the request context it recorded. A peer (COR-1579) has
   * none, so it rebuilds the context from the session's persisted authority, as recovery does,
   * and refuses when it cannot.
   */
  /**
   * Refuses a human-wait decision with `CONFLICT`, before anything is delivered, once the engine
   * reports the run settled: canceled by the engine, say, before this process's review list heard.
   * A signal to a settled workflow would be accepted and answered as success while deciding
   * nothing. The engine, not the review list, is the source of truth here, as for a catalog park
   * (`run-human-waits.ts`). A run the engine still holds is delivered to even when it is not yet
   * waiting on the signal: the review is listed when the run parks, before the engine records
   * the wait, and a signal sent in between is buffered for it. A run the engine has no workflow
   * for (one registered on the store by hand) is left to the delivery, as before.
   */
  async function assertHumanWaitRunUnsettled(
    review: Extract<SessionPendingReview, { kind: 'human-wait' }>,
  ): Promise<void> {
    const state = await runtime.durable?.engine.get(review.runId);
    if (state === undefined || state === null) return;
    if (!DURABLE_FORCIBLY_TERMINABLE_STATUSES.has(state.status)) {
      throw new BureauError(
        `Run "${review.runId}" has settled, so review "${review.id}" is closed`,
        'CONFLICT',
      );
    }
  }

  /**
   * The check `resolveReview` makes on a human wait this call is the first to decide: it is
   * delivered only to a run the engine has not settled ({@link assertHumanWaitRunUnsettled}). A
   * same-decision re-drive skips it, because its claimant may have delivered already and the keyed
   * signal lands at most once. A refusal gives up the claim this call wrote (nothing was
   * delivered) and the in-process resolving mark, then throws.
   */
  async function refuseSettledHumanWait(
    review: SessionPendingReview,
    claim: Awaited<ReturnType<typeof core.reviewDecisions.claim>>,
    claimRequest: ReviewDecisionRequest,
  ): Promise<void> {
    if (review.kind !== 'human-wait' || claim.outcome === 'same') return;
    try {
      await assertHumanWaitRunUnsettled(review);
    } catch (error) {
      if (claim.outcome === 'claimed') await releaseApprovalClaim(claimRequest, claim.value);
      resolvingReviewIds.delete(review.id);
      throw error;
    }
  }

  async function assertHumanWaitApprovalAuthority(
    review: Extract<SessionPendingReview, { kind: 'human-wait' }>,
    peer: boolean,
  ): Promise<void> {
    let requestContext = runRequestContexts.get(review.runId);
    if (peer) {
      const session = await runtime.sessionStore?.load(review.sessionId);
      requestContext =
        session === undefined
          ? undefined
          : recoveredRequestContextFromMetadata(
              session.metadata,
              review.runId,
              review.sessionId,
              session.agentName,
              runtimeServices.clock.now,
            );
      if (requestContext === undefined) {
        throw new BureauError(
          'Cannot approve: the request authority of a run another process holds cannot be rebuilt.',
          'CONFLICT',
        );
      }
    }
    if (
      requestContext &&
      isTransportIssuedAuthority(requestContext) &&
      (!core.requestAuthorityValidator || !(await core.requestAuthorityValidator(requestContext)))
    ) {
      throw new BureauError(
        'Cannot approve: the request authority is no longer current.',
        'CONFLICT',
      );
    }
  }

  /** Gives up an approval's claim, when this call holds one, without masking the call's outcome. */
  async function releaseApprovalClaim(
    request: ReviewDecisionRequest,
    value: string | undefined,
  ): Promise<void> {
    if (value === undefined) return;
    try {
      await core.reviewDecisions.release(request, value);
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'approval',
        message: `[bureau] Could not release the decision record of review "${request.reviewId}"; a different decision stays refused until it is cleared: ${serializeUnknownError(error)}`,
      });
    }
  }

  /** Marks a decided review resolved in this process's own lists. */
  function markReviewResolvedLocally(review: SessionPendingReview): void {
    resolvedReviewIds.add(review.id);
    if (review.kind !== 'tool-approval') return;
    dropPendingApprovalOverride(review.id);
    if (
      !Array.from(pendingApprovalOverrides.keys()).some((reviewId) =>
        reviewId.startsWith(`approval:${review.runId}:`),
      )
    ) {
      terminalReviewSessions.delete(review.runId);
    }
  }

  /**
   * COR-1579 — a tool approval whose decision record another resolver already claimed with this
   * same decision. Armorer's single-use binding is single-use only inside one process, so this
   * caller never resumes the approval itself: until the claimant has persisted its resolution it
   * is still being resolved, and once it has, this caller answers as the claimant did, through the
   * persisted resolution (whose `alreadyLanded` handling appends no second audit entry).
   */
  async function answerSameApprovalDecision(
    review: Extract<SessionPendingReview, { kind: 'tool-approval' }>,
    input: ResolveReviewInput,
  ): Promise<ResolveReviewResult> {
    const session = await runtime.sessionStore?.load(review.sessionId);
    const decisions = session?.metadata['resolvedReviewDecisions'];
    if (!isJsonObject(decisions) || ownEntry(decisions, review.id) === undefined) {
      throw new BureauError(`Review with id "${review.id}" is already being resolved`, 'CONFLICT');
    }
    await peers.persistReviewResolutionWithRetry(
      review.sessionId,
      review.id,
      true,
      review.runId,
      input.decision,
      input.principal,
      input.reason,
    );
    markReviewResolvedLocally(review);
    await releaseDecidedReview(review.runId, review.id);
    await peers.recordReviewDecision(review, input.decision, input.principal, input.reason, {
      auditAlreadyAppended: true,
    });
    return {
      id: review.id,
      kind: review.kind,
      decision: input.decision,
      ...(input.decision === 'reject' ? { feedback: input.reason } : {}),
    };
  }

  /**
   * COR-1621: the check {@link refuseStaleApprovalRound} makes before a decision is claimed, made
   * again once it is held. A peer re-gates by writing the next round to the session and only then
   * releasing its claim of the round it left, so a claim of that round can land after this
   * process read the session and before the peer's release, or just after it. Once this process
   * holds the claim no one can re-gate the round, so the session read now is final. A refusal
   * here releases the claim through the failure path of the caller.
   */
  async function refuseStaleRoundOfHeldClaim(
    review: PendingReview,
    claimHeld: boolean,
    expectedRound: number | undefined,
  ): Promise<void> {
    if (!claimHeld || review.kind !== 'tool-approval') return;
    const session = await runtime.sessionStore?.load(review.sessionId);
    await refuseStaleApprovalRound(review, session?.metadata, { expectedRound, mayRetry: false });
  }

  /**
   * COR-1621: refuses a decision on a round of an approval that is behind the session's. The round
   * this process lists can be behind: a peer that re-gated the approval put the next round in the
   * session, and a decision claim is keyed by review id and round, so a decision on the stale round
   * would join the peer's claim of the round it left, or claim it afresh, and decide an approval
   * that is no longer the pending one. The round is read from the session by the caller, not
   * trusted from memory or from a subscription that may not have delivered the re-gate yet; a
   * stale round is refused with `CONFLICT` and this process's copy is refreshed.
   */
  async function refuseStaleApprovalRound(
    review: PendingReview,
    sessionMetadata: Record<string, JSONValue> | undefined,
    fence?: { readonly expectedRound: number | undefined; readonly mayRetry: boolean },
  ): Promise<'adopted' | undefined> {
    if (review.kind !== 'tool-approval') return undefined;
    const persisted = peers.persistedApprovalOf(sessionMetadata, review.id);
    if (persisted === undefined || persisted.round <= review.round) return undefined;
    await peers.adoptPersistedApprovalRound(review.runId, review.id, persisted);
    // COR-1659: a caller that names the round the session is at read the current one: this process
    // only lagged, and it has caught up, so the decision can be made afresh on the refreshed review.
    if (fence?.mayRetry === true && fence.expectedRound === persisted.round) return 'adopted';
    const message = `Review "${review.id}" was re-gated since it was listed (round ${review.round}, now ${persisted.round}); read it again before deciding it`;
    // A caller that named a round is told so by the typed refusal, not by a plain conflict.
    if (fence?.expectedRound !== undefined) throw new ReviewRoundChangedError(message);
    throw new BureauError(message, 'CONFLICT');
  }

  /**
   * COR-1659 — refuse a resolution whose `round` names a round the review is no longer at. A call
   * naming none is unfenced. A human wait has no rounds, so it is always at round 0.
   */
  function assertExpectedReviewRound(
    input: ResolveReviewInput,
    review: Pick<PendingReview, 'id' | 'kind'> & { readonly round?: number },
  ): void {
    if (input.round === undefined) return;
    const current = review.kind === 'tool-approval' ? (review.round ?? 0) : 0;
    if (input.round !== current) {
      throw new ReviewRoundChangedError(
        `Review "${review.id}" is at round ${current}, not the round ${input.round} you read; read it again before deciding`,
      );
    }
  }

  /**
   * COR-1659 — fence a decision on the round the caller read, once the session has been read and
   * `resolvingReviewIds` is held (so no other resolver here can supersede before the claim). The
   * round compared is the higher of this process's and the session's: this process can lag a peer
   * that re-gated. A caller that names the session's round is let through after this process
   * catches up (`'retry'`); any other round is refused with {@link ReviewRoundChangedError}.
   */
  async function fenceReviewRound(
    review: PendingReview,
    input: ResolveReviewInput,
    sessionMetadata: Record<string, JSONValue> | undefined,
    mayRetry: boolean,
  ): Promise<'retry' | undefined> {
    const caughtUp = await refuseStaleApprovalRound(review, sessionMetadata, {
      expectedRound: input.round,
      mayRetry,
    });
    if (caughtUp === 'adopted') return 'retry';
    assertExpectedReviewRound(input, review);
    return undefined;
  }

  /**
   * Refuses, before anything is decided or found, a `reject` without a reason (AB-46: for both review
   * kinds), and (COR-1828) a `remember` that is not the approval of a tool approval: a grant is the
   * consequence of approving, and only a tool has one to give.
   */
  function assertDecisionFitsInput(input: ResolveReviewInput): void {
    if (input.decision === 'reject' && (input.reason === undefined || input.reason.trim() === '')) {
      throw new BureauError('reject requires a reason', 'BAD_REQUEST');
    }
    if (
      input.remember === true &&
      (input.decision !== 'approve' || input.id.startsWith('human-wait:'))
    ) {
      throw new BureauError(
        'remember applies to approving a tool approval, and to nothing else',
        'BAD_REQUEST',
      );
    }
  }

  /**
   * COR-1942: a review this process no longer lists may be one someone decided. The peer's
   * follower drops its copy once it reads the decision from the shared history, so whether a late,
   * different decision answers `CONFLICT` (the decision record's answer while the peer still lists
   * the review) or `NOT_FOUND` must not depend on when that read lands. The resolved-review record
   * is keyed by the review id alone and outlives the task and the session's own fence, so it names
   * the decision. Only a decision that differs is refused as lost; repeating the decision made is
   * the documented `NOT_FOUND` of a resolved review. A review nothing recorded (expired, never
   * asked, or swept by `retention.audit`) has no decision to conflict with.
   */
  async function refuseLostDecisionOfGoneReview(input: ResolveReviewInput): Promise<void> {
    const decided = await core.resolvedReviewStore.get(input.id);
    if (
      decided !== undefined &&
      (decided.decision !== input.decision ||
        decided.decidedBy !== input.principal ||
        decided.reason !== input.reason)
    ) {
      throw new BureauError(`Review with id "${input.id}" is already resolved`, 'CONFLICT');
    }
  }

  /**
   * COR-2106 — the `executionContext` an approved call resumes with: what the run gives a call it
   * does not park (its child registry, delegated grant, parent signals, Bureau's invariants), from
   * the one function the step builds it with, and the run's id as the call's `parentRunId`. A run
   * this process does not hold has no options to build it from, but it is still Bureau's, so its
   * children still get Bureau's tier.
   */
  function approvedCallExecutionContext(runId: string): Record<string, unknown> {
    return {
      ...(runScopedContexts.get(runId) ?? bureauInvariantsField(runtime.bureauChildInvariants)),
      parentRunId: runId,
    };
  }

  /**
   * COR-1828 — what a decision's records keep beyond the decision itself. A human wait's approved
   * answer is kept as the digest the decision fence already took over its reference form
   * (`answerDigest`); a tool approval approved with `remember` names the tool its grant allows
   * (`rememberTool`).
   */
  function recordedByDecision(
    review: SessionPendingReview,
    input: ResolveReviewInput,
    digest: string,
  ): { answerDigest: string | undefined; rememberTool: string | undefined } {
    const approving = input.decision === 'approve';
    return {
      answerDigest: review.kind === 'human-wait' && approving ? digest : undefined,
      rememberTool:
        review.kind === 'tool-approval' && approving && input.remember === true
          ? // COR-1950: the id the approval is bound to, which carries the tool's version, so a
            // tool whose definition changed is not covered. An unsigned approval has none.
            (review.approval.approvalBinding?.toolDefinitionRevision ?? review.approval.toolName)
          : undefined,
    };
  }

  async function resolveReview(
    input: ResolveReviewInput,
    // COR-1579: the human wait of a session run another process holds, derived from durable
    // state by `resolveAnyReview` when this process lists no review under the id.
    derived?: Extract<SessionPendingReview, { kind: 'human-wait' }>,
    // COR-1659: set on the one re-entry after this process caught up with a peer's re-gate.
    afterCatchUp = false,
  ): Promise<ResolveReviewResult> {
    // AB-46: `reject` requires a non-empty `reason` for BOTH review kinds —
    // `resolveReview` is the validation boundary, so this throws before any
    // state change (before even finding the review), matching the gateway's
    // `POST /:id/reject` 400-on-missing-reason contract.
    assertDecisionFitsInput(input);
    const listed = listPendingReviews().find((candidate) => candidate.id === input.id);
    const review = listed ?? (derived?.id === input.id ? derived : undefined);
    if (!review) {
      const cleanup = reviewResolutionCleanupPending.get(input.id);
      if (cleanup) {
        assertExpectedReviewRound(input, cleanup.review);
        if (cleanup.decision !== input.decision) {
          throw new BureauError(`Review with id "${input.id}" is already resolved`, 'CONFLICT');
        }
        if (resolvingReviewIds.has(input.id)) {
          throw new BureauError(
            `Review with id "${input.id}" is already being resolved`,
            'CONFLICT',
          );
        }
        resolvingReviewIds.add(input.id);
        try {
          const cleanupAuditAttachment = peers.buildReviewDecisionAuditRecord(
            cleanup.review,
            cleanup.decision,
            cleanup.principal,
            cleanup.reason,
            cleanup.secretAnswers,
            cleanup.answerDigest,
            cleanup.owner,
            cleanup.decisionSurface,
          );
          const cleanupAuditAppended = await peers.persistReviewResolutionWithRetry(
            cleanup.sessionId,
            input.id,
            cleanup.kind === 'tool-approval',
            cleanup.runId,
            cleanup.decision,
            cleanup.principal,
            cleanup.reason,
            cleanupAuditAttachment,
            cleanup.rememberTool,
          );
          reviewResolutionCleanupPending.delete(input.id);
          await releaseDecidedReview(cleanup.runId, cleanup.review.id);
          if (cleanupAuditAppended) {
            // AB-391: the audit record above was appended in the SAME
            // commit as the resolution just persisted — replay it into the
            // real audit trail now, while this bureau is alive, rather
            // than leaving it for a later maintenance tick.
            //
            // Codex review finding, PR #601, "Isolate post-commit drain
            // failures from review resolution": the resolution commit
            // above has ALREADY succeeded — a transient failure in this
            // best-effort drain (a claim contention, a query error) must
            // never abort this call before it dispatches the live
            // ReviewApprovedEvent/ReviewDeniedEvent/ReviewRejectedEvent
            // below or returns its result. A failed drain here leaves the
            // attachment claimed-but-unacknowledged for a LATER drain
            // (this bureau's own next maintenance tick, or boot recovery
            // after a restart) to replay — it is never lost, only delayed.
            try {
              await peers.drainOutbox();
            } catch (error) {
              diagnose({
                level: 'error',
                scope: 'durable-maintenance',
                message: `[bureau] Post-commit outbox drain failed after resolving review "${input.id}" from the cleanup-retry path; the audit record remains pending for a later drain: ${serializeUnknownError(error)}`,
              });
            }
          }
          // The first attempt ran the tool but could not persist the decision, so it
          // never wrote the outcome either: write it now, as that attempt would have.
          const cleanupOutcomeNotWritten =
            cleanup.review.kind === 'tool-approval'
              ? await writeApprovalOutcomeToSession(
                  cleanup.review,
                  {
                    id: input.id,
                    decision: cleanup.decision,
                    principal: cleanup.principal,
                    ...(cleanup.reason !== undefined ? { reason: cleanup.reason } : {}),
                    // COR-2292: the first attempt's surface, never this retry's.
                    ...(cleanup.decisionSurface === undefined
                      ? {}
                      : { decisionSurface: cleanup.decisionSurface }),
                  },
                  cleanup.result,
                )
              : undefined;
          await peers.recordReviewDecision(
            cleanup.review,
            cleanup.decision,
            cleanup.principal,
            cleanup.reason,
            {
              auditAlreadyAppended: cleanupAuditAppended,
              secretAnswers: cleanup.secretAnswers,
              answerDigest: cleanup.answerDigest,
              owner: cleanup.owner,
              decisionSurface: cleanup.decisionSurface,
            },
          );
          if (cleanupOutcomeNotWritten !== undefined) throw cleanupOutcomeNotWritten;
          return {
            id: input.id,
            kind: cleanup.kind,
            decision: cleanup.decision,
            ...(cleanup.kind === 'tool-approval' && cleanup.decision === 'reject'
              ? { feedback: cleanup.reason }
              : {}),
            ...(await peers.grantFieldsOf(
              cleanup.rememberTool,
              cleanupAuditAppended,
              cleanup.review,
            )),
          };
        } finally {
          resolvingReviewIds.delete(input.id);
        }
      }
      await refuseLostDecisionOfGoneReview(input);
      throw new BureauError(`No pending review with id "${input.id}"`, 'NOT_FOUND');
    }

    // COR-1920: nothing unsealed is digested or claimed.
    peers.refuseUnsealedSecrets(review, humanWaitDecisionPayload(input), input.decision);
    if (resolvingReviewIds.has(review.id)) {
      throw new BureauError(`Review with id "${review.id}" is already being resolved`, 'CONFLICT');
    }
    resolvingReviewIds.add(review.id);

    let retryAfterCatchUp = false;
    try {
      // AB-391 (Codex P1 review finding, PR #601, "Fence concurrent
      // resolutions before performing the action"): everything below this
      // point — `resumeApproval`, `revokeApproval`, and the
      // `signalSession` calls that deliver an approve/deny/reject decision
      // — is an IRREVERSIBLE side effect: a tool can execute, an approval
      // binding is revoked, or a parked run resumes. `persistReviewResolution`
      // already detects a DIFFERENT resolver's already-won decision (see
      // its own doc comment), but it only runs AFTER all of that, once this
      // call is persisting its OWN decision. Two Bureau instances sharing a
      // session store, both resolving the same still-pending review with
      // DIFFERENT decisions, would otherwise let the LOSING call's
      // irreversible action run before it ever discovers it lost — an
      // approve could execute a tool even though the durable winner is a
      // deny. Checked here, before any action, so a losing call fails
      // before doing anything irreversible. This is a plain read
      // (`SessionStore.load`); a genuinely simultaneous pair, neither yet
      // committed, both pass it, and the durable decision record claimed
      // below (COR-1579) is what decides between them. This check only ever
      // fences a DIFFERENT decision — the same-decision retry case is
      // untouched, exactly as `persistReviewResolution`'s own `alreadyLanded`
      // handling already covers it.
      const existingSession = await runtime.sessionStore?.load(review.sessionId);
      const existingDecisionsRaw = existingSession?.metadata['resolvedReviewDecisions'];
      const existingDecisions: Record<string, JSONValue> =
        typeof existingDecisionsRaw === 'object' &&
        existingDecisionsRaw !== null &&
        !Array.isArray(existingDecisionsRaw)
          ? (existingDecisionsRaw as Record<string, JSONValue>)
          : {};
      const priorRaw = ownEntry(existingDecisions, review.id);
      const prior =
        typeof priorRaw === 'object' && priorRaw !== null && !Array.isArray(priorRaw)
          ? (priorRaw as Record<string, JSONValue>)
          : undefined;
      if (prior !== undefined) {
        const priorDecision = typeof prior['decision'] === 'string' ? prior['decision'] : undefined;
        const priorPrincipal =
          typeof prior['principal'] === 'string' ? prior['principal'] : undefined;
        const priorReason = typeof prior['reason'] === 'string' ? prior['reason'] : undefined;
        const isSameDecision =
          priorDecision === input.decision &&
          priorPrincipal === input.principal &&
          priorReason === input.reason;
        if (!isSameDecision) {
          throw new BureauError(
            `Review "${review.id}" was already resolved as "${priorDecision ?? 'unknown'}" by a different resolver`,
            'CONFLICT',
          );
        }
      }
      retryAfterCatchUp =
        (await fenceReviewRound(review, input, existingSession?.metadata, !afterCatchUp)) ===
        'retry';
    } catch (error) {
      resolvingReviewIds.delete(review.id);
      throw error;
    }
    if (retryAfterCatchUp) {
      resolvingReviewIds.delete(review.id);
      return resolveReview(input, derived, true);
    }

    // COR-1579: claim the decision durably before anything irreversible. See
    // `review-decision-record.ts` for which claims are kept and which released.
    const claimRequest = sessionDecisionRequest(review, input);
    // COR-1828: what the decision's records keep: see `recordedByDecision`.
    const { answerDigest, rememberTool } = recordedByDecision(review, input, claimRequest.digest);
    const decisionOwner = await peers.ownerForRecord(review.runId);
    let claim: Awaited<ReturnType<typeof core.reviewDecisions.claim>>;
    try {
      if (review.kind === 'human-wait' && input.decision === 'approve') {
        await assertHumanWaitApprovalAuthority(review, listed === undefined);
      }
      claim = await core.reviewDecisions.claim(claimRequest);
      if (claim.outcome === 'conflict') {
        throw new BureauError(
          `Review "${review.id}" was already resolved as "${claim.decision ?? 'unknown'}" by a different resolver`,
          'CONFLICT',
        );
      }
    } catch (error) {
      resolvingReviewIds.delete(review.id);
      throw error;
    }
    if (claim.outcome === 'same' && review.kind === 'tool-approval') {
      try {
        return await answerSameApprovalDecision(review, input);
      } finally {
        resolvingReviewIds.delete(review.id);
      }
    }
    await refuseSettledHumanWait(review, claim, claimRequest);
    const heldApprovalClaim =
      claim.outcome === 'claimed' && review.kind === 'tool-approval' ? claim.value : undefined;
    // Set once a step that cannot be shown not to have acted has begun: a throw before it is a
    // proven pre-execution failure, which releases an approval's claim.
    let actionStarted = false;
    // COR-1920: what the audit entry says of each secret answer this delivery stored.
    let secretAnswerAudit: readonly SecretAnswerAuditEntry[] = [];
    // COR-2009: the audit record of the approved call, once it has run.
    let approvedCallAudit: ApprovedCallAudit | undefined;

    let result: unknown;
    let keepPending = false;
    try {
      await refuseStaleRoundOfHeldClaim(review, heldApprovalClaim !== undefined, input.round);
      if (review.kind === 'tool-approval') {
        // COR-1596: a fire canceled elsewhere (a peer process, a route that never reached this
        // one) still has its approval here until this is read; the engine's status says it was
        // canceled, so nothing runs and the approval ends, whatever order the bookkeeping landed.
        if (scheduledFireApprovalRuns.has(review.runId)) {
          const engineStatus = await peers.readFireEngineStatus(
            review.runId,
            'its approval is not decided',
          );
          if (engineStatus === 'cancelled') {
            await peers.releaseScheduledFire(review.runId, 'canceled');
            throw new BureauError(
              `Run "${review.runId}" was canceled, so review "${review.id}" is closed`,
              'CONFLICT',
            );
          }
          if (engineStatus === 'unreadable' && input.decision === 'approve') {
            throw new BureauError(
              'Cannot approve: whether the run was canceled cannot be read.',
              'CONFLICT',
            );
          }
        }
        // COR-1947: an approved call is decided again, under the chat's mode of the moment.
        const approvalToolbox =
          runToolboxesByRunId.get(review.runId) ??
          runtime.withChatPermission(runtime.baseToolbox, review.runId);
        if (input.decision === 'approve') {
          const { approval } = review;
          if (approval.approvalToken === undefined) {
            throw new BureauError(
              'Cannot approve: the toolbox that executed this tool call has no ' +
                'approvalSecret configured, so its pendingApproval was never signed.',
              'NOT_CONFIGURED',
              'approval',
            );
          }
          // COR-1613: the call is decided under the skills active now, which a restored approval
          // has again: a tool they no longer permit is not run, as a step would not run it.
          // COR-1620: under a snapshot read again now, and never without one that verifies.
          const policyToolbox = await peers.skillPolicyToolboxOf(
            review,
            runToolboxesByRunId.get(review.runId),
          );
          // COR-1879: by id when the approval is bound to one, so an approval for `b:search` is not
          // let through by a skill that permits `a:search`, which shares the name `search`.
          const boundToolId = approval.approvalBinding?.toolDefinitionRevision;
          if (
            !policyToolbox
              .tools()
              .some((tool) =>
                boundToolId === undefined
                  ? formatToolName(tool.identity) === approval.toolName
                  : tool.id === boundToolId,
              )
          ) {
            throw new BureauError(
              `Cannot approve: tool "${approval.toolName}" is not permitted by the run's active skills.`,
              'CONFLICT',
            );
          }
          const approvalRequestContext = runRequestContexts.get(review.runId);
          if (
            approvalRequestContext &&
            isTransportIssuedAuthority(approvalRequestContext) &&
            !core.requestAuthorityValidator
          ) {
            throw new BureauError(
              'Cannot approve: the recovered request authority cannot be revalidated.',
              'CONFLICT',
            );
          }
          if (
            approvalRequestContext &&
            isTransportIssuedAuthority(approvalRequestContext) &&
            core.requestAuthorityValidator &&
            !(await core.requestAuthorityValidator(approvalRequestContext))
          ) {
            throw new BureauError(
              'Cannot approve: the request authority is no longer current.',
              'CONFLICT',
            );
          }
          const peerRecovery = peers.peerRecoveryForApproval(review, input, claimRequest);
          await peers.persistApprovalResolutionStartedWithRetry(
            review.sessionId,
            review.id,
            peerRecovery,
          );
          actionStarted = true;
          const approvedCallStartedAt = runtimeServices.clock.nowISO();
          result = await approvalToolbox.resumeApproval(
            { ...approval, approvalToken: approval.approvalToken },
            {
              ...(Object.prototype.hasOwnProperty.call(input, 'arguments')
                ? { arguments: input.arguments }
                : {}),
              ...(approvalRequestContext ? { requestContext: approvalRequestContext } : {}),
              // COR-1920: the approved call is the run's, so a secret answer it names resolves for
              // that run, as it would have had the call not waited for approval.
              // COR-2106: and so is the rest of the run's context (`approvedCallExecutionContext`).
              executionContext: approvedCallExecutionContext(review.runId),
              ...(peerRecovery === undefined
                ? {}
                : { durableOperationKey: peerRecovery.durableOperationKey }),
            },
          );
          approvalRunTimes.set(review.id, {
            startedAt: approvedCallStartedAt,
            endedAt: runtimeServices.clock.nowISO(),
          });

          // `resumeApproval` re-runs the tool's `beforeExecute` policy from
          // scratch — a policy that re-evaluates on edited arguments (or has
          // changed since the original request) can gate it again, returning
          // ANOTHER `action_required` instead of executing. The tool did not
          // run, so this id must stay resolvable: undo the resolved mark (the
          // same recovery the catch block below does for a thrown error) so
          // the review is not silently dropped from the queue while the tool
          // call remains genuinely pending approval.
          if (
            result !== null &&
            typeof result === 'object' &&
            'outcome' in result &&
            result.outcome === 'action_required'
          ) {
            const nextApproval = (result as Record<string, unknown>)['pendingApproval'];
            if (nextApproval && typeof nextApproval === 'object') {
              const replacementApproval = nextApproval as Extract<
                PendingReview,
                { kind: 'tool-approval' }
              >['approval'];
              // Publish the replacement locally before attempting durable
              // persistence. The original binding has already been consumed;
              // keeping it in memory after a persistence failure would make a
              // later retry reuse an invalid approval.
              pendingApprovalOverrides.set(review.id, replacementApproval);
              pendingApprovalRounds.set(review.id, review.round + 1);
              await peers.persistPendingApprovalOverrideWithRetry(
                review.sessionId,
                review.id,
                replacementApproval,
              );
              // AB-46/AB-224: the re-gate produced a genuinely new
              // `pendingApproval` for the same `callId` — the ORIGINAL
              // review is superseded, attributed to the synthetic principal
              // `'system:supersession'`, while the replacement takes over
              // the same review id as a fresh `'pending'` entry (read live
              // from `pendingApprovalOverrides` by `listPendingReviews()`,
              // not written here).
              //
              // AB-391: `superseded` is deliberately NOT coupled to the
              // override write above through the outbox — the issue's own
              // "review transitions" list (`requested`/`resolved`/
              // `rejected`/`canceled`) never names it, and bundling it into
              // the SAME `conditionalBatch` as the replacement override
              // write would embed the ORIGINAL review (with its now-revoked
              // approval token) alongside the REPLACEMENT token in one
              // commit — a real, observable difference from every other
              // transition this issue closes, not just an implementation
              // detail. Keeps writing directly, exactly as before.
              await peers.recordReviewStatusTransition(review, 'superseded', 'system:supersession');
            }
            keepPending = true;
            // COR-1579: the tool did not run, and the review is pending again under the next
            // round, so this round's claim is given up.
            await releaseApprovalClaim(claimRequest, heldApprovalClaim);
          } else if (
            result !== null &&
            typeof result === 'object' &&
            'outcome' in result &&
            result.outcome === 'error' &&
            resumeRefusedBeforeExecution(result)
          ) {
            const failedResult = result as {
              error?: { message?: string };
              errorMessage?: string;
            };
            await peers.persistPendingApprovalOverrideWithRetry(
              review.sessionId,
              review.id,
              review.approval,
            );
            // COR-1579: a proven pre-execution failure: the binding was not consumed.
            await releaseApprovalClaim(claimRequest, heldApprovalClaim);
            throw new BureauError(
              `Cannot approve: ${failedResult.error?.message ?? failedResult.errorMessage ?? 'tool approval resume failed before execution admission.'}`,
              'CONFLICT',
            );
          } else {
            // Written once the decision is recorded, below, so the log reads approval, then the
            // call it let run.
            approvedCallAudit = peers.approvedCallAuditOf(review, approval, result);
          }
        } else if (review.approval.approvalBinding && review.approval.approvalToken !== undefined) {
          await peers.persistApprovalResolutionStartedWithRetry(review.sessionId, review.id);
          actionStarted = true;
          try {
            await approvalToolbox.revokeApproval(review.approval as SignedPendingToolApproval);
          } catch (error) {
            // A denial is still authoritative when the binding has expired or
            // was already consumed. Only an issued, revocable binding needs
            // revocation; failure to revoke stale state must not lose the
            // operator's denial decision.
            if (!isTerminalApprovalBindingError(error)) throw error;
            diagnose({
              level: 'warn',
              scope: 'approval',
              message: `[bureau] Denied approval "${review.id}" was already terminal or absent: ${serializeUnknownError(error)}`,
            });
          }
        }
      } else {
        // AB-46: a `human-wait` park is a genuine durable park
        // (`ctx.waitForSignal`) — unlike tool-approval, where "deny" has no
        // run to continue, denying or rejecting a human-wait review must
        // still deliver SOMETHING on `review.signalName` or the parked run
        // stays `running` forever. Approve delivers the caller's payload,
        // deny and reject their sentinels, all on the same channel. The
        // authority was checked before the claim; the delivery goes through
        // the public `bureau.contexts.signal` (one seam, not two ways to do the
        // same thing), keyed by the review id (COR-1579), so a same-decision
        // re-drive delivers once and nothing is left buffered for the next park.
        actionStarted = true;
        // COR-1920: the sealed secrets are stored for the run before the signal names them.
        const delivery = await peers.prepareHumanWaitDelivery(
          review,
          humanWaitDecisionPayload(input),
          input.principal,
          input.decision,
        );
        secretAnswerAudit = delivery.audit;
        await peers.deliverHumanWaitDecision(review, delivery.payload);
      }
    } catch (error) {
      if (!actionStarted) await releaseApprovalClaim(claimRequest, heldApprovalClaim);
      resolvingReviewIds.delete(review.id);
      throw error;
    }

    resolvingReviewIds.delete(review.id);
    // AB-391: `false` for the `keepPending` re-gate branch above — nothing
    // is persisted there, so `recordReviewDecision` below keeps writing the
    // audit record directly, exactly as it always has.
    let auditAlreadyAppended = false;
    if (!keepPending) {
      markReviewResolvedLocally(review);
      const auditAttachment = peers.buildReviewDecisionAuditRecord(
        review,
        input.decision,
        input.principal,
        input.reason,
        secretAnswerAudit,
        answerDigest,
        decisionOwner,
        decisionSurfaceOf(review, input),
      );
      try {
        auditAlreadyAppended = await peers.persistReviewResolutionWithRetry(
          review.sessionId,
          review.id,
          review.kind === 'tool-approval',
          review.runId,
          input.decision,
          input.principal,
          input.reason,
          auditAttachment,
          rememberTool,
        );
      } catch (error) {
        // AB-391 (Codex P1 review finding, PR #601, "Distinguish concurrent
        // resolvers from commit retries"): a genuine CONFLICT here means a
        // DIFFERENT resolver's decision already durably won this review —
        // THIS call's own attempt made no partial commitment (the updater
        // returned `undefined` before building any candidate object), so
        // there is nothing to clean up and nothing for a future retry to
        // ever successfully complete: registering `reviewResolutionCleanupPending`
        // for it would only make every future call for this id re-throw the
        // identical CONFLICT via the cleanup branch above, forever. Rethrow
        // directly instead — every OTHER rejection here (a transient
        // storage failure, genuinely ambiguous) still registers cleanup as
        // before, since `resumeApproval` above may already have run and its
        // audit trace must not be lost.
        if (!(error instanceof BureauError && error.code === 'CONFLICT')) {
          reviewResolutionCleanupPending.set(review.id, {
            sessionId: review.sessionId,
            runId: review.runId,
            kind: review.kind,
            decision: input.decision,
            review,
            principal: input.principal,
            ...(input.reason !== undefined ? { reason: input.reason } : {}),
            ...(result === undefined ? {} : { result }),
            secretAnswers: secretAnswerAudit,
            answerDigest,
            rememberTool,
            owner: decisionOwner,
            decisionSurface: decisionSurfaceOf(review, input),
          });
        }
        resolvingReviewIds.delete(review.id);
        throw error;
      }
      await releaseDecidedReview(review.runId, review.id);
      if (auditAlreadyAppended) {
        // AB-391: replay the just-appended audit record promptly, while
        // this bureau is alive, rather than leaving it for a later
        // trigger.
        //
        // Codex review finding, PR #601, "Isolate post-commit drain
        // failures from review resolution": the resolution commit above
        // has ALREADY succeeded — a transient failure in this best-effort
        // drain must never abort `resolveReview` before it dispatches the
        // live event below or returns its result. A failed drain leaves
        // the attachment claimed-but-unacknowledged for a later drain (a
        // maintenance tick, or boot recovery) to replay.
        try {
          await peers.drainOutbox();
        } catch (error) {
          diagnose({
            level: 'error',
            scope: 'durable-maintenance',
            message: `[bureau] Post-commit outbox drain failed after resolving review "${review.id}"; the audit record remains pending for a later drain: ${serializeUnknownError(error)}`,
          });
        }
      }
    }

    // COR-855: the outcome the run's conversation has to show before the next
    // run starts from it. A resolution the policy gated again executed nothing.
    const outcomeNotWritten =
      review.kind === 'tool-approval' && !keepPending
        ? await writeApprovalOutcomeToSession(review, input, result)
        : undefined;

    await peers.recordReviewDecision(review, input.decision, input.principal, input.reason, {
      auditAlreadyAppended,
      secretAnswers: secretAnswerAudit,
      answerDigest,
      owner: decisionOwner,
      decisionSurface: decisionSurfaceOf(review, input),
      // COR-1828: a superseded call decided nothing, so it keeps no resolved-review record.
      decisionIsFinal: !keepPending,
    });
    await peers.recordApprovedCall(approvedCallAudit);

    if (outcomeNotWritten !== undefined) throw outcomeNotWritten;

    return {
      id: review.id,
      kind: review.kind,
      decision: input.decision,
      result,
      ...(review.kind === 'tool-approval' && input.decision === 'reject'
        ? { feedback: input.reason }
        : {}),
      ...(keepPending ? { superseded: true as const } : {}),
      // COR-1828: stored with the decision's commit; a superseded call ran nothing, so none was.
      ...(await peers.grantFieldsOf(rememberTool, !keepPending && auditAlreadyAppended, review)),
    };
  }

  return {
    listPendingReviews,
    releaseDecidedReview,
    releaseTerminalRunReviewState,
    admitApprovedToolResultMedia,
    markReviewResolvedLocally,
    assertExpectedReviewRound,
    assertDecisionFitsInput,
    resolveReview,
  };
}
