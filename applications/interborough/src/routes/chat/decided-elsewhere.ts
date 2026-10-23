/**
 * Which of the reviews a chat shows have been decided somewhere else. The Bureau lists what is
 * pending; a review that is not in the list is either decided or not yet raised, and only one this
 * page has seen pending can be called decided. The list is shared with the navigation's count and
 * cached, so a read can predate a review the page itself has just raised (a chat that started the
 * run), and treating its absence as a decision would take the call as settled, record it, and skip
 * the real decision later.
 */
import type { BureauReview } from '../../lib/bureau-reviews.ts';

/** What a read of the pending reviews shows to be decided. */
export type DecidedReviews = {
  /** The tool calls whose approval was pending and is not any longer. */
  readonly calls: readonly string[];
  /** The questions that were pending and are not any longer, by review identifier. */
  readonly questions: readonly string[];
};

/** The reviews this page has seen pending, for as long as the chat waits on a person. */
export class SeenReviews {
  readonly #calls = new Set<string>();
  readonly #questions = new Set<string>();

  /**
   * Takes one read of the session's pending reviews. `shownCalls` are the calls whose approvals the
   * chat shows, and `questionOpen` says whether it shows a question; a review the chat does not show
   * is never reported.
   */
  observe(
    pending: readonly BureauReview[],
    shown: { readonly shownCalls: readonly string[]; readonly questionOpen: boolean },
  ): DecidedReviews {
    const pendingCalls = new Set<string>();
    const pendingQuestions = new Set<string>();
    for (const review of pending) {
      if (review.kind === 'tool-approval') pendingCalls.add(review.approval.callId);
      else pendingQuestions.add(review.id);
    }
    for (const callId of pendingCalls) this.#calls.add(callId);
    for (const id of pendingQuestions) this.#questions.add(id);
    return {
      calls: shown.shownCalls.filter(
        (callId) => this.#calls.has(callId) && !pendingCalls.has(callId),
      ),
      questions: shown.questionOpen
        ? [...this.#questions].filter((id) => !pendingQuestions.has(id))
        : [],
    };
  }

  /** Stops watching reviews the thread has been read for. */
  forget(decided: DecidedReviews): void {
    for (const callId of decided.calls) this.#calls.delete(callId);
    for (const id of decided.questions) this.#questions.delete(id);
  }

  /** Forgets everything seen: the wait it belonged to is over. */
  clear(): void {
    this.#calls.clear();
    this.#questions.clear();
  }
}

/** A key naming a set of decided reviews, so each set is read once. Empty when none is decided. */
export function decidedKey(decided: DecidedReviews): string {
  return [...decided.calls, ...decided.questions].join('|');
}
