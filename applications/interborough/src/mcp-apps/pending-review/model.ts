/**
 * The pending-review app's view model (COR-910, 2 of 2): what `bureau.reviews.list` and
 * `bureau.reviews.get` answered, reduced to what a reviewer decides on. Pure data in, pure data
 * out, so the rules that matter are tested without a browser: only pending, unexpired reviews offer
 * a decision, and the page never offers a decision the operation would refuse.
 */

/** One review as `bureau.reviews.list` answers it. Unknown fields are ignored. */
export type Review = {
  readonly id: string;
  readonly runId: string;
  readonly kind: 'tool-approval' | 'human-wait';
  readonly status: string;
  readonly agentName?: string;
  readonly requestedAt: number;
  readonly round?: number;
  readonly signalName?: string;
  readonly prompt?: string;
  readonly approval?: {
    readonly toolName: string;
    readonly arguments?: unknown;
    readonly reason?: string;
    readonly action?: {
      readonly type: string;
      readonly message?: string;
      readonly risk?: string;
      readonly expiresAt?: string;
      readonly operation?: {
        readonly kind: string;
        readonly command?: string;
        readonly diff?: string;
        readonly filesTouched?: readonly string[];
      };
    };
  };
};

/** What the reader sees and may do for one review. */
export type ReviewView = {
  readonly id: string;
  readonly title: string;
  readonly detail: readonly string[];
  readonly round: number;
  readonly expired: boolean;
  /** Whether approve, deny, and reject are offered. */
  readonly decidable: boolean;
};

const MAX_ARGUMENT_CHARACTERS = 400;

/** Whether `value` is the shape of a review list. */
export function isReviewList(value: unknown): value is { reviews: Review[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'reviews' in value &&
    Array.isArray(value.reviews) &&
    value.reviews.every(
      (review: unknown) =>
        typeof review === 'object' &&
        review !== null &&
        'id' in review &&
        typeof review.id === 'string' &&
        'kind' in review &&
        (review.kind === 'tool-approval' || review.kind === 'human-wait'),
    )
  );
}

/** Whether `value` is one review, as `bureau.reviews.get` answers. */
export function isReview(value: unknown): value is Review {
  return isReviewList({ reviews: [value] });
}

function preview(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? '';
  } catch {
    text = '';
  }
  return text.length > MAX_ARGUMENT_CHARACTERS
    ? `${text.slice(0, MAX_ARGUMENT_CHARACTERS)}... (truncated)`
    : text;
}

/** When the approval can no longer be given, or `undefined` for one that does not expire. */
export function expiryOf(review: Review): number | undefined {
  const stamp = review.approval?.action?.expiresAt;
  if (stamp === undefined) return undefined;
  const parsed = Date.parse(stamp);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Build the view of `review` at time `now`. */
export function viewReview(review: Review, now: number): ReviewView {
  const expiry = expiryOf(review);
  const expired = expiry !== undefined && now >= expiry;
  const agent = review.agentName ?? 'agent';
  const detail: string[] = [`Run ${review.runId}`];
  let title: string;
  if (review.kind === 'tool-approval') {
    title = `${agent} asks to run ${review.approval?.toolName ?? 'a tool'}`;
    const action = review.approval?.action;
    if (action?.type === 'approval') {
      detail.push(`Risk: ${action.risk ?? 'unknown'}`);
      const operation = action.operation;
      if (operation?.command !== undefined) detail.push(`Command: ${operation.command}`);
      // The whole change a reviewer approves: every path and the full patch, never a prefix.
      if (operation?.filesTouched !== undefined && operation.filesTouched.length > 0) {
        detail.push(`Files: ${operation.filesTouched.join(', ')}`);
      }
      if (operation?.diff !== undefined) detail.push(`Patch:\n${operation.diff}`);
      if (action.message !== undefined) detail.push(action.message);
    }
    if (review.approval?.reason !== undefined) {
      detail.push(`Paused because: ${review.approval.reason}`);
    }
    if (review.approval?.arguments !== undefined) {
      detail.push(`Arguments: ${preview(review.approval.arguments)}`);
    }
  } else {
    title = `${agent} is waiting for ${review.signalName ?? 'an answer'}`;
    if (review.prompt !== undefined) detail.push(review.prompt);
    detail.push(
      'This wait needs an answer. Reply to it through its task; it cannot be approved here.',
    );
  }
  if (expiry !== undefined) {
    detail.push(expired ? 'Expired' : `Expires ${new Date(expiry).toISOString()}`);
  }
  return {
    id: review.id,
    title,
    detail,
    round: review.round ?? 0,
    expired,
    // A human wait needs the answer it asks for, which `bureau.reviews.resolve` cannot carry: it is
    // shown, and answered through the task, never approved from here.
    decidable: review.kind === 'tool-approval' && review.status === 'pending' && !expired,
  };
}

/** A review's status in words, for a decision that was not made because it is no longer pending. */
export function describeStatus(status: string): string {
  switch (status) {
    case 'pending':
      return 'still pending';
    case 'approved':
    case 'denied':
    case 'rejected':
      return `already ${status}`;
    case 'expired':
      return 'expired';
    case 'canceled':
      return 'canceled with its run';
    case 'superseded':
      return 'replaced by a newer approval';
    case 'revoked':
      return 'revoked';
    default:
      return status;
  }
}

/** The token `bureau.reviews.resolve` puts in a Conflict whose decision took effect but whose outcome was not written. */
export const OUTCOME_NOT_WRITTEN = 'APPROVAL_OUTCOME_NOT_WRITTEN';

/** Whether an error result from `resolve` says the decision took effect and only recording it failed. */
export function isOutcomeNotWritten(result: unknown): boolean {
  try {
    return JSON.stringify(result)?.includes(OUTCOME_NOT_WRITTEN) ?? false;
  } catch {
    return false;
  }
}

/** What a decision's receipt tells the reader. */
export function describeResolution(
  decision: 'approve' | 'deny' | 'reject',
  receipt: string,
): string {
  if (receipt === 'superseded') {
    return 'The approval was gated again and is still pending. Review the new request.';
  }
  if (decision === 'approve') return 'Approved.';
  return decision === 'deny' ? 'Denied.' : 'Rejected with feedback.';
}
