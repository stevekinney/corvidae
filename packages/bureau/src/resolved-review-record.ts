/**
 * The record Bureau keeps of a review once a person has decided it (COR-1828), so an inbox can show
 * what was decided, by whom, and when after the review has left the pending queue.
 *
 * Persisted shape (new, versioned):
 *
 * - key: `bureau-resolved-review:v1:<encodeStorageKeyComponent(boundedReviewId)>`. A review is
 *   decided once, so the review id is the whole key; the id embeds a model-chosen call id or signal
 *   name, so it is bounded the way the decision fence bounds it (`boundedReviewId`).
 * - value: JSON `{ version: 1, review, decision, decidedBy, decidedAt, owner?, reason?,
 *   answerDigest?, secretRefs? }`. `review` is an allowlisted snapshot of the review as it was asked
 *   (never a tool approval's signed token or binding); `decidedBy` is the principal that decided;
 *   `decidedAt` is epoch milliseconds; `owner` is the owner of record of the review's run, read
 *   while the run is live and carried in the decision's audit entry, so the record is still listed
 *   for its owner after the run and its session are deleted. Every record has one (a run no one holds
 *   is the local owner's, as `ownerOrLocal` has it).
 *
 * A secret answer (COR-1920) is never here: `answerDigest` is the SHA-256 of the answer in its
 * reference form (each secret field reduced to its `{ secretRef }`, which is what the decision fence
 * digests, so no digest of a secret's plaintext is kept), and `secretRefs` lists the references the
 * answer's secret fields were stored under. The ciphertext stays under `bureau-secret-answer:v1:`.
 *
 * The record is written from the decision's audit entry, by the one writer of that entry: the
 * outbox replay for a decision that rode the session commit, or the direct audit write for one that
 * did not. So it is exactly as durable as the audit entry, and a crash between the session commit
 * and the record is repaired by the replay. A write is a compare-and-swap on an absent key, so a
 * replay by two processes, or by one after a lost acknowledgement, writes it once. A replay that
 * cannot write it throws, which leaves the outbox entry unacknowledged for the next drain, exactly as
 * a failed audit write does (and, like it, holds that session's later entries behind it). The direct
 * writer has no entry to leave, so it diagnoses the failure and carries on.
 *
 * Retention follows `retention.audit` ({@link ResolvedReviewStore.pruneBefore}).
 *
 * @module resolved-review-record
 */

import { type ConditionalTextValueStore, encodeStorageKeyComponent } from '@lostgradient/storage';

import { ANONYMOUS_LOCAL_OWNER } from './owner-of-record';
import { boundedReviewId } from './review-decision-record';
import { secretAnswerReference } from './secret-answers';
import type { PendingReview, ResolvedReview, ReviewStatus } from './types';

/** The key prefix of resolved-review records, apart from every other record's. */
export const RESOLVED_REVIEW_KEY_PREFIX = 'bureau-resolved-review:v1:';

/** The decision a record can hold. */
type Decision = ResolvedReview['decision'];

function keyOf(reviewId: string): string {
  const kind = reviewId.startsWith('approval:') ? 'approval' : 'human-wait';
  return `${RESOLVED_REVIEW_KEY_PREFIX}${encodeStorageKeyComponent(boundedReviewId(reviewId, kind))}`;
}

const STATUS_OF_DECISION: Readonly<Record<Decision, ReviewStatus>> = {
  approve: 'approved',
  deny: 'denied',
  reject: 'rejected',
};

