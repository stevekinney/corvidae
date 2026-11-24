/**
 * The Bureau's review operations as the browser calls them: `bureau.reviews.list`, `.get` and
 * `.resolve`, through the generated client. A review is what a run is waiting on a person for,
 * either a tool approval or a question (a human wait). Their wire shapes are in
 * `packages/bureau/src/http/bureau-reviews-operations.ts`.
 */
import { HttpClientError } from '@lostgradient/weft';

import { bureauClient, type BureauOutput, type WithUndefined } from './bureau-api.ts';
import { CATALOG_OPERATION_BEHAVIORS } from './generated/operation-behaviors.generated.ts';

/**
 * Where a person decided a tool approval: `chat`, the chat that asked, or `reviews`, the Reviews
 * page (COR-2292). It is what the receipt names, and it grants nothing.
 */
export type ApprovalDecisionSurface = 'chat' | 'reviews';

/** One item of `bureau.reviews.list`: a Bureau review or an engine review. */
export type ListedReview = WithUndefined<BureauOutput<'bureau.reviews.list'>['reviews'][number]>;
/**
 * A workflow review of the durable engine, listed beside the Bureau's own (`source: 'engine'`).
 * It keeps the engine's words: `pending` or `completed`, and a decision of `approved`, `rejected`
 * or `needs-changes`.
 */
export type EngineReview = Extract<ListedReview, { readonly kind: 'engine-review' }>;
/**
 * A review waiting on a person: either a tool approval or a human wait. A secret answer is only
 * ever a reference (`secretRefs`) and the answer a digest; the value is never sent.
 */
export type BureauReview = WithUndefined<BureauOutput<'bureau.reviews.get'>>;
/** A review that asks whether a gated tool call may run. */
export type BureauToolApproval = Extract<BureauReview, { readonly kind: 'tool-approval' }>;
/** A review that asks a person for the input a run is parked on. */
export type BureauHumanWait = Extract<BureauReview, { readonly kind: 'human-wait' }>;

/**
 * A review as a stand-in that leaves off where it comes from has it: the Bureau's own. The Bureau
 * always says `bureau`, so this default belongs to the browser, applied to the typed result.
 */
export function reviewWithSource<Review extends ListedReview>(review: Review): Review {
  return review.kind === 'engine-review' ? review : { ...review, source: 'bureau' };
}

type Options = { readonly signal?: AbortSignal };

/** What `bureau.reviews.list` filters and pages by. */
export type ReviewsQuery = {
  /** `pending` (the default) or `resolved`, the reviews a person decided. */
  readonly status?: 'pending' | 'resolved';
  /** With `resolved`: only those decided at or after this instant, in epoch milliseconds. */
  readonly resolvedAfter?: number;
  /** The most reviews in one page, from 1 to 100; the Bureau's default is 50. */
  readonly limit?: number;
  /** The `nextPageToken` of the previous page, for the same `status` and `resolvedAfter`. */
  readonly pageToken?: string;
};

/**
 * One page of the merged review list (`bureau.reviews.list`): the Bureau's reviews and, for a caller
 * who may read the engine's, its workflow reviews, in one order. Pending ones run oldest request
 * first; resolved ones, latest decision first. `nextPageToken` is `null` on the last page, and a
 * stand-in that leaves it off ends the list.
 */
export async function pageReviews(
  query: ReviewsQuery = {},
  options?: Options,
): Promise<{
  readonly reviews: readonly ListedReview[];
  readonly nextPageToken: string | null;
  /**
   * How many reviews the whole listing holds for these filters, on every page (COR-2426); `null`
   * from a Bureau that predates it, where a count is of the reviews read so far.
   */
  readonly total: number | null;
}> {
  const page = await bureauClient['bureau.reviews.list'](query, options);
  const nextPageToken: string | null | undefined = page.nextPageToken;
  const total: number | null | undefined = page.total;
  return {
    reviews: page.reviews.map(reviewWithSource),
    nextPageToken: nextPageToken ?? null,
    total: total ?? null,
  };
}

/**
 * The reviews waiting for a decision, from the caller's own runs (`bureau.reviews.list`), every
 * page of them. The engine's workflow reviews are left out: the Reviews screen reads those itself.
 */
