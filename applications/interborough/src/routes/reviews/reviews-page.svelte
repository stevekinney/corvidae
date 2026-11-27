<script lang="ts">
  /**
   * `/reviews`: everything waiting on the caller in one inbox, the longest waiting first. A tool
   * approval, a question an agent asked and a workflow review are all one list
   * (`bureau.reviews.list`), each answered where it is shown: an approval is approved, denied or
   * allowed for the rest of its chat, a question is answered in the shape it asks for, and a
   * workflow review takes the engine's decision form. Done lists what was decided. This owns the
   * queries and the writes once and hands them down; the segments (Waiting and Done, each with its
   * count, a dash until it is known) are the address (`?tab=done`). Done is read from the start so
   * its count is known, and a decision asks both lists again, so both counts follow it. Done's count
   * is the Bureau's total for the whole list, beyond the 25 a page reads (COR-2426).
   *
   * An approve that finds the review already resolved (the agent moved on, or it was decided
   * elsewhere) says "No longer waiting" in its place, as a review that left the list does (row 26g).
   */
  import { Alert, Button, FilterBar, PageHeader, type FilterSegment } from '@lostgradient/cinder';
  import { createQuery, useQueryClient } from '@tanstack/svelte-query';
  import type { ApprovalOutcome } from '@lostgradient/bureau-sdk/reviews/ui';
  import type { ReviewsOperationTypes } from '@lostgradient/bureau-sdk/reviews';
  import { getReviewsHost, useBureauReviewsList } from '@lostgradient/bureau-sdk/reviews/svelte';
  import { activateResource } from '@lostgradient/backchannel-svelte';
  import { HttpClientError } from '@lostgradient/weft/client';
  import { onMount } from 'svelte';
  import { useBureauEventsLive, useFleetEventsLive } from '../../app/live-polling.svelte.ts';
  import { invalidateReviewQueries } from '../../lib/review-queries.ts';
  import { queryKeys } from '../../lib/query.ts';

  import { REVIEWS_COPY } from '../../app/copy/reviews.ts';
  import {
    isReviewNoLongerWaiting,
    listChatAccessRequests,
    resolveChatAccessRequest,
    type BureauHumanWait,
  } from '../../lib/bureau-reviews.ts';
  import { answerRefusalIssues, taskAnswerText } from '../../lib/bureau-tasks.ts';
  import { getClient } from '../../lib/client.ts';
  import { combinePages } from '../../lib/combine-pages.ts';
  import { faultTreatment } from '../../lib/faults.ts';
  import { createPendingCommandKey } from '../../lib/pending-command-key.ts';
  import { reviewsNavigation } from '../../lib/reviews-navigation.ts';
  import { getPrincipalStore, scopeGate } from '../../lib/scopes.svelte.ts';
  import QueryFaultBanner from './query-fault-banner.svelte';
  import type { ReviewDecisionSubmission } from './review-decision-form.svelte';
  import { doneItems, inboxKey, waitingItems } from './review-items.ts';
  import type { ReviewOutcome } from './review-outcome.ts';
  import {
    answerHumanWaitMutation,
    refreshObservedReviews,
    submitReviewDecisionMutation,
  } from './reviews-data.ts';
  import ReviewsPanel from './reviews-panel.svelte';

  const router = reviewsNavigation();
  const TABS = ['waiting', 'done'] as const;
  type ReviewsTab = (typeof TABS)[number];

  function tabOf(search: URLSearchParams): ReviewsTab {
    const named = search.get('tab');
    return named === 'done' ? 'done' : 'waiting';
  }

  /** The segment the address names. */
  const activeTab = $derived(tabOf(router.search));

  /** Puts a segment the person picked in the address; the open review belongs to one, so it is left behind. */
  function writeTab(next: string): void {
    if (tabOf(router.search) === next) return;
    router.navigate(next === 'waiting' ? router.pathname : `${router.pathname}?tab=${next}`);
  }

  const client = getClient();
  const queryClient = useQueryClient();
  const principalStore = getPrincipalStore();
  const submitGate = $derived(scopeGate(principalStore, ['reviews:write']));
  /** Who the caller is, so what they decided reads "by you". */
  const viewer = $derived(principalStore.principal?.subject ?? undefined);

  const host = getReviewsHost();
  const waitingRead = useBureauReviewsList(host, () => ({ status: 'pending', limit: 100 }));
  const doneRead = useBureauReviewsList(host, () => ({ status: 'resolved', limit: 25 }));
  const waitingOpening = host.opening.get(JSON.stringify({ status: 'pending', limit: 100 }));
  const doneOpening = host.opening.get(JSON.stringify({ status: 'resolved', limit: 25 }));
  const waitingData = $derived(
    waitingRead.data ?? (waitingRead.isInitialLoading ? waitingOpening : undefined),
  );
  const doneData = $derived(doneRead.data ?? (doneRead.isInitialLoading ? doneOpening : undefined));
  const bureauLive = useBureauEventsLive();
  const fleetLive = useFleetEventsLive();
  let loadingMore = $state(false);
  let pendingPageError = $state<unknown>();
  const waitingQuery = {
    get data() {
      return waitingData?.nextPageToken === null ? waitingData.reviews : undefined;
    },
    get isPending() {
      return (
        (waitingData === undefined && waitingRead.isInitialLoading) ||
        (waitingData !== undefined && waitingData.nextPageToken !== null)
      );
    },
    get isError() {
      return (
        waitingRead.initialError != null ||
        waitingRead.refreshError != null ||
        pendingPageError !== undefined
      );
    },
    get error() {
      return waitingRead.initialError ?? waitingRead.refreshError ?? pendingPageError;
    },
    async refetch() {
      pendingPageError = undefined;
      return waitingRead.refresh();
    },
  };
  const doneQuery = {
    get data() {
      return doneData === undefined ? undefined : { pages: [doneData] };
    },
    get isPending() {
      return doneData === undefined && doneRead.isInitialLoading;
    },
    get isError() {
      return doneRead.initialError != null || doneRead.refreshError != null;
    },
    get error() {
      return doneRead.initialError ?? doneRead.refreshError;
    },
    get hasNextPage() {
      return doneData?.nextPageToken != null;
    },
    get isFetchingNextPage() {
      return loadingMore;
    },
    refetch: () => doneRead.refresh(),
    async fetchNextPage() {
      loadingMore = true;
      try {
        await doneRead.loadMore();
      } finally {
        loadingMore = false;
      }
    },
  };
  $effect(() => {
    if (pendingPageError === undefined && waitingRead.data?.nextPageToken != null) {
      void waitingRead.loadMore().catch((error: unknown) => {
        pendingPageError = error;
      });
    }
  });
  $effect(() => {
    const reviews = waitingQuery.data;
    if (reviews !== undefined)
      queryClient.setQueryData(queryKeys.reviews.inbox('pending'), reviews);
  });
  let forwardingApprovalInvalidation = false;
  onMount(() => {
    // poll-reason: fallback
    const timer = setInterval(() => {
      if (!bureauLive() || !fleetLive()) void refreshObservedReviews(waitingQuery.refetch);
    }, 5000);
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (
        event.type === 'updated' &&
        event.action.type === 'invalidate' &&
        event.query.queryKey[0] === 'reviews' &&
        !forwardingApprovalInvalidation
      ) {
        host.invalidate(['bureau.reviews.list']);
      }
    });
    return () => {
      clearInterval(timer);
      unsubscribe();
    };
  });
  const decisionMutation = submitReviewDecisionMutation(client);
  const answerMutation = answerHumanWaitMutation();
  // One key stays with an answer until the Bureau confirms it, so a retry after a lost response is
  // the same command and the Bureau answers it from its ledger.
  const answerKey = createPendingCommandKey();
  const chatRequests = createQuery(
    () => ({
      queryKey: ['chat-access-requests'],
      queryFn: ({ signal }) => listChatAccessRequests({ signal }),
      retry: false,
    }),
    undefined,
  );
  let resolvingChatRequest = $state<string | undefined>();
  // The opaque durable id identifies the exact pending request shown in this row.
  const chatRequestKey = (requestId: string) => requestId;
  async function resolveChatRequest(
    request: import('../../lib/bureau-reviews.ts').ChatAccessRequest,
    decision: 'grant' | 'deny',
  ): Promise<void> {
    if (resolvingChatRequest !== undefined) return;
    resolvingChatRequest = chatRequestKey(request.requestId);
    try {
      await resolveChatAccessRequest(request, decision);
      await queryClient.invalidateQueries({ queryKey: ['contexts'] });
      await chatRequests.refetch();
    } finally {
      resolvingChatRequest = undefined;
    }
  }

  const waiting = $derived(waitingItems(waitingQuery.data ?? []));
  // A review decided while a later page was being read can come on two pages, so the pages are
  // joined through `combinePages`, which lists each once.
  const done = $derived(
    doneItems(
      combinePages(
        doneQuery.data?.pages,
        (page) => page.reviews,
        (review) => inboxKey(review),
      ),
    ),
  );

  function phaseOf(query: {
    isPending: boolean;
    isError: boolean;
    data: unknown;
  }): 'loading' | 'failed' | 'ready' {
    if (query.data !== undefined) return 'ready';
    if (query.isError) return 'failed';
    return query.isPending ? 'loading' : 'ready';
  }

  /** Both lists are read and neither holds a review, nor more pages of one. */
  const nothingAtAll = $derived(
    waitingQuery.data !== undefined &&
      doneQuery.data !== undefined &&
      waiting.length === 0 &&
      done.length === 0 &&
      !doneQuery.hasNextPage,
  );

  /** A query that failed shows the fault banner; a list it still holds is shown beneath it. */
  const faults = $derived<readonly { error: unknown; retry: () => void }[]>(
    (activeTab === 'done' ? [doneQuery] : [waitingQuery])
      .filter((query) => query.isError)
      .map((query) => ({
        error: query.error,
        retry: () => void refreshObservedReviews(query.refetch),
      })),
  );

  /** What became of the last decision or answer on a review, when it did not simply take effect. */
  let outcome = $state<ReviewOutcome | undefined>(undefined);
  /** A decision that took effect but needs saying so: its outcome was not written, or it was not remembered. */
  let notice = $state<{ title: string; message: string } | undefined>(undefined);
  /** The review a decision found already resolved, which the panel says is no longer waiting. */
  let refusedKey = $state<string | null>(null);

  /** A decision found `review` no longer waiting: the panel says so in its place, and both lists are read again. */
  function gone(review: { readonly source: 'bureau'; readonly id: string }): void {
    refusedKey = inboxKey(review);
    void refreshObservedReviews(waitingQuery.refetch, doneQuery.refetch);
  }

  function submitDecision(
    reviewId: string,
    submission: ReviewDecisionSubmission,
    onDone: () => void,
  ): void {
    decisionMutation.mutate(
      {
        reviewId,
        options: {
          decision: submission.decision,
          reviewer: submission.reviewer,
          ...(submission.feedback !== undefined ? { feedback: submission.feedback } : {}),
          ...(submission.sectionDecisions !== undefined
            ? { sectionDecisions: submission.sectionDecisions }
            : {}),
        },
      },
      { onSuccess: onDone },
    );
  }

  /**
   * One segment's count: the number of reviews read, or a dash while the list is not read. A list
   * that failed shows the dash too, because its banner says why and no number is true.
   */
  function segmentCount(query: { data: unknown }, size: number): { count: number | 'pending' } {
    return { count: query.data === undefined ? 'pending' : size };
  }

  const segments = $derived<FilterSegment[]>([
    {
      value: 'waiting',
      label: REVIEWS_COPY.tabs.waiting,
      ...segmentCount(waitingQuery, waiting.length),
    },
    {
      value: 'done',
      label: REVIEWS_COPY.tabs.done,
      // The Bureau's total counts beyond the page read (COR-2426, "Done 13" with 25 loaded); one
      // that predates it leaves the count of the decided reviews read so far.
      ...segmentCount(doneQuery, doneQuery.data?.pages[0]?.total ?? done.length),
    },
  ]);

  function approvalOutcome(
    seen: { id: string; round: number },
    result: ApprovalOutcome,
    receipt: ReviewsOperationTypes['bureau.reviews.resolve']['output'] | undefined,
    decision: 'approve' | 'deny',
    error: unknown,
  ): void {
    // The generated approval action invalidates its own reads, including after uncertain
    // reconciliation. Keep the legacy and task caches current without forwarding that same
    // local decision back into the generated cache a second time.
    forwardingApprovalInvalidation = result !== 'failed';
    try {
      void invalidateReviewQueries(queryClient);
    } finally {
      forwardingApprovalInvalidation = false;
    }
    outcome = undefined;
    notice = undefined;
    if (result === 'outcome-not-written') notice = REVIEWS_COPY.outcomeNotWritten;
    else if (receipt?.remembered === false) notice = REVIEWS_COPY.notRemembered;
    // A conflicting decision reports before its separate read-back can invalidate the list.
    else if (result === 'already-resolved') gone({ source: 'bureau', id: seen.id });
    else if (result === 'round-changed')
      outcome = { reviewId: seen.id, tone: 'warning', ...REVIEWS_COPY.roundChanged };
    else if (result === 'superseded')
      outcome = { reviewId: seen.id, tone: 'warning', title: REVIEWS_COPY.superseded, message: '' };
    else if (result === 'failed' || result === 'unknown-after-dispatch')
      outcome = {
        reviewId: seen.id,
        tone: 'danger',
        title: REVIEWS_COPY.approvalFailed[decision],
        message:
          error instanceof HttpClientError
            ? error.message
            : 'The decision could not be confirmed. Refresh the review before trying again.',
      };
  }

  /**
   * Sends what the question's control gave. Text goes as typed; any other answer (a yes or no, a
   * pick of several, an object, a number) goes as the JSON text the Bureau reads back into it.
   */
  function answer(review: BureauHumanWait, given: unknown, onDone: () => void): void {
    const text = taskAnswerText(typeof given === 'string' ? given.trim() : given);
    if (text === '') return;
    outcome = undefined;
    answerMutation.mutate(
      {
        messageId: answerKey.keyFor(review.id, text),
        taskId: review.runId,
        answer: text,
        signalName: review.signalName,
      },
      {
        onSuccess: () => {
          answerKey.confirmed();
          onDone();
        },
        onError: (error) => {
          // Answered already, by someone else or because the agent moved on: said in its place.
          if (isReviewNoLongerWaiting(error)) {
            gone(review);
            return;
          }
          // A refusal that names fields is shown on them; any other failure is the message beside the question.
          const issues = answerRefusalIssues(error);
          outcome = {
            reviewId: review.id,
            tone: 'danger',
            title: REVIEWS_COPY.answerFailed,
            message: faultTreatment(error).message,
            ...(issues === undefined ? {} : { issues }),
          };
        },
      },
    );
  }

  const resolving = $derived(answerMutation.isPending);
