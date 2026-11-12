<script lang="ts">
  /**
   * `/reviews`: everything waiting on the caller in one inbox, the longest waiting first. A tool
   * approval, a question an agent asked and a workflow review are all one list
   * (`bureau.reviews.list`), each answered where it is shown: an approval is approved, denied or
   * allowed for the rest of its chat, a question is answered in the shape it asks for, and a
   * workflow review takes the engine's decision form. Done lists what was decided. This owns the
   * queries and the writes once and hands them down; the segments (Waiting and Done, each with its
   * count, a dash until it is known) are the address (`?tab=done`). Done is read from the start so
   * its count is known, and a decision asks both lists again, so both counts follow it. The count is
   * of the decided reviews read so far (a page is 25), because the Bureau's list carries no total.
   */
  import { Alert, FilterBar, PageHeader, type FilterSegment } from '@lostgradient/cinder';

  import { REVIEWS_COPY } from '../../app/copy/reviews.ts';
  import { isReviewRoundChanged, type BureauHumanWait } from '../../lib/bureau-reviews.ts';
  import { answerRefusalIssues, taskAnswerText } from '../../lib/bureau-tasks.ts';
  import { getClient } from '../../lib/client.ts';
  import { combinePages } from '../../lib/combine-pages.ts';
  import { faultTreatment } from '../../lib/faults.ts';
  import { createPendingCommandKey } from '../../lib/pending-command-key.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { getPrincipalStore, scopeGate } from '../../lib/scopes.svelte.ts';
  import QueryFaultBanner from './query-fault-banner.svelte';
  import type { ReviewDecisionSubmission } from './review-decision-form.svelte';
  import { doneItems, inboxKey, waitingItems } from './review-items.ts';
  import type { ReviewOutcome } from './review-outcome.ts';
  import {
    answerHumanWaitMutation,
    doneReviewsQuery,
    resolveBureauReviewMutation,
    submitReviewDecisionMutation,
    waitingReviewsQuery,
  } from './reviews-data.ts';
  import ReviewsPanel, { type ResolveRequest } from './reviews-panel.svelte';

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
  const principalStore = getPrincipalStore();
  const submitGate = $derived(scopeGate(principalStore, ['reviews:write']));
  /** Who the caller is, so what they decided reads "by you". */
  const viewer = $derived(principalStore.principal?.subject ?? undefined);

  const waitingQuery = waitingReviewsQuery();
  const doneQuery = doneReviewsQuery(() => true);
  const decisionMutation = submitReviewDecisionMutation(client);
  const resolveMutation = resolveBureauReviewMutation();
  const answerMutation = answerHumanWaitMutation();
  // One key stays with an answer until the Bureau confirms it, so a retry after a lost response is
  // the same command and the Bureau answers it from its ledger.
  const answerKey = createPendingCommandKey();

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

  /** A query that failed shows the fault banner; a list it still holds is shown beneath it. */
  const faults = $derived<readonly { error: unknown; retry: () => void }[]>(
    (activeTab === 'done' ? [doneQuery] : [waitingQuery])
      .filter((query) => query.isError)
      .map((query) => ({ error: query.error, retry: () => void query.refetch() })),
  );

  /** What became of the last decision or answer on a review, when it did not simply take effect. */
  let outcome = $state<ReviewOutcome | undefined>(undefined);
  /** A decision that took effect but needs saying so: its outcome was not written, or it was not remembered. */
  let notice = $state<{ title: string; message: string } | undefined>(undefined);

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
    { value: 'done', label: REVIEWS_COPY.tabs.done, ...segmentCount(doneQuery, done.length) },
  ]);

  function resolve(request: ResolveRequest): void {
    const { review, decision, reason, remember, onDone } = request;
    outcome = undefined;
    notice = undefined;
    resolveMutation.mutate(
      {
        id: review.id,
        decision,
        ...(reason === undefined ? {} : { reason }),
        // The round the row showed: a review gated again since is refused, not decided. A tool
        // approval also says it was decided here, so the chat that asked can say so (COR-2292).
        ...(review.kind === 'tool-approval'
          ? { round: review.round, decisionSurface: 'reviews' as const }
          : {}),
        ...(remember ? { remember: true } : {}),
      },
      {
        onSuccess: (resolution) => {
          if (resolution.outcomeNotWritten === true) {
            // The Bureau drops a review from its pending list as it commits the decision, which is
            // before it signals that the outcome could not be written. The list is read again at
            // once, so the review is gone and no pane could carry this: it belongs to the page,
            // and stays until the operator dismisses it.
            notice = REVIEWS_COPY.outcomeNotWritten;
          } else if (resolution.receipt === 'superseded') {
            outcome = {
              reviewId: review.id,
              tone: 'warning',
              title: REVIEWS_COPY.superseded,
              message: '',
            };
            return;
          } else if (remember && resolution.remembered === false) {
            notice = REVIEWS_COPY.notRemembered;
          }
          onDone();
        },
        onError: (error) => {
          outcome = isReviewRoundChanged(error)
            ? {
                reviewId: review.id,
                tone: 'warning',
                title: REVIEWS_COPY.roundChanged.title,
                message: REVIEWS_COPY.roundChanged.message,
              }
            : {
                reviewId: review.id,
                tone: 'danger',
                title: REVIEWS_COPY.decisionFailed,
                message: faultTreatment(error).message,
              };
        },
      },
    );
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

  const resolving = $derived(resolveMutation.isPending || answerMutation.isPending);
</script>

<section class="ib-reviews" data-page="reviews">
  <PageHeader title={REVIEWS_COPY.heading} description={REVIEWS_COPY.description} />

  {#if notice !== undefined}
    <Alert variant="warning" dismissible onDismiss={() => (notice = undefined)}>
      <p class="ib-review-notice__title">{notice.title}</p>
      <p class="ib-review-notice__message">{notice.message}</p>
    </Alert>
  {/if}

  {#each faults as fault, index (index)}
    <QueryFaultBanner error={fault.error} onRetry={fault.retry} />
  {/each}

  <!-- The segments stay through every state, so the page never loses its place while a list is read. -->
  <FilterBar
    aria-label={REVIEWS_COPY.tabsLabel}
    searchVisible={false}
    {segments}
    segmentValue={activeTab}
    onSegmentChange={writeTab}
  />

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
      onResolve={resolve}
      onAnswer={answer}
      onSubmit={submitDecision}
    />
  {:else}
    <ReviewsPanel
      mode="waiting"
      items={waiting}
      phase={phaseOf(waitingQuery)}
      {resolving}
      submitting={decisionMutation.isPending}
      {submitGate}
      {outcome}
      {viewer}
      onResolve={resolve}
      onAnswer={answer}
      onSubmit={submitDecision}
    />
  {/if}
</section>
