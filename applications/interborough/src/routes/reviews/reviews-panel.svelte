<script lang="ts">
  /**
   * One tab of `/reviews`: the reviews of that tab as a list with the open review beside it
   * (ListDetail). Waiting is longest-waiting first and answerable; Done is the latest decision first
   * and read only. The page owns the queries and the writes; this owns the selection, the notes
   * typed with a denial, and the keys that act on the open review: A approves, D denies, and 1 to 9
   * pick a choice (registered for this route, so they are listed in the `?` map and never act in a
   * field). J, K and Enter are ListDetail's own.
   */
  import { onMount } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';

  import {
    Badge,
    EmptyState,
    ListDetail,
    LoadMore,
    RelativeTime,
    SelectableRow,
    Skeleton,
  } from '@lostgradient/cinder';

  import { REVIEWS_COPY } from '../../app/copy.ts';
  import type {
    BureauHumanWait,
    BureauReview,
    ListedReview,
    ReviewDecision,
  } from '../../lib/bureau-reviews.ts';
  import { routerSelectionLocationFor } from '../../lib/router-selection-location.ts';
  import type { ScopeGate } from '../../lib/scopes.svelte.ts';
  import { shortcuts } from '../../lib/shortcuts.ts';
  import ApprovalPane from './approval-pane.svelte';
  import { pickChoice } from './choice-buttons.ts';
  import EngineReviewPane from './engine-review-pane.svelte';
  import QuestionPane from './question-pane.svelte';
  import type { ReviewDecisionSubmission } from './review-decision-form.svelte';
  import {
    neighbourKey,
    resolutionLabel,
    reviewKindLabel,
    reviewTitle,
    type InboxItem,
  } from './review-items.ts';
  import type { ReviewOutcome } from './review-outcome.ts';

  /** What the page asks of a decision on one of the Bureau's reviews. */
  export interface ResolveRequest {
    readonly review: BureauReview;
    readonly decision: ReviewDecision;
    readonly reason: string | undefined;
    /** Approve and allow the tool for the rest of the chat. */
    readonly remember: boolean;
    /** Called when the Bureau took the decision, so the list can move on to the next review. */
    readonly onDone: () => void;
  }

  interface ReviewsPanelProps {
    readonly mode: 'waiting' | 'done';
    readonly items: InboxItem[];
    /** `loading` until the list is read; `failed` when it could not be, which the page says. */
    readonly phase: 'loading' | 'failed' | 'ready';
    /** Whether a decision or an answer on one of the Bureau's reviews is being sent. */
    readonly resolving: boolean;
    /** Whether a decision on one of the workflow reviews is being sent. */
    readonly submitting: boolean;
    readonly submitGate?: ScopeGate | undefined;
    /** What became of the last decision or answer, when it was not simply taken. */
    readonly outcome: ReviewOutcome | undefined;
    readonly hasMore?: boolean;
    readonly loadingMore?: boolean;
    readonly onLoadMore?: () => Promise<void>;
    readonly onResolve: (request: ResolveRequest) => void;
    readonly onAnswer: (review: BureauHumanWait, answer: unknown, onDone: () => void) => void;
    readonly onSubmit: (reviewId: string, submission: ReviewDecisionSubmission) => void;
  }

  let {
    mode,
    items,
    phase,
    resolving,
    submitting,
    submitGate,
    outcome,
    hasMore = false,
    loadingMore = false,
    onLoadMore,
    onResolve,
    onAnswer,
    onSubmit,
  }: ReviewsPanelProps = $props();

  const selection = routerSelectionLocationFor('/reviews');
  let selectedKey = $state<string | null>(null);
  let detailElement = $state<HTMLElement | undefined>();
  /** The note typed with a denial, by review, so it stays with its review while another is open. */
  const notes = new SvelteMap<string, string>();

  const selected = $derived(items.find((item) => item.key === selectedKey));
  const lastKey = $derived(items.at(-1)?.key);

  /** The function that opens the review after `key` once `key` is decided, if `key` is still open then. */
  function advancer(key: string): () => void {
    const next = neighbourKey(items, key);
    return () => {
      if (selectedKey === key) selectedKey = next;
    };
  }

  /** Sends a decision on the open approval, then opens the review after it. */
  function decide(
    review: Extract<BureauReview, { kind: 'tool-approval' }>,
    action: 'approve' | 'deny' | 'remember',
  ): void {
    if (mode !== 'waiting' || resolving || review.status !== 'pending') return;
    const note = (notes.get(review.id) ?? '').trim();
    const advance = advancer(`bureau:${review.id}`);
    const onDone = (): void => {
      notes.delete(review.id);
      advance();
    };
    if (action === 'deny') {
      // A denial with a note is a rejection with that reason, which the agent reads.
      onResolve({
        review,
        decision: note === '' ? 'deny' : 'reject',
        reason: note === '' ? undefined : note,
        remember: false,
        onDone,
      });
    } else {
      onResolve({
        review,
        decision: 'approve',
        reason: undefined,
        remember: action === 'remember',
        onDone,
      });
    }
  }

  function approvalOpen(): Extract<BureauReview, { kind: 'tool-approval' }> | undefined {
    const review = selected?.review;
    return review?.kind === 'tool-approval' ? review : undefined;
  }

  onMount(() => {
    if (mode !== 'waiting') return;
    const group = REVIEWS_COPY.shortcutGroup;
    const scope = { route: '/reviews' } as const;
    const removals = [
      shortcuts.register({
        keys: ['a'],
        label: REVIEWS_COPY.approveShortcut,
        group,
        scope,
        handler: () => {
          const review = approvalOpen();
          if (review !== undefined) decide(review, 'approve');
        },
      }),
      shortcuts.register({
        keys: ['d'],
        label: REVIEWS_COPY.denyShortcut,
        group,
        scope,
        handler: () => {
          const review = approvalOpen();
          if (review !== undefined) decide(review, 'deny');
        },
      }),
      ...Array.from({ length: 9 }, (_, index) =>
        shortcuts.register({
          keys: [String(index + 1)],
          label: REVIEWS_COPY.pickShortcut(index + 1),
          group,
          scope,
          handler: () => {
            if (selected?.review.kind === 'human-wait') pickChoice(detailElement, index + 1);
          },
        }),
      ),
    ];
    return () => {
      for (const remove of removals) remove();
    };
  });

  function agentOf(review: ListedReview): string | undefined {
    return review.kind === 'engine-review' ? undefined : review.agentName;
  }