/** The audit-entry type suffix of each decision (`review.<kind>.<suffix>`). */
const DECISION_OF_SUFFIX: ReadonlyMap<string, Decision> = new Map<string, Decision>([
  ['approved', 'approve'],
  ['denied', 'deny'],
  ['rejected', 'reject'],
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The review as the record keeps it: what a reader needs to see what was decided, and none of a tool
 * approval's signed token, binding, or metadata. `status` is forced to the decision's.
 */
function snapshotOf(review: PendingReview, status: ReviewStatus): PendingReview {
  const common = {
    id: review.id,
    runId: review.runId,
    agentName: review.agentName,
    requestedAt: review.requestedAt,
    ageMilliseconds: review.ageMilliseconds,
    status,
  };
  if (review.kind === 'tool-approval') {
    const { approval } = review;
    return {
      ...common,
      kind: 'tool-approval',
      sessionId: review.sessionId,
      round: review.round ?? 0,
      approval: {
        callId: approval.callId,
        toolName: approval.toolName,
        arguments: approval.arguments,
        ...(approval.reason === undefined ? {} : { reason: approval.reason }),
        action: approval.action,
        ...(approval.policyPauseTier === undefined
          ? {}
          : { policyPauseTier: approval.policyPauseTier }),
      },
    } as unknown as PendingReview;
  }
  return {
    ...common,
    kind: 'human-wait',
    ...(review.sessionId === undefined ? {} : { sessionId: review.sessionId }),
    signalName: review.signalName,
    prompt: review.prompt,
    // The fields of the answer the question marked secret, which a retry needs to keep out of a digest.
    ...(review.secretFields === undefined ? {} : { secretFields: review.secretFields }),
  };
}

/** What {@link resolvedReviewOfAudit} reads: the payload of a review decision's audit entry. */
export type ReviewDecisionAuditPayload = {
  readonly runId: string;
  readonly type: string;
  readonly detail: unknown;
  readonly principal: string;
};

/**
 * The record a review decision's audit entry stands for, or `undefined` for an entry that is not a
 * decision (an expiry or a revocation has no decision to keep) or whose review is unreadable.
 * `decidedAt` comes from the writer, which knows when the decision was committed; the owner is the
 * one the entry's `detail` names, read while the run was live.
 */
export function resolvedReviewOfAudit(
  payload: ReviewDecisionAuditPayload,
  decidedAt: number,
): ResolvedReview | undefined {
  const [family, , suffix] = payload.type.split('.');
  const decision = suffix === undefined ? undefined : DECISION_OF_SUFFIX.get(suffix);
  if (family !== 'review' || decision === undefined || !isObject(payload.detail)) return undefined;
  const review = payload.detail['review'];
  if (!isObject(review) || typeof review['id'] !== 'string') return undefined;
  const kind = review['kind'];
  if (kind !== 'tool-approval' && kind !== 'human-wait') return undefined;
  const secretAnswers = payload.detail['secretAnswers'];
  const secretRefs = Array.isArray(secretAnswers)
    ? secretAnswers.flatMap((entry: unknown) =>
        isObject(entry) && typeof entry['field'] === 'string'
          ? [secretAnswerReference(review['id'] as string, entry['field'])]
          : [],
      )
    : [];
  const owner = payload.detail['owner'];
  const reason = payload.detail['reason'];
  const answerDigest = payload.detail['answerDigest'];
  return {
    review: snapshotOf(review as unknown as PendingReview, STATUS_OF_DECISION[decision]),
    decision,
    decidedBy: payload.principal,
    decidedAt,
    owner: typeof owner === 'string' ? owner : ANONYMOUS_LOCAL_OWNER,
    ...(typeof reason === 'string' ? { reason } : {}),
    ...(typeof answerDigest === 'string' ? { answerDigest } : {}),
    ...(secretRefs.length > 0 ? { secretRefs } : {}),
  };
}

function serialize(resolved: ResolvedReview): string {
  return JSON.stringify({
    version: 1,
    review: resolved.review,
    decision: resolved.decision,
    decidedBy: resolved.decidedBy,
    decidedAt: resolved.decidedAt,
    owner: resolved.owner,
    ...(resolved.reason === undefined ? {} : { reason: resolved.reason }),
    ...(resolved.answerDigest === undefined ? {} : { answerDigest: resolved.answerDigest }),
    ...(resolved.secretRefs === undefined ? {} : { secretRefs: resolved.secretRefs }),
  });
}

function parse(raw: string): ResolvedReview | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isObject(value) || value['version'] !== 1) return undefined;
  const review = value['review'];
  const decision = value['decision'];
  if (
    !isObject(review) ||
    typeof review['id'] !== 'string' ||
    (decision !== 'approve' && decision !== 'deny' && decision !== 'reject') ||
    typeof value['decidedBy'] !== 'string' ||
    typeof value['decidedAt'] !== 'number'
  ) {
    return undefined;
  }
  const secretRefs = value['secretRefs'];
  return {
    review: review as unknown as ResolvedReview['review'],
    decision,
    decidedBy: value['decidedBy'],
    decidedAt: value['decidedAt'],
    owner: typeof value['owner'] === 'string' ? value['owner'] : ANONYMOUS_LOCAL_OWNER,
    ...(typeof value['reason'] === 'string' ? { reason: value['reason'] } : {}),
    ...(typeof value['answerDigest'] === 'string' ? { answerDigest: value['answerDigest'] } : {}),
    ...(Array.isArray(secretRefs) && secretRefs.every((ref) => typeof ref === 'string')
      ? { secretRefs }
      : {}),
  };
}

/** The resolved-review records of a Bureau. */
export type ResolvedReviewStore = {
  /** Writes the record of a decided review, once; a record already held is left as it is. */
  record(resolved: ResolvedReview): Promise<void>;
  /** The record of one review, or `undefined` when none is held. */
  get(reviewId: string): Promise<ResolvedReview | undefined>;
  /** Every record held, in no order. A record that cannot be read is left out. */
  list(): Promise<ResolvedReview[]>;
  /** Deletes the records decided before `cutoff` (epoch milliseconds) and answers how many. */
  pruneBefore(cutoff: number): Promise<number>;
};

/**
 * The store over `kv`. With no key-value store (an ephemeral Bureau) nothing is kept: writes are
 * dropped and reads answer empty.
 */
export function createResolvedReviewStore(
  kv: ConditionalTextValueStore | undefined,
): ResolvedReviewStore {
  if (kv === undefined) {
    return {
      record: () => Promise.resolve(),
      get: () => Promise.resolve(undefined),
      list: () => Promise.resolve([]),
      pruneBefore: () => Promise.resolve(0),
    };
  }
  return {
    async record(resolved) {
      const key = keyOf(resolved.review.id);
      await kv.conditionalBatch(
        [{ key, expectedValue: null }],
        [{ type: 'set', key, value: serialize(resolved) }],
      );
    },
    async get(reviewId) {
      const raw = await kv.get(keyOf(reviewId));
      return raw === null ? undefined : parse(raw);
    },
    async list() {
      const found: ResolvedReview[] = [];
      for (const key of await kv.list(RESOLVED_REVIEW_KEY_PREFIX)) {
        const raw = await kv.get(key);
        const resolved = raw === null ? undefined : parse(raw);
        if (resolved !== undefined) found.push(resolved);
      }
      return found;
    },
    async pruneBefore(cutoff) {
      let pruned = 0;
      for (const key of await kv.list(RESOLVED_REVIEW_KEY_PREFIX)) {
        const raw = await kv.get(key);
        if (raw === null) continue;
        const resolved = parse(raw);
        // An unreadable record is as old as nothing can say, so retention leaves it to be read.
        if (resolved === undefined || resolved.decidedAt >= cutoff) continue;
        const deleted = await kv.conditionalBatch(
          [{ key, expectedValue: raw }],
          [{ type: 'delete', key }],
        );
        if (deleted) pruned += 1;
      }
      return pruned;
    },
  };
}
