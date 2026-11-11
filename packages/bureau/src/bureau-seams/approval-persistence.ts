/**
 * Approval persistence (COR-2376 slice S14): the durable records of a pending approval override, of
 * an approval resolution that started, and of a review resolution, their retrying writers, the
 * pruning of the records that no longer apply, and the committed fire approvals. Built by
 * `constructBureau` and reached only through `createBureau`; fire approval restore, recovered runs,
 * review announcements, review records, review resolution, run creation, run operations and
 * session restore call into it.
 */
import type { AgentDefinitions } from '../agent-catalog';
import type {
  ApprovalPeerRecovery,
  PendingReview,
  ResolveReviewInput,
  SessionPendingReview,
} from '../bureau-types/reviews';
import { type BureauCore, REVIEW_AUDIT_OUTBOX_NAMESPACE, type ReviewAuditAttachment } from './core';
import { BureauError } from '../bureau-errors';
import type { JSONValue } from '@lostgradient/operative';
import type { ReviewDecisionRequest } from '../review-decision-record';
import { SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS } from '../bureau-construction-support';
import {
  approvalGrantsOf,
  isJsonObject,
  omitKey,
  omitKeysWithPrefix,
  omitStartedRecord,
  omitStartedRecordsWithPrefix,
  readApprovalResolutionStarted,
  writeApprovalResolutionStarted,
} from '../approval-state-records';
import { committedFireApprovalIds, withoutFireApprovals } from '../scheduled-fire-review-state';
import { ownEntry } from '../own-entry';
import { serializeUnknownError } from '../serialization';

/** The callables approval persistence reads from elsewhere in `constructBureau`. */
export interface ApprovalPersistencePeers {
  /** Lists the reviews that are pending. */
  readonly listPendingReviews: () => SessionPendingReview[];
}