</script>

{#if phase === 'loading'}
  <div role="status" aria-busy="true" aria-label={REVIEWS_COPY.loading}>
    <Skeleton height="3rem" />
    <Skeleton height="3rem" />
  </div>
{:else if phase === 'ready' && items.length === 0}
  {#if mode === 'waiting'}
    <EmptyState
      kind="done"
      headingLevel={2}
      title={REVIEWS_COPY.allCaughtUp}
      description={REVIEWS_COPY.nothingWaiting}
    />
  {:else}
    <EmptyState
      kind="first-use"
      headingLevel={2}
      title={REVIEWS_COPY.nothingDecided}
      description={REVIEWS_COPY.nothingDecidedDescription}
    />
  {/if}
{:else if phase === 'ready'}
  <div class="ib-reviews__frame" data-shortcut-region="list-detail" data-mode={mode}>
    <ListDetail
      {items}
      key={(item: InboxItem) => item.key}
      label={REVIEWS_COPY.listLabel[mode]}
      detailLabel={REVIEWS_COPY.detailLabel}
      emptyTitle={REVIEWS_COPY.noReviewSelected}
      emptyDescription={REVIEWS_COPY.chooseReview}
      bind:selectedKey
      selectionParameter="review"
      selectionLocation={selection}
      storageKey="interborough-reviews"
    >
      {#snippet list(item, row)}
        <SelectableRow
          selected={row.selected}
          selectedState="current"
          onclick={row.open}
          data-review-row={item.key}
          data-kind={item.review.kind}
        >
          {#snippet title()}<span class="ib-review-row__title">{reviewTitle(item.review)}</span
            >{/snippet}
          {#snippet description()}
            <span class="ib-review-row__kind">
              {reviewKindLabel(item.review)}{agentOf(item.review) === undefined
                ? ''
                : ` · ${agentOf(item.review)}`}
            </span>
          {/snippet}
          {#snippet meta()}
            {#if mode === 'done'}
              <Badge variant="neutral" size="sm">{resolutionLabel(item.review)}</Badge>
              <RelativeTime date={item.review.resolution?.decidedAt ?? item.review.requestedAt} />
            {:else}
              <RelativeTime date={item.review.requestedAt} />
            {/if}
          {/snippet}
        </SelectableRow>
        {#if mode === 'done' && item.key === lastKey && onLoadMore !== undefined}
          <LoadMore
            {hasMore}
            loading={loadingMore}
            {onLoadMore}
            buttonLabel={REVIEWS_COPY.loadMore}
            endOfListMessage=""
          />
        {/if}
      {/snippet}
      {#snippet detail(item)}
        <div class="ib-reviews__detail" bind:this={detailElement}>
          {#if item.review.kind === 'tool-approval'}
            {@const review = item.review}
            <ApprovalPane
              {review}
              bind:note={() => notes.get(review.id) ?? '', (value) => notes.set(review.id, value)}
              deciding={resolving}
              outcome={outcome?.reviewId === review.id ? outcome : undefined}
              onDecide={(action) => decide(review, action)}
            />
          {:else if item.review.kind === 'human-wait'}
            {@const review = item.review}
            <QuestionPane
              {review}
              answering={resolving}
              outcome={outcome?.reviewId === review.id ? outcome : undefined}
              onAnswer={(answer) => onAnswer(review, answer, advancer(item.key))}
            />
          {:else}
            <EngineReviewPane
              review={item.review}
              {submitting}
              {submitGate}
              outcome={outcome?.reviewId === item.review.id ? outcome : undefined}
              {onSubmit}
            />
          {/if}
        </div>
      {/snippet}
    </ListDetail>
  </div>
{/if}
