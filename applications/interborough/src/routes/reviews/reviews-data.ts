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
  createInfiniteQuery,
  createMutation,
  createQuery,
  useQueryClient,
  type CreateInfiniteQueryResult,
  type CreateMutationResult,
  type CreateQueryResult,
  type InfiniteData,
} from '@tanstack/svelte-query';

import { useBureauEventsLive, useFleetEventsLive } from '../../app/live-polling.svelte.ts';
import { showFault } from '../../app/toast-host.svelte';
import {
  isReviewNoLongerWaiting,
  listBureauReviews,
  listPendingReviews,
  pageReviews,
  type BureauReview,
  type ListedReview,
} from '../../lib/bureau-reviews.ts';
import { respondToTask, type TaskRespondAnswer } from '../../lib/bureau-tasks.ts';
import { faultTreatment } from '../../lib/faults.ts';
import { queryKeys } from '../../lib/query.ts';
import { invalidateReviewQueries } from '../../lib/review-queries.ts';

/** How often the list and the count ask what is waiting, while the feed that carries it is not live. */
export const REVIEW_POLL_MILLISECONDS = 5_000;

/**
 * The options of the engine's `reviews.list({status})` query. Only the pending list is polled: a
 * decided review does not change. It is polled only while the fleet feed is not live
 * (`fleetLive`, from `useFleetEventsLive`), because a `human-review:*` frame asks it again
 * otherwise. `enabled` keeps it from asking at all, such as for a principal without `reviews:read`.
 * A component that holds its client as a prop calls this inside the option getter, so the client is
 * read where it can change.
 */
export function weftReviewsQueryOptions(
  client: HttpClient,
  status: ReviewStatus,
  enabled = true,
  fleetLive = false,
) {
  return {
    queryKey: queryKeys.reviews.list({ status }),
    queryFn: () => client.listReviews({ status }),
    enabled,
    // poll-reason: fallback
    ...(status === 'pending' && !fleetLive ? { refetchInterval: REVIEW_POLL_MILLISECONDS } : {}),
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
  const fleetLive = useFleetEventsLive();
  return createQuery(() =>
    weftReviewsQueryOptions(client, status(), options.enabled?.() ?? true, fleetLive()),
  );
}

/**
 * The Bureau's pending reviews, asked again when `bureau.events` reports a review, and every
 * {@link REVIEW_POLL_MILLISECONDS} while that feed is not live. Call it while a component initializes.
 */
export function bureauReviewsQuery(): CreateQueryResult<readonly BureauReview[]> {
  const bureauLive = useBureauEventsLive();
  return createQuery(() => ({
    queryKey: queryKeys.bureauReviews.list(),
    queryFn: ({ signal }) => listBureauReviews({ signal }),
    // poll-reason: fallback
    refetchInterval: bureauLive() ? false : REVIEW_POLL_MILLISECONDS,
    // The poll (or the next event) asks again, so a failure is not retried in between.
    retry: false,
  }));
}

/** How many decided reviews the Done tab reads at a time. */
export const DONE_PAGE_SIZE = 25;

/**
 * Everything waiting on the person, the Bureau's questions and approvals and the engine's workflow
 * reviews, in one list from `bureau.reviews.list`, the longest waiting first. It is asked again when
 * either feed reports a review (a decision asks too), and every {@link REVIEW_POLL_MILLISECONDS}
 * while either feed is not live. Call it while a component initializes.
 */
export function waitingReviewsQuery(
  options: { readonly enabled?: () => boolean } = {},
): CreateQueryResult<readonly ListedReview[]> {
  const bureauLive = useBureauEventsLive();
  const fleetLive = useFleetEventsLive();
  return createQuery(() => ({
    queryKey: queryKeys.reviews.inbox('pending'),
    queryFn: ({ signal }) => listPendingReviews({ signal }),
    enabled: options.enabled?.() ?? true,
    // poll-reason: fallback
    refetchInterval: bureauLive() && fleetLive() ? false : REVIEW_POLL_MILLISECONDS,
    // This query is shared by the shell and the page. A newly mounted observer reads the same
    // failure; the next poll, event or explicit retry still asks the Bureau again.
    retry: false,
    retryOnMount: false,
    refetchOnMount: false,
  }));
}

/**
 * The reviews a person decided, latest decision first, a page at a time. `enabled` keeps the Done
 * tab from asking until it is opened. Call it while a component initializes.
 */
export function doneReviewsQuery(
  enabled: () => boolean,
): CreateInfiniteQueryResult<InfiniteData<Awaited<ReturnType<typeof pageReviews>>, string | null>> {
  return createInfiniteQuery(() => ({
    queryKey: queryKeys.reviews.inbox('resolved'),
    queryFn: ({ pageParam, signal }) =>
      pageReviews(
        {
          status: 'resolved',
          limit: DONE_PAGE_SIZE,
          ...(pageParam === null ? {} : { pageToken: pageParam }),
        },
        { signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextPageToken ?? undefined,
    enabled: enabled(),
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

export interface AnswerHumanWaitVariables {
  /** The command's idempotency key, which a retry of the same answer reuses (`PendingCommandKey`). */
  readonly messageId: string;
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
    // The caller holds the key, because a retry after a response that was lost must send the same
    // one: the Bureau answers an exact retry from its ledger and applies nothing twice.
    mutationFn: (variables: AnswerHumanWaitVariables) => respondToTask(variables),
    // A question already answered is said in its place, not as a fault (COR-2426).
    onError: (error) => {
      if (!isReviewNoLongerWaiting(error)) showFault(faultTreatment(error));
    },
    onSettled: () => {
      void invalidateReviewQueries(queryClient);
    },
  }));
}
