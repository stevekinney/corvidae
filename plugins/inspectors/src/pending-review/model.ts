/**
 * The pending-review app's view model (COR-910, 2 of 2): what `bureau.reviews.list` and
 * `bureau.reviews.get` answered, reduced to what a reviewer decides on. Pure data in, pure data
 * out, so the rules that matter are tested without a browser: only pending, unexpired reviews offer
 * a decision, and the page never offers a decision the operation would refuse.
 */
import type { ReviewsOperationTypes } from '@lostgradient/bureau-sdk/reviews';

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
  readonly effect?:
    | {
        readonly kind: 'refund';
        readonly orderId: string;
        readonly cents: number;
        readonly currency: 'USD';
        readonly status: string;
      }
    | undefined;
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

export type ActionableReview = Extract<
  ReviewsOperationTypes['bureau.reviews.get']['output'],
  { kind: 'tool-approval' }
>;

/** What the reader sees and may do for one review. */
export type ReviewView = {
  readonly id: string;
  readonly title: string;
  readonly detail: readonly string[];
  readonly round: number;
  readonly expired: boolean;
  /** Whether approve, deny, and reject are offered. */
  readonly decidable: boolean;
  readonly actionableReview?: ActionableReview | undefined;
};

const MAX_ARGUMENT_CHARACTERS = 400;

/** The page size and maximum number of pages read by this panel. */
export const PAGE_LIMIT = 100;
export const MAXIMUM_PAGES = 10;

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
    if (review.effect?.kind === 'refund') {
      const amount = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: review.effect.currency,
      }).format(review.effect.cents / 100);
      const status =
        review.effect.status === 'succeeded'
          ? 'Refunded'
          : review.effect.status === 'needs-reconciliation'
            ? 'Needs reconciliation'
            : review.effect.status === 'provider-pending'
              ? 'Refund pending'
              : review.effect.status === 'failed'
                ? 'Refund failed'
                : review.status === 'approved'
                  ? 'Approved'
                  : 'Awaiting approval';
      detail.push(`${amount} for order ${review.effect.orderId}. ${status}.`);
    }
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
