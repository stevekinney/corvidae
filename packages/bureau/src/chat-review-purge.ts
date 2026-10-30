/**
 * COR-1934 — the records of a deleted chat's reviews, outside the audit trail.
 *
 * A review is asked in a chat's words and decided with an answer, arguments and a free-text
 * reason, and Bureau keeps those in three places besides the audit entries (which are redacted,
 * not removed, by `AuditTrail.redact`):
 *
 * - `bureau-resolved-review:v1:` — the review as it was asked (a tool's arguments, a question's
 *   prompt) with the reason it was decided with;
 * - `review-decision:v1:` — the claim that fences a decision across processes, with its reason;
 * - `bureau-secret-answer:v1:` — the encrypted answers to a question's secret fields.
 *
 * All three go with the chat. A review is found by the run it belongs to: through the review ids
 * the run's audit entries name (a redacted entry keeps the id, so a retry finds them again),
 * through the resolved-review records, which name their run, and through the decision keys that
 * embed the run id; a record found by none of these names no run of the chat.
 */
import {
  type ConditionalTextValueStore,
  tryDecodeStorageKeyComponent,
} from '@lostgradient/storage';

import type { AuditTrail } from './audit-trail';
import { REVIEW_DECISION_KEY_PREFIX, reviewDecisionKeyPrefix } from './review-decision-record';
import { RESOLVED_REVIEW_KEY_PREFIX, resolvedReviewKey } from './resolved-review-record';
import { purgeSecretAnswersOfRuns } from './secret-answers';

/** The most review entries one run's audit trail is asked for; a run asks a handful. */
const MAXIMUM_REVIEW_ENTRIES_PER_RUN = 10_000;

/** What the review purge reaches out to. */
export interface ChatReviewPurgeDependencies {
  readonly kv: ConditionalTextValueStore;
  readonly audit: () => AuditTrail | undefined;
}

/** Whether a review id belongs to one of the runs: the id embeds its run (`approval:<run>:…`). */
function reviewIdBelongsTo(reviewId: string, runIds: ReadonlySet<string>): boolean {
  for (const runId of runIds) {
    if (reviewId.startsWith(`approval:${runId}:`) || reviewId.startsWith(`human-wait:${runId}:`)) {
      return true;
    }
  }
  return false;
}

/**
 * Removes the resolved-review records, the decision records and the secret answers of the given
 * runs' reviews, and answers how many keys it deleted. Idempotent: it lists what is left.
 */
export async function purgeReviewRecords(
  dependencies: ChatReviewPurgeDependencies,
  runIds: ReadonlySet<string>,
): Promise<number> {
  const { kv } = dependencies;
  if (runIds.size === 0) return 0;
  const reviewIds = new Set<string>();
  const audit = dependencies.audit();
  for (const runId of runIds) {
    const entries =
      (await audit?.query({
        runId,
        filter: (entry) => entry.type.startsWith('review.'),
        limit: MAXIMUM_REVIEW_ENTRIES_PER_RUN,
      })) ?? [];
    for (const entry of entries) {
      const review: unknown =
        typeof entry.detail === 'object' && entry.detail !== null
          ? Reflect.get(entry.detail, 'review')
          : undefined;
      const id: unknown =
        typeof review === 'object' && review !== null ? Reflect.get(review, 'id') : undefined;
      if (typeof id === 'string') reviewIds.add(id);
    }
  }
  // A resolved-review record names its run, so one the audit trail no longer names is found too.
  for (const key of await kv.list(RESOLVED_REVIEW_KEY_PREFIX)) {
    const raw = await kv.get(key);
    if (raw === null) continue;
    let record: unknown;
    try {
      record = JSON.parse(raw);
    } catch {
      continue;
    }
    const review: unknown =
      typeof record === 'object' && record !== null ? Reflect.get(record, 'review') : undefined;
    const reviewId: unknown =
      typeof review === 'object' && review !== null ? Reflect.get(review, 'id') : undefined;
    const reviewRun: unknown =
      typeof review === 'object' && review !== null ? Reflect.get(review, 'runId') : undefined;
    if (typeof reviewId === 'string' && typeof reviewRun === 'string' && runIds.has(reviewRun)) {
      reviewIds.add(reviewId);
    }
  }
  let deleted = 0;
  for (const reviewId of reviewIds) {
    const resolvedKey = resolvedReviewKey(reviewId);
    if ((await kv.get(resolvedKey)) !== null) {
      await kv.delete(resolvedKey);
      deleted += 1;
    }
    for (const key of await kv.list(reviewDecisionKeyPrefix(reviewId))) {
      await kv.delete(key);
      deleted += 1;
    }
  }
  // A decision key embeds its review id unless the id was too long, which the lists above name.
  for (const key of await kv.list(`${REVIEW_DECISION_KEY_PREFIX}:`)) {
    const encoded = key.slice(REVIEW_DECISION_KEY_PREFIX.length + 1, key.lastIndexOf(':'));
    const reviewId = tryDecodeStorageKeyComponent(encoded);
    if (reviewId === null || !reviewIdBelongsTo(reviewId, runIds)) continue;
    await kv.delete(key);
    deleted += 1;
  }
  deleted += await purgeSecretAnswersOfRuns(kv, runIds);
  return deleted;
}
