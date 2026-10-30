/**
 * The durable decision record that fences review resolution across Bureau processes (COR-1579).
 *
 * Bureau's default durable ownership posture (`'workflow-lease'`) lets several processes share
 * one backend, and any of them can be asked to resolve the same review. A guard held in one
 * process's memory cannot stop another process acting, so before any irreversible step (a
 * delivered signal, an executed or revoked tool approval) a resolver claims the review here, by
 * compare-and-swap in the Bureau's `ConditionalTextValueStore`. Exactly one claim is written per
 * review round; every other resolver reads it back and either joins it or is refused.
 *
 * Persisted shape (new, versioned; the prefix is disjoint from `ag-ui-lease:v1` and the command
 * ledgers):
 *
 * - key: `review-decision:v1:<encodeStorageKeyComponent(boundedReviewId)>:<round>`, where
 *   `boundedReviewId` is the review id when it fits in 128 UTF-8 bytes and otherwise a
 *   fixed-length `<kind>:sha256:<hex>` of it ({@link boundedReviewId}, the rule
 *   `humanWaitDeliveryId` already used), and `round` is the tool approval's
 *   `PendingToolApprovalReview.round`, or `0` for a human wait;
 * - value: JSON `{ "decision": "approve" | "deny" | "reject", "principal": string,
 *   "reason"?: string, "digest": string, "recorded": boolean }`. `digest` is the SHA-256 of the
 *   canonical JSON of what the decision delivers, each sealed secret answer in it reduced to its
 *   `{ secretRef }` (COR-1920): a human wait's payload (`input.payload` on
 *   approve, the denial sentinel otherwise), or a tool approval's `input.arguments` when the caller
 *   passes them and `null` otherwise; an absent (`undefined`) value digests as `null`, so an approve
 *   with no payload and one with `payload: null` make the same decision. Canonical JSON sorts
 *   every object's keys (`canonicalJson`). `recorded` is written `false` and turned `true`, by
 *   compare-and-swap, immediately before a catalog-path audit write.
 *
 * The same decision: a caller whose `decision`, `principal`, `reason` and `digest` all equal the
 * record's makes the same decision as its claimant, and is answered as the claimant is. Anything
 * else is `CONFLICT`, thrown before any action and before any audit record. A record that cannot
 * be parsed fails closed: it is never overwritten, and every caller is refused.
 *
 * Human waits keep their claim when delivery throws. A thrown `engine.signal` is indeterminate:
 * Weft commits the signal and its accepted-response marker in one batch and can throw afterwards,
 * while waking the run. So a human wait's claimant never releases its record. A same-decision
 * caller that finds the record re-drives the keyed signal (delivered under `humanWaitDeliveryId`,
 * which Weft deduplicates by its accepted-response marker, so it lands at most once) and then
 * answers success; a different decision stays `CONFLICT`, including against a claimant that
 * died, until a same-decision call re-drives it.
 *
 * Tool approvals release their claim only on a proven pre-execution failure or a re-gate: when a
 * check before `resumeApproval` (or `revokeApproval`) throws, when `resumeApproval` reports
 * `approvalBindingConsumed: false`, or when it gates the call again (the review stays pending
 * under the next round, whose key differs). The claimant deletes the record by compare-and-swap
 * on the exact value it wrote. A same-decision approval caller never calls `resumeApproval`
 * itself, because Armorer's single-use binding is single-use only inside one process: until the
 * claimant has persisted its resolution the caller is told `CONFLICT` (`already being resolved`),
 * and afterwards it answers success through the persisted resolution.
 *
 * Audit: exactly one `review.*` entry exists per decided review. On the session path the entry
 * rides the resolution's own outbox commit, which is idempotent already. On the catalog path the
 * entry is written only by the caller whose compare-and-swap turned `recorded` from `false` to
 * `true` ({@link ReviewDecisionRecords.markRecorded}): the claimant, or a same-decision re-driver
 * after the claimant failed.
 *
 * With no key-value store (`RuntimeComposition.kv` undefined) every claim answers `unfenced` and
 * resolution proceeds as it did before this record existed, fenced only by each process's own
 * in-memory guards.
 *
 * Retention: nothing sweeps decision records, as nothing sweeps AG-UI leases. They are small and
 * bounded by the number of reviews.
 *
 * @module review-decision-record
 */

import { sha256HexSync } from '@lostgradient/cryptography';
import { type ConditionalTextValueStore, encodeStorageKeyComponent } from '@lostgradient/storage';

import { canonicalJson } from './command-ledger';
import { withoutCiphertext } from './secret-answers';
import type { ResolveReviewInput } from './types';

export const REVIEW_DECISION_KEY_PREFIX = 'review-decision:v1';

/** Weft refuses a `signalId` longer than this many UTF-8 bytes; the key component shares it. */
const MAXIMUM_BOUNDED_ID_BYTES = 128;
const textEncoder = new TextEncoder();

/** Bounds the compare-and-swap loops against resolvers racing for one record. */
const MAXIMUM_ATTEMPTS = 8;

/**
 * A review id bounded to 128 UTF-8 bytes: the id itself when it fits, and otherwise a fixed-length
 * hash prefixed by the review's kind (`human-wait:sha256:<hex>`, `approval:sha256:<hex>`). The
 * review id embeds a model-chosen signal name or call id, so it can be arbitrarily long.
 * Deterministic, so every process and every retry derives the same value. For a human wait it is
 * the id the decision is delivered to Weft under (`humanWaitDeliveryId`).
 */
export function boundedReviewId(reviewId: string, kind: 'human-wait' | 'approval'): string {
  if (textEncoder.encode(reviewId).byteLength <= MAXIMUM_BOUNDED_ID_BYTES) return reviewId;
  return `${kind}:sha256:${sha256HexSync(reviewId)}`;
}

