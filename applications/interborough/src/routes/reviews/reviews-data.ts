/**
 * Query and mutation wiring for the reviews surface. It bridges `getClient()`'s `HttpClient` (the
 * engine's reviews) and the Bureau's operations (`lib/bureau-reviews.ts`, `lib/bureau-tasks.ts`)
 * into TanStack's Svelte 5 reactive query API. Option getters track changing component state, and
 * query effects share the calling component's lifetime.
 *
 * What is waiting on a person is asked again every {@link REVIEW_POLL_MILLISECONDS}, and at once
 * after each decision this application makes (`invalidateReviewQueries`): the navigation's count
 * and the list read the same entries, so they change together.
 */
import type {
  HttpClient,
  ReviewListEntry,
  ReviewStatus,
  SubmitReviewOptions,
} from '@lostgradient/weft';

import {
  createMutation,
  createQuery,
  useQueryClient,
  type CreateMutationResult,
  type CreateQueryResult,
} from '@tanstack/svelte-query';

import {
  listBureauReviews,
  resolveBureauReview,
  type BureauReview,
  type ReviewDecision,
  type ReviewResolution,
} from '../../lib/bureau-reviews.ts';
import { respondToTask, type TaskRespondAnswer } from '../../lib/bureau-tasks.ts';
import { queryKeys } from '../../lib/query.ts';
import { invalidateReviewQueries } from '../../lib/review-queries.ts';

/** How often the list and the count ask what is waiting. */
export const REVIEW_POLL_MILLISECONDS = 5_000;

/**
 * The options of the engine's `reviews.list({status})` query. Only the pending list is polled: a
 * decided review does not change. `enabled` keeps it from asking at all, such as for a principal
 * without `reviews:read`. A component that holds its client as a prop calls this inside the option
 * getter, so the client is read where it can change.
 */
export function weftReviewsQueryOptions(client: HttpClient, status: ReviewStatus, enabled = true) {
  return {
    queryKey: queryKeys.reviews.list({ status }),
    queryFn: () => client.listReviews({ status }),
    enabled,
    ...(status === 'pending' ? { refetchInterval: REVIEW_POLL_MILLISECONDS } : {}),
  };
}

/**
 * Reactive `reviews.list({status})` query of the engine. `status` is read via a getter so the
 * caller can pass a `$derived`/plain field and have the query re-key itself when the active tab
 * changes.
 */
export function reviewListQuery(
  client: HttpClient,
  status: () => ReviewStatus,
  options: { readonly enabled?: () => boolean } = {},
): CreateQueryResult<ReviewListEntry[]> {
  return createQuery(() => weftReviewsQueryOptions(client, status(), options.enabled?.() ?? true));
}

/** The Bureau's pending reviews, asked again every {@link REVIEW_POLL_MILLISECONDS}. */
export function bureauReviewsQuery(): CreateQueryResult<readonly BureauReview[]> {
  return createQuery(() => ({
    queryKey: queryKeys.bureauReviews.list(),
    queryFn: ({ signal }) => listBureauReviews({ signal }),
    refetchInterval: REVIEW_POLL_MILLISECONDS,
    // The poll asks again, so a failure is not retried between polls.
    retry: false,
  }));
}

export interface SubmitReviewDecisionVariables {
  readonly reviewId: string;
  readonly options: SubmitReviewOptions;
}

/**
 * Mutation for `POST /v1/reviews/:reviewId/decision` of the engine. On success it asks every review
 * list again: a decision moves a review from the `pending` list to the `completed` one, so both are
 * stale whichever state the decision was submitted from.
 *
 * `SubmitReviewOptions.sectionDecisions` is included in every submission this module builds
 * (`review-decision-form.svelte` populates it). It round-trips as of `@lostgradient/weft@0.12.0`
 * (https://github.com/stevekinney/weft/issues/724, fixed upstream #731): before that,
 * `submitReviewDecisionOperation` silently dropped the field server-side for both transports.
 */
export function submitReviewDecisionMutation(
  client: HttpClient,
): CreateMutationResult<void, Error, SubmitReviewDecisionVariables> {
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: ({ reviewId, options }: SubmitReviewDecisionVariables) =>
      client.submitReview(reviewId, options),
    onSuccess: () => {
      void invalidateReviewQueries(queryClient);
    },
  }));
}

export interface ResolveBureauReviewVariables {
  readonly id: string;
  readonly decision: ReviewDecision;
  readonly reason?: string;
}

/**
 * Mutation for `bureau.reviews.resolve`. Whether the decision took effect or lost a race, the lists
 * are asked again at once, because either way the review is not what they last showed.
 */
export function resolveBureauReviewMutation(): CreateMutationResult<
  ReviewResolution,
  Error,
  ResolveBureauReviewVariables
> {
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: (variables: ResolveBureauReviewVariables) => resolveBureauReview(variables),
    onSettled: () => {
      void invalidateReviewQueries(queryClient);
    },
  }));
}

export interface AnswerHumanWaitVariables {
  readonly taskId: string;
  readonly answer: string;
  readonly signalName: string;
}

/** Mutation for `bureau.tasks.respond`, which answers a question a run is parked on. */
export function answerHumanWaitMutation(): CreateMutationResult<
  TaskRespondAnswer,
  Error,
  AnswerHumanWaitVariables
> {
  const queryClient = useQueryClient();

  return createMutation(() => ({
    mutationFn: (variables: AnswerHumanWaitVariables) =>
      // One identifier per answer sent: a retry of the same answer is the Bureau's to deduplicate,
      // and a second answer is a second command.
      respondToTask({ ...variables, messageId: crypto.randomUUID() }),
    onSettled: () => {
      void invalidateReviewQueries(queryClient);
    },
  }));
}