export async function listBureauReviews(options?: Options): Promise<readonly BureauReview[]> {
  const reviews: BureauReview[] = [];
  let pageToken: string | undefined;
  do {
    const page = await pageReviews(pageToken === undefined ? {} : { pageToken }, options);
    for (const review of page.reviews) if (review.source === 'bureau') reviews.push(review);
    pageToken = page.nextPageToken ?? undefined;
  } while (pageToken !== undefined);
  return reviews;
}

/**
 * Every review waiting on the caller, the Bureau's and (for a caller who may read them) the engine's
 * workflow reviews, in the order the list gives them: the longest waiting first. Every page of them.
 */
export async function listPendingReviews(options?: Options): Promise<readonly ListedReview[]> {
  const reviews: ListedReview[] = [];
  let pageToken: string | undefined;
  do {
    const page = await pageReviews(
      { status: 'pending', ...(pageToken === undefined ? {} : { pageToken }) },
      options,
    );
    reviews.push(...page.reviews);
    pageToken = page.nextPageToken ?? undefined;
  } while (pageToken !== undefined);
  return reviews;
}

/** One review by its id, pending or not. One the caller may not see is a not-found fault. */
export async function getBureauReview(id: string, options?: Options): Promise<BureauReview> {
  return reviewWithSource(await bureauClient['bureau.reviews.get']({ id }, options));
}

/** One decision a person can give a review: approve it, deny it, or reject it. */
export type ReviewDecision = 'approve' | 'deny' | 'reject';

/**
 * What the Bureau answers for a decision: the review's identifier and kind, the decision, and
 * whether it was applied, rejected, or superseded (`superseded` means the approval was gated again
 * and stays pending, so the tool did not run).
 */
export type ReviewResolution = BureauOutput<'bureau.reviews.resolve'>;

/**
 * The token in a `Conflict`'s reason when the review had moved to another round than the
 * one sent: a re-gated approval keeps its id, so the decision was made on a request that is no longer
 * the one pending, and nothing was decided (`bureau.reviews.resolve`'s description).
 */
export const REVIEW_ROUND_CHANGED =
  CATALOG_OPERATION_BEHAVIORS['bureau.reviews.resolve'].behavior.conflictReasons[0];

/** Whether a fault says the review changed while it was read, so the decision was not made. */
export function isReviewRoundChanged(error: unknown): boolean {
  if (!(error instanceof HttpClientError)) return false;
  const reason: unknown = error.data?.['reason'];
  return reason === REVIEW_ROUND_CHANGED;
}

/**
 * The token in a `Conflict`'s reason when the review was already resolved with another
 * decision, by another resolver or because the agent moved on: nothing was decided, and it is no
 * longer waiting (COR-2426, `bureau.reviews.resolve`'s description).
 */
export const REVIEW_ALREADY_RESOLVED =
  CATALOG_OPERATION_BEHAVIORS['bureau.reviews.resolve'].behavior.conflictReasons[1];

/**
 * Whether a decision found the review no longer waiting: the Bureau says it was already resolved.
 * A `NotFound` is not this: it also answers a caller who may not decide the review, so the list is
 * read again, and a review that left it is said to be no longer waiting from there.
 */
export function isReviewNoLongerWaiting(error: unknown): boolean {
  if (!(error instanceof HttpClientError)) return false;
  const reason: unknown = error.data?.['reason'];
  return reason === REVIEW_ALREADY_RESOLVED;
}

/**
 * Approves, denies, or rejects a review (`bureau.reviews.resolve`). A rejection needs its reason.
 * `round` is the round of the tool approval the person was shown, which fences the decision on it.
 * `remember` approves a tool approval and allows its tool for the rest of the chat; the Bureau
 * refuses it on a human wait and on a deny or reject. `decisionSurface` says where a tool approval
 * was decided; a caller that cannot say leaves it out, and the Bureau refuses it on a human wait.
 */
export async function resolveBureauReview(
  input: {
    readonly id: string;
    readonly decision: ReviewDecision;
    readonly reason?: string;
    readonly round?: number;
    readonly remember?: boolean;
    readonly decisionSurface?: ApprovalDecisionSurface;
  },
  options?: Options,
): Promise<ReviewResolution> {
  return bureauClient['bureau.reviews.resolve'](input, options);
}
