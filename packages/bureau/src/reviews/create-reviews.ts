import type { BureauReviews, PendingReview } from '../types.ts';

/**
 * What {@link createReviews} composes `bureau.reviews` from: the Bureau's own implementations,
 * which share its run, session, and audit state and so are built where that state lives.
 */
export type ReviewsDependencies = {
  /** The reviews of the sessions this process holds (tool approvals and session human waits). */
  readonly listSessionReviews: () => PendingReview[];
  /**
   * The human waits of the sessionless runs this process holds (COR-1577). They join the
   * session reviews in {@link BureauReviews.list}.
   */
  readonly listRunHumanWaits: () => PendingReview[];
  /** {@link BureauReviews.listResolved}. */
  readonly listResolved: BureauReviews['listResolved'];
  /** {@link BureauReviews.get}. */
  readonly get: BureauReviews['get'];
  /** {@link BureauReviews.pendingOf}. */
  readonly pendingOf: BureauReviews['pendingOf'];
  /**
   * {@link BureauReviews.resolve}: a park this process does not hold is derived from durable
   * state and resolved all the same, fenced by the durable decision record (COR-1579).
   */
  readonly resolve: BureauReviews['resolve'];
};

/**
 * Build `bureau.reviews`. `list` joins the session reviews with the run human waits, in that
 * order; the other three operations are the Bureau's own, unchanged.
 */
export function createReviews(dependencies: ReviewsDependencies): BureauReviews {
  return {
    list: (): PendingReview[] => [
      ...dependencies.listSessionReviews(),
      ...dependencies.listRunHumanWaits(),
    ],
    listResolved: dependencies.listResolved,
    get: dependencies.get,
    pendingOf: dependencies.pendingOf,
    resolve: dependencies.resolve,
  };
}
