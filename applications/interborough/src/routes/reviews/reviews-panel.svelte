<script lang="ts">
  /**
   * One tab of `/reviews`: the reviews of that tab as a list with the open review beside it
   * (ListDetail). Waiting is longest-waiting first and answerable; Done is the latest decision first
   * and read only. The page owns the queries and the writes; this owns the selection, the notes
   * typed with a denial, and the keys that act on the open review: A approves, D denies, and 1 to 9
   * pick a choice (registered for this route, so they are listed in the `?` map and never act in a
   * field). J, K and Enter are ListDetail's own.
   */
  import { onMount, tick } from 'svelte';
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

  /**
   * Whether the keys that decide (A, D, 1 to 9) act. A decision opens the review after it at once,
   * and a key pressed while that review was still coming up, or a press already queued behind the
   * deciding one, would decide a review the person has not seen. The keys stay off from the
   * advance until the next review has rendered and been painted, so the next decision is a press
   * made after the person could see it.
   */
  let decisionKeysArmed = $state(true);

  /**
   * Whether a decision has been sent and the page has not yet reported it in flight. `resolving`
   * only turns true when the page next renders, so a second press made in the same moment would
   * send the same decision twice; this closes that gap and is cleared as `resolving` settles.
   */
  let decisionSent = false;
  $effect(() => {
    // A refusal or a superseded decision is written to `outcome`, which settles the send too.
    void outcome;
    if (!resolving) decisionSent = false;
  });

  /** Turns the deciding keys back on once the review that just opened has rendered and painted. */
  async function armDecisionKeysWhenSeen(): Promise<void> {
    decisionKeysArmed = false;
    await tick();
    requestAnimationFrame(() => requestAnimationFrame(() => (decisionKeysArmed = true)));
  }

  /** The function that opens the review after `key` once `key` is decided, if `key` is still open then. */
  function advancer(key: string): () => void {
    const next = neighbourKey(items, key);
    return () => {
      // The list is read again as the decision lands, so the review chosen to follow may be gone too.
      if (selectedKey === key) {
        selectedKey = items.some((item) => item.key === next) ? next : null;
        void armDecisionKeysWhenSeen();
      }
    };
  }

  /** Sends a decision on the open approval, then opens the review after it. */
  function decide(
    review: Extract<BureauReview, { kind: 'tool-approval' }>,
    action: 'approve' | 'deny' | 'remember',
  ): void {
    if (mode !== 'waiting' || resolving || decisionSent || review.status !== 'pending') return;
    decisionSent = true;
    const note = (notes.get(review.id) ?? '').trim();
    const advance = advancer(`bureau:${review.id}`);
    const onDone = (): void => {
      decisionSent = false;
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
          if (review !== undefined && decisionKeysArmed) decide(review, 'approve');
        },
      }),
      shortcuts.register({
        keys: ['d'],
        label: REVIEWS_COPY.denyShortcut,
        group,
        scope,
        handler: () => {
          const review = approvalOpen();
          if (review !== undefined && decisionKeysArmed) decide(review, 'deny');
        },
      }),
      ...Array.from({ length: 9 }, (_, index) =>
        shortcuts.register({
          keys: [String(index + 1)],
          label: REVIEWS_COPY.pickShortcut(index + 1),
          group,
          scope,
          handler: () => {
            if (selected?.review.kind === 'human-wait' && decisionKeysArmed) {
              pickChoice(detailElement, index + 1);
            }
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
          <!-- One pane per review: a draft, a note or a section decision made on one never carries to
               the next, so the answer posted always belongs to the review shown. -->
          {#key item.key}
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
              <EngineReviewPane review={item.review} {submitting} {submitGate} {onSubmit} />
            {/if}
          {/key}
        </div>
      {/snippet}
    </ListDetail>
  </div>
{/if}