export function reviewDecisionKey(reviewId: string, round: number): string {
  return `${reviewDecisionKeyPrefix(reviewId)}${String(round)}`;
}

/** The prefix of every round's decision record of one review (COR-1934: a chat delete removes them). */
export function reviewDecisionKeyPrefix(reviewId: string): string {
  const kind = reviewId.startsWith('approval:') ? 'approval' : 'human-wait';
  return `${REVIEW_DECISION_KEY_PREFIX}:${encodeStorageKeyComponent(boundedReviewId(reviewId, kind))}:`;
}

/**
 * SHA-256 of the canonical JSON of what a decision delivers; `undefined` digests as `null`. A
 * sealed secret answer digests as its `{ secretRef }` (COR-1920): sealing draws a fresh IV, so a
 * digest of the ciphertext would make a same-decision retry a conflict, and a digest of the
 * plaintext would keep something a guess could be checked against.
 */
export function digestReviewDelivery(value: unknown): string {
  return sha256HexSync(canonicalJson(value === undefined ? null : withoutCiphertext(value)));
}

/** What a resolver asks to record. */
export type ReviewDecisionRequest = {
  readonly reviewId: string;
  readonly round: number;
  readonly decision: ResolveReviewInput['decision'];
  readonly principal: string;
  readonly reason?: string | undefined;
  readonly digest: string;
};

type StoredDecision = {
  readonly decision: string;
  readonly principal: string;
  readonly reason?: string;
  readonly digest: string;
  readonly recorded: boolean;
};

export type ReviewDecisionClaim =
  /** This caller wrote the record; `value` is the exact text, for a later release. */
  | { readonly outcome: 'claimed'; readonly value: string }
  /** An equal decision already holds the record. */
  | { readonly outcome: 'same'; readonly recorded: boolean }
  /** A different decision holds the record (or it is unreadable): the caller is refused. */
  | { readonly outcome: 'conflict'; readonly decision: string | undefined }
  /** No key-value store: nothing is fenced across processes. */
  | { readonly outcome: 'unfenced' };

export type ReviewDecisionRecords = {
  claim(request: ReviewDecisionRequest): Promise<ReviewDecisionClaim>;
  /** Deletes the record this caller claimed, if it is still exactly what the claim wrote. */
  release(request: ReviewDecisionRequest, value: string): Promise<void>;
  /**
   * Turns an equal record's `recorded` from `false` to `true`. Resolves `true` only for the caller
   * whose swap made that change, which is the one that writes the audit entry. With no key-value
   * store it resolves `true`: every resolution records, as before.
   */
  markRecorded(request: ReviewDecisionRequest): Promise<boolean>;
};

function serialize(request: ReviewDecisionRequest, recorded: boolean): string {
  return JSON.stringify({
    decision: request.decision,
    principal: request.principal,
    ...(request.reason === undefined ? {} : { reason: request.reason }),
    digest: request.digest,
    recorded,
  } satisfies StoredDecision);
}

function parse(raw: string): StoredDecision | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return undefined;
    const record = value as Record<string, unknown>;
    if (
      typeof record['decision'] !== 'string' ||
      typeof record['principal'] !== 'string' ||
      typeof record['digest'] !== 'string' ||
      typeof record['recorded'] !== 'boolean' ||
      (record['reason'] !== undefined && typeof record['reason'] !== 'string')
    ) {
      return undefined;
    }
    return value as StoredDecision;
  } catch {
    return undefined;
  }
}

function isSameDecision(stored: StoredDecision, request: ReviewDecisionRequest): boolean {
  return (
    stored.decision === request.decision &&
    stored.principal === request.principal &&
    stored.reason === request.reason &&
    stored.digest === request.digest
  );
}

export function createReviewDecisionRecords(
  kv: ConditionalTextValueStore | undefined,
): ReviewDecisionRecords {
  if (kv === undefined) {
    return {
      claim: () => Promise.resolve({ outcome: 'unfenced' }),
      release: () => Promise.resolve(),
      markRecorded: () => Promise.resolve(true),
    };
  }
  return {
    async claim(request) {
      const key = reviewDecisionKey(request.reviewId, request.round);
      for (let attempt = 0; attempt < MAXIMUM_ATTEMPTS; attempt += 1) {
        const stored = await kv.get(key);
        if (stored === null) {
          const value = serialize(request, false);
          const taken = await kv.conditionalBatch(
            [{ key, expectedValue: null }],
            [{ type: 'set', key, value }],
          );
          if (taken) return { outcome: 'claimed', value };
          continue;
        }
        const held = parse(stored);
        if (held === undefined) return { outcome: 'conflict', decision: undefined };
        return isSameDecision(held, request)
          ? { outcome: 'same', recorded: held.recorded }
          : { outcome: 'conflict', decision: held.decision };
      }
      return { outcome: 'conflict', decision: undefined };
    },
    async release(request, value) {
      const key = reviewDecisionKey(request.reviewId, request.round);
      await kv.conditionalBatch([{ key, expectedValue: value }], [{ type: 'delete', key }]);
    },
    async markRecorded(request) {
      const key = reviewDecisionKey(request.reviewId, request.round);
      for (let attempt = 0; attempt < MAXIMUM_ATTEMPTS; attempt += 1) {
        const stored = await kv.get(key);
        const held = stored === null ? undefined : parse(stored);
        if (stored === null || held === undefined) return false;
        if (held.recorded || !isSameDecision(held, request)) return false;
        const turned = await kv.conditionalBatch(
          [{ key, expectedValue: stored }],
          [{ type: 'set', key, value: serialize(request, true) }],
        );
        if (turned) return true;
      }
      return false;
    },
  };
}