</script>

<section
  class="ib-reviews"
  data-page="reviews"
  {@attach activateResource(waitingRead)}
  {@attach activateResource(doneRead)}
>
  <PageHeader title={REVIEWS_COPY.heading} description={REVIEWS_COPY.description} />

  {#if (chatRequests.data?.length ?? 0) > 0}
    <section aria-label="Chat access requests">
      <h2>Chat access requests</h2>
      {#each chatRequests.data ?? [] as request (chatRequestKey(request.requestId))}
        <article class="ib-chat-access-request">
          <p class="ib-chat-access-request__copy">
            <strong>{request.granteeLabel ?? 'A workspace member'}</strong> requested access to chat {request.contextTitle ??
              'an untitled chat'}.
          </p>
          <div class="ib-chat-access-request__actions">
            <Button
              data-changes
              size="sm"
              variant="secondary"
              disabled={resolvingChatRequest !== undefined}
              onclick={() => void resolveChatRequest(request, 'deny')}>Deny</Button
            >
            <Button
              data-changes
              size="sm"
              variant="primary"
              loading={resolvingChatRequest === chatRequestKey(request.requestId)}
              onclick={() => void resolveChatRequest(request, 'grant')}>Grant access</Button
            >
          </div>
        </article>
      {/each}
    </section>
  {/if}

  {#if notice !== undefined}
    <Alert variant="warning" dismissible onDismiss={() => (notice = undefined)}>
      <p class="ib-review-notice__title">{notice.title}</p>
      <p class="ib-review-notice__message">{notice.message}</p>
    </Alert>
  {/if}

  {#each faults as fault, index (index)}
    <QueryFaultBanner error={fault.error} subject="reviews" onRetry={fault.retry} />
  {/each}

  <!-- The segments stay through every state, so the page never loses its place while a list is read,
       except when both lists are read and hold nothing: no control over nothing (owner report,
       2026-11-19). They come back with the first review. -->
  {#if !nothingAtAll}
    <FilterBar
      aria-label={REVIEWS_COPY.tabsLabel}
      searchVisible={false}
      {segments}
      segmentValue={activeTab}
      onSegmentChange={writeTab}
    />
  {/if}

  <!-- One panel per state, remounted when the state changes: the keys that decide and the selection
       belong to the list on screen. -->
  {#if activeTab === 'done'}
    <ReviewsPanel
      mode="done"
      items={done}
      phase={phaseOf(doneQuery)}
      {resolving}
      submitting={decisionMutation.isPending}
      {submitGate}
      {outcome}
      {viewer}
      hasMore={doneQuery.hasNextPage}
      loadingMore={doneQuery.isFetchingNextPage}
      onLoadMore={async () => {
        await doneQuery.fetchNextPage();
      }}
      onApprovalOutcome={approvalOutcome}
      onAnswer={answer}
      onSubmit={submitDecision}
    />
  {:else}
    {#if (chatRequests.data?.length ?? 0) === 0 || waiting.length > 0 || waitingQuery.isPending || waitingQuery.isError}
      <ReviewsPanel
        mode="waiting"
        items={waiting}
        phase={phaseOf(waitingQuery)}
        hasSupplementalWaiting={(chatRequests.data?.length ?? 0) > 0}
        {resolving}
        submitting={decisionMutation.isPending}
        {submitGate}
        {outcome}
        {viewer}
        {refusedKey}
        onApprovalOutcome={approvalOutcome}
        onAnswer={answer}
        onSubmit={submitDecision}
      />
    {/if}
  {/if}
</section>

<style>
  .ib-chat-access-request {
    display: flex;
    align-items: center;
    gap: var(--cinder-space-3);
    max-inline-size: 44rem;
  }
  .ib-chat-access-request__copy {
    margin: 0;
  }
  .ib-chat-access-request__actions {
    display: flex;
    gap: var(--cinder-space-2);
  }
  @media (max-width: 600px) {
    .ib-chat-access-request {
      align-items: flex-start;
      flex-direction: column;
    }
    .ib-chat-access-request__actions {
      margin-inline-start: 0;
    }
  }
</style>
