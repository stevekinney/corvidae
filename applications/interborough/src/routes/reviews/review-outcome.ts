import type { ChatQuestionIssue } from '@lostgradient/chat';

/** A decision or an answer that did not simply take effect, and why. */
export interface ReviewOutcome {
  /** The review it is about, so it is shown with that review and not beside another. */
  readonly reviewId: string;
  readonly tone: 'danger' | 'warning';
  readonly title: string;
  readonly message: string;
  /** For an answer the Bureau refused for reasons the person can fix: shown on the fields they name. */
  readonly issues?: readonly ChatQuestionIssue[];
}
