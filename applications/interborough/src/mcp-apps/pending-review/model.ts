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

/**
 * A workflow review of the durable engine, which `bureau.reviews.list` lists beside the Bureau's own
 * for a caller who may read them (COR-1828). It is answered through the engine, never decided here,
 * so the page keeps only its identity.
 */
export type EngineReview = { readonly id: string; readonly kind: 'engine-review' };

/** One page of `bureau.reviews.list`: its items of either source, and where the next page starts. */
export type ReviewPage = {
  readonly reviews: ReadonlyArray<Review | EngineReview>;
  readonly nextPageToken?: string | null;
};

/** How many reviews one page asks for, the most `bureau.reviews.list` allows. */
export const PAGE_LIMIT = 100;

/**
 * How many pages one refresh follows: with {@link PAGE_LIMIT}, the 1,000 oldest pending reviews. A
 * queue longer than that is shown cut off and says so, rather than reading without end.
 */
export const MAXIMUM_PAGES = 10;

function hasKind(value: unknown, kinds: readonly string[]): value is { id: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'kind' in value &&
    typeof value.kind === 'string' &&
    kinds.includes(value.kind)
  );
}

/** Whether `value` is the shape of a review list page, engine reviews included. */
export function isReviewList(value: unknown): value is ReviewPage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'reviews' in value &&
    Array.isArray(value.reviews) &&
    value.reviews.every((review: unknown) =>
      hasKind(review, ['tool-approval', 'human-wait', 'engine-review']),
    ) &&
    (!('nextPageToken' in value) ||
      value.nextPageToken === null ||
      typeof value.nextPageToken === 'string')
  );
}

/** Whether `value` is one review of the Bureau's own, as `bureau.reviews.get` answers. */
export function isReview(value: unknown): value is Review {
  return hasKind(value, ['tool-approval', 'human-wait']);
}

/** The reviews of `page` this page can show and decide: the Bureau's own, never an engine review. */
export function bureauReviewsOf(page: ReviewPage): Review[] {
  return page.reviews.filter((review): review is Review => review.kind !== 'engine-review');
}

/**
 * Reads the pending queue page by page, oldest first, until no page remains or
 * {@link MAXIMUM_PAGES} have been read. `undefined` is a page that could not be read, so the
 * whole read failed rather than showing a queue with a hole in it.
 */
export async function readPendingQueue(
  readPage: (pageToken: string | undefined) => Promise<ReviewPage | undefined>,
): Promise<{ reviews: Review[]; truncated: boolean } | undefined> {
  const reviews: Review[] = [];
  let pageToken: string | undefined;
  for (let read = 0; read < MAXIMUM_PAGES; read += 1) {
    const page = await readPage(pageToken);
    if (page === undefined) return undefined;
    reviews.push(...bureauReviewsOf(page));
    if (typeof page.nextPageToken !== 'string') return { reviews, truncated: false };
    pageToken = page.nextPageToken;
  }
  return { reviews, truncated: true };
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

/** The token `bureau.reviews.resolve` puts in a Conflict whose review had moved to another round than the one sent. */
export const ROUND_CHANGED = 'REVIEW_ROUND_CHANGED';

/** Whether an error result from `resolve` says the review moved to another round, so nothing was decided. */
export function isRoundChanged(result: unknown): boolean {
  try {
    return JSON.stringify(result)?.includes(ROUND_CHANGED) ?? false;
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
