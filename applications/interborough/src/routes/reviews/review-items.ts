/**
 * What `/reviews` lists: the merged list of `bureau.reviews.list`, which holds the Bureau's tool
 * approvals and questions and the engine's workflow reviews together. An item is one of them with a
 * key that is unique across the sources, for selection and keyed rendering. The server orders the
 * list (waiting: the longest first; decided: the latest decision first), and this keeps its order.
 */
import { REVIEWS_COPY } from '../../app/copy.ts';
import type { ListedReview } from '../../lib/bureau-reviews.ts';
import { approvalQuestion, declaredSummary } from '../../lib/tool-text.ts';

/** One review of the inbox, with the key the list selects it by. */
export interface InboxItem {
  /** Unique across both sources: a Bureau review and an engine review may share an identifier. */
  readonly key: string;
  readonly review: ListedReview;
}

/** The key an item is selected by, and the address names it by. */
export function inboxKey(review: Pick<ListedReview, 'source' | 'id'>): string {
  return `${review.source}:${review.id}`;
}

function toItem(review: ListedReview): InboxItem {
  return { key: inboxKey(review), review };
}

/** The reviews still waiting, in the order the list gave them, each once. */
export function waitingItems(reviews: readonly ListedReview[]): InboxItem[] {
  const seen = new Set<string>();
  const items: InboxItem[] = [];
  for (const review of reviews) {
    if (review.status !== 'pending') continue;
    const item = toItem(review);
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    items.push(item);
  }
  return items;
}

/**
 * The reviews a person decided, in the order given, as items. The pages are joined first
 * (`lib/combine-pages.ts`), so a review that two pages both held is listed once.
 */
export function doneItems(reviews: readonly ListedReview[]): InboxItem[] {
  return reviews.filter((review) => review.status !== 'pending').map(toItem);
}

/** The item after the one at `key`, or the one before it when it is last, or `null` when it is alone. */
export function neighbourKey(items: readonly InboxItem[], key: string): string | null {
  const index = items.findIndex((item) => item.key === key);
  if (index === -1) return null;
  return items[index + 1]?.key ?? items[index - 1]?.key ?? null;
}

/** What a review asks, as one sentence: the approval's question, the question's prompt, the engine's type of review. */
export function reviewTitle(review: ListedReview): string {
  if (review.kind === 'tool-approval') {
    return approvalQuestion({
      toolName: review.approval.toolName,
      arguments: review.approval.arguments,
      summary: declaredSummary(review.approval.action.message, review.approval.reason),
    });
  }
  if (review.kind === 'human-wait') return review.prompt ?? REVIEWS_COPY.questionFallback;
  return review.reviewType;
}

/** The label of what kind of review it is. */
export function reviewKindLabel(review: ListedReview): string {
  if (review.kind === 'tool-approval') return REVIEWS_COPY.toolApproval;
  if (review.kind === 'human-wait') return REVIEWS_COPY.humanWait;
  return REVIEWS_COPY.workflowReview;
}

const ENGINE_DECISION_LABELS: Readonly<Record<'approved' | 'rejected' | 'needs-changes', string>> =
  {
    approved: REVIEWS_COPY.decided.approved,
    rejected: REVIEWS_COPY.decided.rejected,
    'needs-changes': REVIEWS_COPY.decided.needsChanges,
  };

/** What became of a review that is no longer waiting, in a word: Approved, Denied, Answered. */
export function resolutionLabel(review: ListedReview): string {
  if (review.kind === 'engine-review') {
    const decision = review.resolution?.decision;
    return decision === undefined ? REVIEWS_COPY.decided.closed : ENGINE_DECISION_LABELS[decision];
  }
  if (review.status === 'pending') return REVIEWS_COPY.decided.waiting;
  if (review.kind === 'human-wait') {
    return review.status === 'approved'
      ? REVIEWS_COPY.decided.answered
      : REVIEWS_COPY.decided.closed;
  }
  switch (review.status) {
    case 'approved':
      return REVIEWS_COPY.decided.approved;
    case 'denied':
      return REVIEWS_COPY.decided.denied;
    case 'rejected':
      return REVIEWS_COPY.decided.rejected;
    default:
      return REVIEWS_COPY.decided.closed;
  }
}
