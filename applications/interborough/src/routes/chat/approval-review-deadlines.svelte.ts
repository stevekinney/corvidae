/**
 * The approval deadlines the chat reads back from the Bureau's reviews (COR-2280 P7): for each
 * approval row, `bureau.reviews.get` says whether it is still pending (and until when) or expired.
 *
 * A read is authoritative only for the run, call and round it was made for, and only while the
 * read that asked for it is current:
 *
 * - Generation: every change of the pending-review poll starts a new generation of reads. A read
 *   that answers after a newer generation began is dropped, so a slow, older answer cannot write
 *   over a newer one.
 * - Round: a re-gated approval keeps its review id and advances its round. A pending read from a
 *   round at or below the last terminal (expired) round is an older request resolving late and
 *   cannot bring the deadline back; only a strictly newer round is a renewed approval, which clears
 *   the old expiry. An observed pending deadline is replaced only by one from the same or a newer
 *   round.
 * - Key: each row's key carries its run, its raw call id, its row and its round, so two runs that
 *   reuse a call id keep their own deadlines.
 *
 * An expired review also says when the displayed clock must have reached: the marker is clamped to
 * the Bureau's now, and the same observation is handed back so the rail's clock is advanced with
 * it, rather than left at the tick from before the approval stopped being live.
 */
import type { BureauReview } from '../../lib/bureau-reviews.ts';

/** One approval row the chat asks the Bureau about. */
export type ApprovalReviewCandidate = {
  /** The call the row answers, as the transcript names it. */
  readonly callId: string;
  /** The call as the provider named it, which the review records. */
  readonly rawCallId: string;
  readonly rowId: string;
  /** The review the row's approval is, `approval:<run>:<raw call>`. */
  readonly reviewId: string;
  readonly runId: string;
  /** The row's identity for one round: run, raw call, row and round. */
  readonly key: string;
};

/** What a read changed, for the caller to carry into the session and the rail's clock. */
export type ApprovalReviewOutcome = {
  /** The deadline to import into the session for this call. */
  readonly reconcile: { readonly toolCallId: string; readonly expiresAt: string };
  /** The Bureau's now the expiry was clamped to, which the displayed clock must reach. */
  readonly clockAt?: number | undefined;
};

export class ApprovalReviewDeadlines {
  /** Expired approvals, by row key: when, on the Bureau's clock, as an ISO time. */
  expired = $state<Record<string, string>>({});
  /** Pending deadlines read back, by row key, with the round they were read for. */
  observed = $state<Record<string, { readonly expiresAt: string; readonly round: number }>>({});

  #generation = 0;
  readonly #reading = new Set<string>();
  readonly #terminalRounds = new Map<string, number>();
  readonly #keyByIdentity = new Map<string, string>();

  /** The current generation. */
  get generation(): number {
    return this.#generation;
  }

  /**
   * Starts a new generation of reads for the rows as they are now. A row whose key moved (its
   * round advanced, its row was re-read) carries its expiry and its terminal round to the new key.
   */
  begin(candidates: readonly ApprovalReviewCandidate[]): number {
    const generation = ++this.#generation;
    for (const candidate of candidates) {
      const identity = `${candidate.reviewId}:${candidate.rowId}`;
      const previousKey = this.#keyByIdentity.get(identity);
      if (previousKey !== undefined && previousKey !== candidate.key) {
        const previousExpiry = this.expired[previousKey];
        if (previousExpiry !== undefined && this.expired[candidate.key] === undefined) {
          this.expired = { ...this.expired, [candidate.key]: previousExpiry };
        }
        const previousTerminalRound = this.#terminalRounds.get(previousKey);
        if (previousTerminalRound !== undefined) {
          this.#terminalRounds.set(candidate.key, previousTerminalRound);
        }
      }
      this.#keyByIdentity.set(identity, candidate.key);
    }
    return generation;
  }

  /** Claims the read of a row, or `false` when one is already under way for it. */
  claim(key: string): boolean {
    if (this.#reading.has(key)) return false;
    this.#reading.add(key);
    return true;
  }

  /** Releases a row's read, answered, failed or abandoned. */
  release(key: string): void {
    this.#reading.delete(key);
  }

  /**
   * Applies what the Bureau said of a row's review, read in `generation`, at the Bureau's `now`.
   * Returns what to import, or `undefined` when the read was fenced off or changed nothing.
   */
  apply(
    candidate: ApprovalReviewCandidate,
    review: BureauReview,
    generation: number,
    now: number,
  ): ApprovalReviewOutcome | undefined {
    if (generation !== this.#generation) return undefined;
    if (
      review.kind !== 'tool-approval' ||
      review.runId !== candidate.runId ||
      review.approval.callId !== candidate.rawCallId
    ) {
      return undefined;
    }
    const terminalRound = this.#terminalRounds.get(candidate.key) ?? -1;
    if (review.status === 'pending') {
      // A pending read from the terminal round can be an older request resolving after the
      // terminal review: it must not restore the deadline over the authoritative marker.
      if (review.round <= terminalRound) return undefined;
      if (this.expired[candidate.key] !== undefined) {
        const { [candidate.key]: _renewed, ...rest } = this.expired;
        this.expired = rest;
      }
      const expiresAt =
        review.approval.action.type === 'approval' ? review.approval.action.expiresAt : undefined;
      if (expiresAt === undefined) return undefined;
      if (review.round < (this.observed[candidate.key]?.round ?? -1)) return undefined;
      this.observed = { ...this.observed, [candidate.key]: { expiresAt, round: review.round } };
      return { reconcile: { toolCallId: candidate.callId, expiresAt } };
    }
    if (review.status !== 'expired' || review.round < terminalRound) return undefined;
    // A terminal review is authoritative even when the action's deadline was written on another
    // clock or is still in the future in the transcript: its decision time, no later than now, is
    // the marker.
    const decidedAt = review.resolution?.decidedAt ?? now;
    const expiresAt = new Date(Math.min(decidedAt, now)).toISOString();
    this.expired = { ...this.expired, [candidate.key]: expiresAt };
    const { [candidate.key]: _cleared, ...remaining } = this.observed;
    this.observed = remaining;
    this.#terminalRounds.set(candidate.key, review.round);
    return { reconcile: { toolCallId: candidate.callId, expiresAt }, clockAt: now };
  }
}