/** Builds the approval persistence of one Bureau. Synchronous, and registers nothing. */
export function createApprovalPersistence<D extends AgentDefinitions>(
  core: BureauCore<D>,
  peers: ApprovalPersistencePeers,
) {
  const {
    options,
    runtimeServices,
    store,
    runtime,
    diagnose,
    resolvedReviewIds,
    pendingApprovalRounds,
    scheduledFireApprovalRuns,
    sessionPersistenceRetryDelayMilliseconds,
    sessionPersistenceSleep,
  } = core;

  function reviewAuditOutboxAttachment(
    attachment: ReviewAuditAttachment | undefined,
  ): readonly { namespace: string; payload: JSONValue }[] {
    if (!attachment) return [];
    return [
      {
        namespace: REVIEW_AUDIT_OUTBOX_NAMESPACE,
        // `attachment.detail` is typed `unknown` to match `AuditTrail.record()`'s
        // own `detail` field (a `PendingReview` snapshot plus decision/reason
        // strings) — every existing out-of-band audit write already assumes
        // this shape is JSON-safe and passes it straight to `JSON.stringify`
        // with no further serialization (`writeOutOfBandRecord`), so this
        // cast asserts nothing new; it only carries that same, already-relied-
        // on assumption across the `SessionOutboxEntry.payload: JSONValue`
        // boundary.
        payload: attachment as unknown as JSONValue,
      },
    ];
  }

  async function persistPendingApprovalOverride(
    sessionId: string,
    reviewId: string,
    approval: Extract<PendingReview, { kind: 'tool-approval' }>['approval'],
  ): Promise<void> {
    if (!runtime.sessionStore) return;
    const serializedApproval = JSON.parse(JSON.stringify(approval)) as JSONValue;
    const round = pendingApprovalRounds.get(reviewId) ?? 0;
    await runtime.sessionStore.update(sessionId, (session) => ({
      ...session!,
      metadata: {
        ...session!.metadata,
        approvalResolutionStartedIds: omitStartedRecord(
          session!.metadata['approvalResolutionStartedIds'],
          reviewId,
        ),
        pendingApprovalOverrides: {
          ...(isJsonObject(session!.metadata['pendingApprovalOverrides'])
            ? session!.metadata['pendingApprovalOverrides']
            : {}),
          [reviewId]: serializedApproval,
        },
        // Written with the override in one update, so a round never outlives or
        // trails the approval it counts.
        pendingApprovalRounds: {
          ...(isJsonObject(session!.metadata['pendingApprovalRounds'])
            ? session!.metadata['pendingApprovalRounds']
            : {}),
          [reviewId]: round,
        },
      },
    }));
  }

  async function persistApprovalResolutionStarted(
    sessionId: string,
    reviewId: string,
    peerRecovery?: ApprovalPeerRecovery,
  ): Promise<void> {
    if (!runtime.sessionStore) return;
    await runtime.sessionStore.update(sessionId, (session) => {
      if (!session) return session;
      const started = readApprovalResolutionStarted(
        session.metadata['approvalResolutionStartedIds'],
      );
      return {
        ...session,
        metadata: {
          ...session.metadata,
          approvalResolutionStartedIds: writeApprovalResolutionStarted(
            started.some((record) => record.id === reviewId)
              ? started.map((record) =>
                  record.id === reviewId && peerRecovery !== undefined
                    ? { ...record, peerRecovery }
                    : record,
                )
              : [
                  {
                    id: reviewId,
                    startedAt: runtimeServices.clock.now(),
                    ...(peerRecovery === undefined ? {} : { peerRecovery }),
                  },
                ],
          ),
        },
      };
    });
  }

  async function prunePersistedPendingApprovalOverrides(
    sessionId: string,
    reviewIdPrefix: string,
  ): Promise<void> {
    if (!runtime.sessionStore) return;
    await runtime.sessionStore.update(sessionId, (session) => {
      if (!session) return session;
      const current = session.metadata['pendingApprovalOverrides'];
      const remaining =
        typeof current === 'object' && current !== null && !Array.isArray(current)
          ? omitKeysWithPrefix(current as Record<string, JSONValue>, reviewIdPrefix)
          : current;
      const currentStarted = session.metadata['approvalResolutionStartedIds'];
      const remainingStarted =
        currentStarted === undefined
          ? undefined
          : omitStartedRecordsWithPrefix(currentStarted, reviewIdPrefix);
      const currentRounds = session.metadata['pendingApprovalRounds'];
      const remainingRounds = isJsonObject(currentRounds)
        ? omitKeysWithPrefix(currentRounds, reviewIdPrefix)
        : currentRounds;
      return {
        ...session,
        metadata: {
          ...session.metadata,
          ...(remainingRounds === undefined ? {} : { pendingApprovalRounds: remainingRounds }),
          ...(remaining === undefined ? {} : { pendingApprovalOverrides: remaining }),
          ...(remainingStarted === undefined
            ? {}
            : { approvalResolutionStartedIds: remainingStarted }),
        },
      };
    });
  }

  async function retryRunDeletionPersistenceWrite(
    operation: 'pending-approvals' | 'resolved-reviews',
    sessionId: string,
    reviewIdPrefix: string,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS; attempt += 1) {
      try {
        if (operation === 'pending-approvals') {
          await prunePersistedPendingApprovalOverrides(sessionId, reviewIdPrefix);
        } else {
          await prunePersistedResolvedReviewIds(sessionId, reviewIdPrefix);
        }
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

  async function prunePersistedInvalidApprovalReviewState(
    sessionId: string,
    runId: string,
    reviewId: string,
  ): Promise<void> {
    if (!runtime.sessionStore) return;
    await runtime.sessionStore.update(sessionId, (session) => {
      if (!session) return session;
      const currentPending = session.metadata['pendingApprovalOverrides'];
      let persistedApprovalOverrides = currentPending;
      if (
        typeof currentPending === 'object' &&
        currentPending !== null &&
        !Array.isArray(currentPending)
      ) {
        const { [reviewId]: _removed, ...remaining } = currentPending as Record<string, JSONValue>;
        persistedApprovalOverrides = remaining;
      }

      let hasRemainingApprovalForRun = false;
      if (
        typeof persistedApprovalOverrides === 'object' &&
        persistedApprovalOverrides !== null &&
        !Array.isArray(persistedApprovalOverrides)
      ) {
        for (const id of Object.keys(persistedApprovalOverrides)) {
          if (id.startsWith(`approval:${runId}:`)) {
            hasRemainingApprovalForRun = true;
            break;
          }
        }
      }
      let lastRequestAuthorities = session.metadata['lastRequestAuthorities'];
      if (
        !hasRemainingApprovalForRun &&
        typeof lastRequestAuthorities === 'object' &&
        lastRequestAuthorities !== null &&
        !Array.isArray(lastRequestAuthorities)
      ) {
        const { [runId]: _removed, ...remainingAuthorities } = lastRequestAuthorities as Record<
          string,
          JSONValue
        >;
        lastRequestAuthorities = remainingAuthorities;
      }

      const currentRounds = session.metadata['pendingApprovalRounds'];
      return {
        ...session,
        metadata: {
          ...session.metadata,
          ...(persistedApprovalOverrides !== currentPending
            ? { pendingApprovalOverrides: persistedApprovalOverrides }
            : {}),
          ...(lastRequestAuthorities !== session.metadata['lastRequestAuthorities']
            ? { lastRequestAuthorities }
            : {}),
          // The round counts supersessions of an approval that is gone (COR-1596).
          ...(isJsonObject(currentRounds)
            ? { pendingApprovalRounds: omitKey(currentRounds, reviewId) }
            : {}),
        },
      };
    });
  }

  async function prunePersistedInvalidApprovalReviewStateWithRetry(
    sessionId: string,
    runId: string,
    reviewId: string,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS; attempt += 1) {
      try {
        await prunePersistedInvalidApprovalReviewState(sessionId, runId, reviewId);
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

  async function persistPendingApprovalOverrideWithRetry(
    sessionId: string,
    reviewId: string,
    approval: Extract<PendingReview, { kind: 'tool-approval' }>['approval'],
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS; attempt += 1) {
      try {
        await persistPendingApprovalOverride(sessionId, reviewId, approval);
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

  async function persistApprovalResolutionStartedWithRetry(
    sessionId: string,
    reviewId: string,
    peerRecovery?: ApprovalPeerRecovery,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS; attempt += 1) {
      try {
        await persistApprovalResolutionStarted(sessionId, reviewId, peerRecovery);
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

  function peerRecoveryForApproval(
    review: Extract<PendingReview, { kind: 'tool-approval' }>,
    input: ResolveReviewInput,
    request: ReviewDecisionRequest,
  ): ApprovalPeerRecovery | undefined {
    if (input.decision !== 'approve') return undefined;
    const revision = review.approval.approvalBinding?.toolDefinitionRevision;
    if (revision === undefined || !options.recoverableStartedApprovals?.has(revision)) {
      return undefined;
    }
    const effectiveArguments = Object.prototype.hasOwnProperty.call(input, 'arguments')
      ? input.arguments
      : review.approval.arguments;
    const argumentsRecord = isJsonObject(effectiveArguments as JSONValue)
      ? (effectiveArguments as Record<string, JSONValue>)
      : undefined;
    const message = argumentsRecord?.['message'];
    if (typeof message !== 'string' || message.trim().length === 0) return undefined;
    return {
      version: 1,
      toolDefinitionRevision: revision,
      durableOperationKey: `approval-resume:v1:${review.id}`,
      request,
      arguments: { message },
    };
  }

  async function persistReviewResolution(
    sessionId: string,
    reviewId: string,
    removePendingApproval: boolean,
    runId: string,
    // AB-391 (Codex P1 review finding, PR #601, "Distinguish concurrent
    // resolvers from commit retries"): this call's OWN decision identity,
    // persisted alongside `resolvedReviewIds` (as `resolvedReviewDecisions`)
    // so a later attempt that finds `reviewId` already resolved can tell
    // apart two cases that both look identical from `resolvedReviewIds`
    // alone: THIS SAME caller's own retry after an ambiguous commit (the
    // persisted decision matches), versus a DIFFERENT resolver's genuinely
    // different decision having already won a race (two Bureau instances
    // sharing a session store, both resolving the same still-pending
    // review). See the `resolvedReviewIds.includes(reviewId)` branch below.
    decision: 'approve' | 'deny' | 'reject',
    principal: string,
    reason: string | undefined,
    // AB-391: the decision's audit payload, appended as a `session.attachment`
    // outbox entry in the SAME `conditionalBatch` as this function's own
    // `sessionStore.update()` commit below — see `reviewAuditOutboxAttachment`.
    // Unlike this function, `persistPendingApprovalOverride` (the
    // tool-approval re-gate path) takes no such parameter: its commit writes
    // the REPLACEMENT approval, and coupling the superseded review's own
    // audit payload — which embeds its now-revoked ORIGINAL approval token —
    // into that same batch would put both tokens in one commit, a real
    // behavioral difference (see `recordReviewStatusTransition`'s own doc
    // comment on the `superseded` branch).
    auditAttachment?: ReviewAuditAttachment,
    // COR-1828: the tool the decision asked to remember. It joins the session's `approvalGrants`
    // in this same commit, so the grant and the decision land together or not at all.
    rememberTool?: string,
    /** Recovery-only guard evaluated against the fresh session immediately before its CAS write. */
    commitGuard?: () => Promise<boolean>,
    // AB-391 (Codex review finding, PR #601, "Detect when the resolution
    // update appends nothing"): returns whether the `sessionStore.update()`
    // call below actually committed — `false` when the updater returned
    // `undefined` (e.g. the session was concurrently deleted between this
    // review being read and this call running), in which case NEITHER the
    // resolution NOR the coupled `auditAttachment` outbox entry was
    // appended. A caller that ignored this return and unconditionally
    // treated the audit record as "already appended" would suppress the
    // fallback direct write in `recordReviewDecision` for a decision that
    // in fact recorded no durable audit trace at all.
  ): Promise<boolean> {
    if (!runtime.sessionStore) return false;
    // AB-391 (Codex P1 review finding, PR #601, "Avoid reattaching audits
    // after an ambiguous commit"): set by the updater below when this
    // `reviewId` is ALREADY present in the session's `resolvedReviewIds` —
    // meaning some earlier commit already durably landed this exact
    // decision (and its coupled audit attachment), most likely because a
    // prior call's `conditionalBatch` committed but the call back still
    // rejected (the fault-engine test helper's own `fail-after-commit`
    // boundary names exactly this ambiguous outcome: a lost
    // acknowledgement). The updater returns `undefined` in that case so
    // `sessionStore.update()` never calls `commit()` at all — no re-commit,
    // no second `session.attachment` outbox entry at a fresh ordinal (which
    // would carry a distinct `dedupeKey` from the one the earlier commit
    // already wrote, so the `dedupeKey` guard alone could not have caught
    // it). Detected HERE, inside the updater, rather than via a separate
    // read-then-decide check before retrying: the updater already reads the
    // CAS-fresh session body on every attempt (including a fresh call from
    // `persistReviewResolutionWithRetry`'s cleanup-pending retry path, not
    // just an in-loop retry of THIS call), so this is the one place that
    // sees every attempt's live state without an extra read.
    let alreadyLanded = false;
    let conflictingDecision: { decision?: string; principal?: string; reason?: string } | undefined;
    const committed = await runtime.sessionStore.update(
      sessionId,
      async (session) => {
        if (!session) return session;
        const currentResolved = session.metadata['resolvedReviewIds'];
        const persistedResolvedReviewIds: string[] = [];
        if (Array.isArray(currentResolved)) {
          for (const id of currentResolved) {
            if (typeof id === 'string') persistedResolvedReviewIds.push(id);
          }
        }
        if (persistedResolvedReviewIds.includes(reviewId)) {
          // AB-391 (Codex P1 review finding, PR #601, "Distinguish
          // concurrent resolvers from commit retries"): `resolvedReviewIds`
          // alone cannot tell this call's own ambiguous-commit retry apart
          // from a DIFFERENT resolver's already-won, genuinely different
          // decision — both look identical here. Compare against the
          // persisted decision identity instead. A resolution recorded
          // before this field existed (`prior === undefined`) is treated as
          // benign/own-retry, matching this fix's own backward-compatible
          // default.
          const currentDecisionsRaw = session.metadata['resolvedReviewDecisions'];
          const currentDecisions: Record<string, JSONValue> =
            typeof currentDecisionsRaw === 'object' &&
            currentDecisionsRaw !== null &&
            !Array.isArray(currentDecisionsRaw)
              ? (currentDecisionsRaw as Record<string, JSONValue>)
              : {};
          const priorRaw = ownEntry(currentDecisions, reviewId);
          const prior =
            typeof priorRaw === 'object' && priorRaw !== null && !Array.isArray(priorRaw)
              ? (priorRaw as Record<string, JSONValue>)
              : undefined;
          if (prior !== undefined) {
            const priorDecision =
              typeof prior['decision'] === 'string' ? prior['decision'] : undefined;
            const priorPrincipal =
              typeof prior['principal'] === 'string' ? prior['principal'] : undefined;
            const priorReason = typeof prior['reason'] === 'string' ? prior['reason'] : undefined;
            const isSameDecision =
              priorDecision === decision && priorPrincipal === principal && priorReason === reason;
            if (!isSameDecision) {
              conflictingDecision = {
                ...(priorDecision !== undefined ? { decision: priorDecision } : {}),
                ...(priorPrincipal !== undefined ? { principal: priorPrincipal } : {}),
                ...(priorReason !== undefined ? { reason: priorReason } : {}),
              };
              return undefined;
            }
          }
          alreadyLanded = true;
          return undefined;
        }
        const currentPending = session.metadata['pendingApprovalOverrides'];
        let persistedApprovalOverrides = currentPending;
        if (
          removePendingApproval &&
          typeof currentPending === 'object' &&
          currentPending !== null &&
          !Array.isArray(currentPending)
        ) {
          const { [reviewId]: _removed, ...remaining } = currentPending as Record<
            string,
            JSONValue
          >;
          persistedApprovalOverrides = remaining;
        }
        const run = store.getRun(runId);
        let hasRemainingReviews = false;
        for (const review of peers.listPendingReviews()) {
          if (review.runId !== runId) continue;
          hasRemainingReviews = true;
          break;
        }
        let lastRequestAuthorities = session.metadata['lastRequestAuthorities'];
        const runHasEnded = run ? run.status !== 'running' : false;
        if (
          runHasEnded &&
          !hasRemainingReviews &&
          typeof lastRequestAuthorities === 'object' &&
          lastRequestAuthorities !== null &&
          !Array.isArray(lastRequestAuthorities)
        ) {
          const { [runId]: _removed, ...remainingAuthorities } = lastRequestAuthorities as Record<
            string,
            JSONValue
          >;
          lastRequestAuthorities = remainingAuthorities;
        }
        if (commitGuard !== undefined && !(await commitGuard())) return undefined;
        return {
          ...session,
          metadata: {
            ...session.metadata,
            approvalResolutionStartedIds: omitStartedRecord(
              session.metadata['approvalResolutionStartedIds'],
              reviewId,
            ),
            ...(rememberTool === undefined
              ? {}
              : {
                  approvalGrants: [
                    ...new Set([...approvalGrantsOf(session.metadata), rememberTool]),
                  ],
                }),
            // `resolvedReviewIds` is guaranteed to NOT already include
            // `reviewId` here — the `alreadyLanded`/`conflictingDecision`
            // early returns above handle that case before this object is
            // ever built.
            resolvedReviewIds: [...persistedResolvedReviewIds, reviewId],
            // AB-391: this call's own decision identity, persisted so a
            // LATER attempt that finds `reviewId` already resolved can
            // compare against it — see the `resolvedReviewIds.includes`
            // branch above.
            resolvedReviewDecisions: {
              ...(isJsonObject(session.metadata['resolvedReviewDecisions'])
                ? session.metadata['resolvedReviewDecisions']
                : {}),
              [reviewId]: {
                decision,
                principal,
                ...(reason !== undefined ? { reason } : {}),
              },
            },
            ...(removePendingApproval
              ? {
                  pendingApprovalOverrides: persistedApprovalOverrides,
                  // The round counts supersessions of an approval that is pending; a decided
                  // one has none to count (COR-1596).
                  ...(isJsonObject(session.metadata['pendingApprovalRounds'])
                    ? {
                        pendingApprovalRounds: omitKey(
                          session.metadata['pendingApprovalRounds'],
                          reviewId,
                        ),
                      }
                    : {}),
                }
              : {}),
            ...(removePendingApproval &&
            isJsonObject(session.metadata['approvalPeerRecoveryResults'])
              ? {
                  approvalPeerRecoveryResults: omitKey(
                    session.metadata['approvalPeerRecoveryResults'],
                    reviewId,
                  ),
                }
              : {}),
            ...(lastRequestAuthorities !== session.metadata['lastRequestAuthorities']
              ? { lastRequestAuthorities }
              : {}),
            // COR-1596: a fire is never on the store, so what ends with its approval is read
            // from the session's own record of the fire's approvals, which keeps the authority
            // while a sibling, one expired but not yet swept included, still holds it.
            ...(removePendingApproval && !run && scheduledFireApprovalRuns.has(runId)
              ? (withoutFireApprovals(session.metadata, runId, (id) => id === reviewId) ?? {})
              : {}),
          },
        };
      },
      { outbox: reviewAuditOutboxAttachment(auditAttachment) },
    );
    if (conflictingDecision) {
      // AB-391 (Codex P1 review finding, PR #601, "Distinguish concurrent
      // resolvers from commit retries"): a DIFFERENT resolver's decision
      // already durably won this review — this call made no partial
      // commitment of its own (the updater returned `undefined` before
      // building any candidate object), so reporting a fabricated success
      // here (the pre-fix behavior) would return a result, and dispatch a
      // live event, contradicting the sole durable audit record. Mirrors
      // the existing `reviewResolutionCleanupPending` CONFLICT shape
      // (`resolveReview`'s own "already resolved" throw) rather than
      // inventing a new error shape for the same underlying situation.
      throw new BureauError(
        `Review "${reviewId}" was already resolved as "${conflictingDecision.decision ?? 'unknown'}" by a different resolver`,
        'CONFLICT',
      );
    }
    if (alreadyLanded) return true;
    return committed !== undefined;
  }

  async function persistReviewResolutionWithRetry(
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
    // AB-391: see `persistReviewResolution`'s own doc comment on this
    // return value, including its `alreadyLanded` handling of an ambiguous
    // prior commit — that check runs on EVERY call to
    // `persistReviewResolution` below, including a retry in this loop AND a
    // wholly separate later call from the `reviewResolutionCleanupPending`
    // path, so this loop itself needs no extra ambiguous-commit handling of
    // its own.
  ): Promise<boolean> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS; attempt += 1) {
      try {
        return await persistReviewResolution(
          sessionId,
          reviewId,
          removePendingApproval,
          runId,
          decision,
          principal,
          reason,
          auditAttachment,
          rememberTool,
          commitGuard,
        );
      } catch (error) {
        // AB-391 (Codex P1 review finding, PR #601, "Distinguish concurrent
        // resolvers from commit retries"): a genuine CONFLICT — a DIFFERENT
        // resolver's decision already durably won — is not transient, so
        // retrying would only re-throw the identical CONFLICT again. Fail
        // fast instead of burning the remaining attempts and their sleeps.
        if (error instanceof BureauError && error.code === 'CONFLICT') throw error;
        lastError = error;
        if (attempt < SESSION_PERSISTENCE_MAXIMUM_ATTEMPTS) {
          await sessionPersistenceSleep(sessionPersistenceRetryDelayMilliseconds);
        }
      }
    }
    throw lastError;
  }

  async function prunePersistedResolvedReviewIds(
    sessionId: string,
    reviewIdPrefix: string,
  ): Promise<void> {
    if (!runtime.sessionStore) return;
    await runtime.sessionStore.update(sessionId, (session) => {
      if (!session) return session;
      const current = session.metadata['resolvedReviewIds'];
      const currentDecisions = session.metadata['resolvedReviewDecisions'];
      const hasDecisions =
        typeof currentDecisions === 'object' &&
        currentDecisions !== null &&
        !Array.isArray(currentDecisions);
      if (!Array.isArray(current) && !hasDecisions) return session;
      const remainingReviewIds: string[] = [];
      if (Array.isArray(current)) {
        for (const id of current) {
          if (typeof id === 'string' && !id.startsWith(reviewIdPrefix)) {
            remainingReviewIds.push(id);
          }
        }
      }
      // AB-391 (Codex P2 review finding, PR #601, "Prune decision identities
      // with resolved review IDs"): `resolvedReviewDecisions` is a sibling
      // map keyed by the same review ids as `resolvedReviewIds` — pruning
      // one without the other leaves stale decision/principal/reason data
      // for deleted runs behind forever in a long-lived session.
      const remainingDecisions = hasDecisions
        ? omitKeysWithPrefix(currentDecisions as Record<string, JSONValue>, reviewIdPrefix)
        : currentDecisions;
      return {
        ...session,
        metadata: {
          ...session.metadata,
          ...(Array.isArray(current) ? { resolvedReviewIds: remainingReviewIds } : {}),
          ...(hasDecisions ? { resolvedReviewDecisions: remainingDecisions } : {}),
        },
      };
    });
  }

  function restoreResolvedReviewIds(metadata: unknown, runId: string): void {
    const metadataRecord =
      metadata && typeof metadata === 'object' && !Array.isArray(metadata)
        ? (metadata as Record<string, unknown>)
        : undefined;
    const persistedIds = metadataRecord?.['resolvedReviewIds'];
    if (!Array.isArray(persistedIds)) return;
    for (const reviewId of persistedIds) {
      if (typeof reviewId === 'string' && reviewId.startsWith(`approval:${runId}:`)) {
        resolvedReviewIds.add(reviewId);
      }
      if (typeof reviewId === 'string' && reviewId.startsWith(`human-wait:${runId}:`)) {
        resolvedReviewIds.add(reviewId);
      }
    }
  }

  /**
   * COR-1596 — the review ids of the tool approvals a schedule fire's run has committed, read from
   * its checkpoint, which is the only source of truth for which of a fire's approvals exist,
   * whatever the fire's status. A fire writes its session as each step completes and commits the
   * step after, so the session can hold an approval the run never committed and, once recovered,
   * will not make again under the same call: what the session holds is a claim, and a reader of
   * it checks it here. `undefined` when the checkpoint cannot be read, which is diagnosed and
   * which no caller acts on: the session is left as it is for the next read.
   */
  async function readCommittedFireApprovals(
    runId: string,
    purpose: string,
  ): Promise<ReadonlySet<string> | undefined> {
    const durable = runtime.durable;
    if (durable === undefined) return undefined;
    try {
      // Strict: a tolerant read skips a step record that fails the parts check, and a step
      // skipped is a committed approval taken for an abandoned one.
      return committedFireApprovalIds(
        runId,
        await durable.checkpointStore.loadSteps(runId, { strict: true }),
      );
    } catch (error) {
      diagnose({
        level: 'error',
        scope: 'recovery',
        message: `[bureau] Could not read what schedule fire "${runId}" committed, so ${purpose}: ${serializeUnknownError(error)}`,
        cause: error,
      });
      return undefined;
    }
  }

  return {
    reviewAuditOutboxAttachment,
    prunePersistedPendingApprovalOverrides,
    retryRunDeletionPersistenceWrite,
    prunePersistedInvalidApprovalReviewStateWithRetry,
    persistPendingApprovalOverrideWithRetry,
    persistApprovalResolutionStartedWithRetry,
    peerRecoveryForApproval,
    persistReviewResolutionWithRetry,
    prunePersistedResolvedReviewIds,
    restoreResolvedReviewIds,
    readCommittedFireApprovals,
  };
}
