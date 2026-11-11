<script lang="ts">
  /**
   * One state of `/reviews`: the reviews of that state as a list with the open review beside it
   * (ListDetail). Waiting is longest-waiting first and answerable; Done is the latest decision first,
   * under its days, and read only. The page owns the queries and the writes; this owns the
   * selection, the notes typed with a denial, and the keys that act on the open review: A approves,
   * D denies, and 1 to 9 pick a choice (registered for this route, so they are listed in the `?` map
   * and never act in a field). J, K and Enter are ListDetail's own, and Enter also moves focus into
   * the open review's first control, and never decides it.
   *
   * Waiting opens the oldest review on arrival when the panes sit side by side (ListDetail's
   * `openFirst`), and writes it to the address. A decision opens the review after it and moves focus
   * to its row; a review that leaves the queue while it is open (the agent moved on) is said so in
   * its place, with one button to the next. Both are announced politely.
   */
  import { onMount, tick, untrack } from 'svelte';
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';

  import {
    Button,
    EmptyState,
    ListDetail,
    LoadMore,
    RelativeTime,
    SelectableRow,
    StatusDot,
    type DataListGroup,
  } from '@lostgradient/cinder';
  import { Check, Inbox } from '@lucide/svelte';

  import { REVIEWS_COPY } from '../../app/copy.ts';
  import type {
    BureauHumanWait,
    BureauReview,
    ListedReview,
    ReviewDecision,
  } from '../../lib/bureau-reviews.ts';
  import {
    calendarDay,
    clockTime,
    dateLine,
    viewerTimeZone,
    zoneLabel,
  } from '../../lib/format/clock.ts';
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
    resolutionTone,
    resolutionWord,
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
    /** Who the caller is (the principal's subject), so a review they decided reads "by you". */
    readonly viewer?: string | undefined;
    readonly hasMore?: boolean;
    readonly loadingMore?: boolean;
    readonly onLoadMore?: () => Promise<void>;
    readonly onResolve: (request: ResolveRequest) => void;
    readonly onAnswer: (review: BureauHumanWait, answer: unknown, onDone: () => void) => void;
    /** Sends a decision on a workflow review; `onDone` is called when it was taken, so the list can move on. */
    readonly onSubmit: (
      reviewId: string,
      submission: ReviewDecisionSubmission,
      onDone: () => void,
    ) => void;
  }

  let {
    mode,
    items,
    phase,
    resolving,
    submitting,
    submitGate,
    outcome,
    viewer,
    hasMore = false,
    loadingMore = false,
    onLoadMore,
    onResolve,
    onAnswer,
    onSubmit,
  }: ReviewsPanelProps = $props();

  /** The list's width beside the open review at a desktop width, and at a tablet's. */
  const LIST_WIDTH = 380;
  const TABLET_LIST_WIDTH = 280;
  /** Below this viewport width the list is the tablet's narrower one. */
  const DESKTOP_MINIMUM_WIDTH = 1024;
  const listWidth =
    typeof window !== 'undefined' && window.innerWidth < DESKTOP_MINIMUM_WIDTH
      ? TABLET_LIST_WIDTH
      : LIST_WIDTH;

  const zone = viewerTimeZone();
  const selection = routerSelectionLocationFor('/reviews');
  let selectedKey = $state<string | null>(null);
  let frameElement = $state<HTMLElement | undefined>();
  let detailElement = $state<HTMLElement | undefined>();
  /** The note typed with a denial, by review, so it stays with its review while another is open. */
  const notes = new SvelteMap<string, string>();

  /**
   * The reviews this page decided, which leave the list at once: the list is read again only after
   * the decision, and until it is, the decided review would still be listed (and could be opened
   * and decided again). A key is forgotten once the list stops listing it.
   */
  const decided = new SvelteSet<string>();
  const visible = $derived(items.filter((item) => !decided.has(item.key)));
  $effect(() => {
    const listed = new Set(items.map((item) => item.key));
    untrack(() => {
      for (const key of decided) if (!listed.has(key)) decided.delete(key);
    });
  });

  const selected = $derived(visible.find((item) => item.key === selectedKey));
  const lastKey = $derived(visible.at(-1)?.key);

  /** What the polite live region says: the last decision that landed, or a review that left. */
  let announcement = $state('');
  /**
   * The review a decision was sent for, until the review after it opens. The list is read again as
   * the decision lands, so the review can be gone from it a moment before the page moves on; it is
   * not "no longer waiting" then, it is decided.
   */
  let advancingKey = $state<string | null>(null);
  $effect(() => {
    // A refusal is written to `outcome`: the review stays, so nothing is being advanced from it.
    if (outcome !== undefined) untrack(() => (advancingKey = null));
  });

  /** The titles of the reviews the list has held, so one that left can still be named. */
  const titles = new SvelteMap<string, string>();
  $effect(() => {
    for (const item of items) titles.set(item.key, reviewTitle(item.review));
  });

  /**
   * Whether the open review left the waiting list without this page deciding it: the agent moved on,
   * someone decided it elsewhere, or the address names one that is not waiting. Its place says so.
   */
  const gone = $derived(
    mode === 'waiting' &&
      phase === 'ready' &&
      selectedKey !== null &&
      selected === undefined &&
      advancingKey !== selectedKey &&
      !decided.has(selectedKey),
  );
  // With nothing left to list the panes give way to the empty state, which cannot clear an address
  // that still names a review.
  $effect(() => {
    if (phase !== 'ready' || visible.length > 0) return;
    untrack(() => {
      selectedKey = null;
      if (selection.read('review') !== null) selection.write('review', null);
    });
  });
  $effect(() => {
    if (!gone || selectedKey === null) return;
    const key = selectedKey;
    untrack(() => {
      announcement = REVIEWS_COPY.announce(REVIEWS_COPY.announced.gone, titles.get(key) ?? '');
    });
  });

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

  /** Moves focus to the row of the review at `key`, so its ring says where the list now is. */
  async function focusRow(key: string): Promise<void> {
    await tick();
    const rows = frameElement?.querySelectorAll<HTMLElement>('[data-review-row]') ?? [];
    const row = [...rows].find((element) => element.getAttribute('data-review-row') === key);
    row?.querySelector<HTMLElement>('.cinder-selectable-row__primary')?.focus();
  }

  /**
   * The function that opens the review after `key` once `key` is decided, and says `message`
   * politely. It opens that review only if `key` is still the open one then.
   */
  function advancer(key: string, message: string): () => void {
    const next = neighbourKey(visible, key);
    advancingKey = key;
    return () => {
      if (advancingKey === key) advancingKey = null;
      decided.add(key);
      announcement = message;
      // The list is read again as the decision lands, so the review chosen to follow may be gone too.
      if (selectedKey === key) {
        const target = visible.some((item) => item.key === next) ? next : null;
        selectedKey = target;
        void armDecisionKeysWhenSeen();
        if (target !== null) void focusRow(target);
      }
    };
  }

  /** Opens the oldest review still waiting, from the place a review that left was shown. */
  function openNext(): void {
    const first = visible[0]?.key ?? null;
    selectedKey = first;
    if (first !== null) void focusRow(first);
  }

  /** Sends a decision on the open approval, then opens the review after it. */
  function decide(
    review: Extract<BureauReview, { kind: 'tool-approval' }>,
    action: 'approve' | 'deny' | 'remember',
  ): void {
    if (mode !== 'waiting' || resolving || decisionSent || review.status !== 'pending') return;
    decisionSent = true;
    const note = (notes.get(review.id) ?? '').trim();
    const word =
      action === 'deny' ? REVIEWS_COPY.announced.denied : REVIEWS_COPY.announced.approved;
    const advance = advancer(
      `bureau:${review.id}`,
      REVIEWS_COPY.announce(word, reviewTitle(review)),
    );
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
        reason: note === '' ? undefined : note,
        remember: action === 'remember',
        onDone,
      });
    }
  }

  function approvalOpen(): Extract<BureauReview, { kind: 'tool-approval' }> | undefined {
    const review = selected?.review;
    return review?.kind === 'tool-approval' ? review : undefined;
  }

  /** Moves focus to the first control of the open review's decision or answer, and presses none. */
  function focusDecision(): void {
    const region = detailElement?.querySelector<HTMLElement>(
      '.ib-review-pane__decision, .ib-review-pane__answer',
    );
    region
      ?.querySelector<HTMLElement>(
        'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled])',
      )
      ?.focus();
  }

  /**
   * Enter on a row opens it (ListDetail's own), and here also takes focus into its first control:
   * the note field or the first choice. It never decides: a review is decided by a click, or by
   * activating a focused button. ListDetail has opened the row by the time this runs, and the key's
   * own default is cancelled: a browser sends what follows a keydown (Enter's keypress, which presses
   * a button and submits a form) to whatever holds focus then, and by then focus is in the review.
   */
  function handleFrameKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || mode !== 'waiting') return;
    const target = event.target;
    if (
      !(target instanceof Element) ||
      target.closest('.cinder-selectable-row__primary') === null
    ) {
      return;
    }
    event.preventDefault();
    void tick().then(focusDecision);
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

  /** What a workflow review's decision is announced as. */
  function engineDecisionWord(decision: ReviewDecisionSubmission['decision']): string {
    if (decision === 'approved') return REVIEWS_COPY.announced.approved;
    if (decision === 'needs-changes') return REVIEWS_COPY.announced.sentBack;
    return REVIEWS_COPY.decided.rejected;
  }

  function agentOf(review: ListedReview): string | undefined {
    return review.kind === 'engine-review' ? undefined : review.agentName;
  }

  /** The day a decided review is listed under: "Today", "Yesterday", then the date, with the zone at the right. */
  function dayGroup(item: InboxItem): DataListGroup {
    const now = Date.now();
    const at = item.review.resolution?.decidedAt ?? item.review.requestedAt;
    const detail = zoneLabel(now, zone);
    const days = calendarDay(now, zone) - calendarDay(at, zone);
    if (days <= 0) return { key: 'today', label: REVIEWS_COPY.day.today, detail };
    if (days === 1) return { key: 'yesterday', label: REVIEWS_COPY.day.yesterday, detail };
    return { key: `day-${String(calendarDay(at, zone))}`, label: dateLine(at, zone), detail };
  }
</script>

<!-- Said politely when a decision lands or a review leaves, so it is told whatever the screen shows
     (it outlives the list, which the last decision empties). -->
<p class="cinder-sr-only" role="status" aria-live="polite" data-testid="reviews-announcement">
  {announcement}
</p>

{#snippet goneDetail()}
  <div class="ib-review-gone" data-testid="review-gone">
    <p class="ib-review-gone__message">
      <Check aria-hidden="true" size={18} />
      <span>{REVIEWS_COPY.noLongerWaiting.message}</span>
    </p>
    <Button variant="primary" onclick={openNext}>{REVIEWS_COPY.noLongerWaiting.next}</Button>
  </div>
{/snippet}

{#if phase === 'ready' && visible.length === 0}
  {#if mode === 'waiting'}
    <EmptyState
      kind="done"
      headingLevel={2}
      title={REVIEWS_COPY.allCaughtUp}
      description={REVIEWS_COPY.nothingWaiting}
    >
      {#snippet icon()}<Inbox aria-hidden="true" />{/snippet}
    </EmptyState>
  {:else}
    <EmptyState
      kind="first-use"
      headingLevel={2}
      title={REVIEWS_COPY.nothingDecided}
      description={REVIEWS_COPY.nothingDecidedDescription}
    />
  {/if}
{:else if phase !== 'failed'}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="ib-reviews__frame"
    data-shortcut-region="list-detail"
    data-mode={mode}
    bind:this={frameElement}
    onkeydown={handleFrameKeydown}
  >
    <ListDetail
      items={visible}
      key={(item: InboxItem) => item.key}
      label={REVIEWS_COPY.listLabel[mode]}
      detailLabel={REVIEWS_COPY.detailLabel}
      backLabel={REVIEWS_COPY.heading}
      emptyTitle={REVIEWS_COPY.noReviewSelected}
      emptyDescription={REVIEWS_COPY.chooseReview}
      loading={phase === 'loading'}
      loadingLabel={REVIEWS_COPY.loading}
      openFirst={mode === 'waiting'}
      defaultListWidth={listWidth}
      bind:selectedKey
      selectionParameter="review"
      selectionLocation={selection}
      storageKey="interborough-reviews"
      {...gone ? { empty: goneDetail } : {}}
      {...mode === 'done' ? { groupBy: dayGroup } : {}}
    >
      {#snippet header()}
        <p class="ib-reviews__hint">{REVIEWS_COPY.keysHint}</p>
      {/snippet}
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
                : `, ${agentOf(item.review)}`}
            </span>
          {/snippet}
          {#snippet meta()}
            {#if mode === 'done'}
              {@const decidedAt = item.review.resolution?.decidedAt ?? item.review.requestedAt}
              <StatusDot
                status={resolutionTone(item.review)}
                label={resolutionWord(item.review, viewer)}
              />
              <time datetime={new Date(decidedAt).toISOString()}>{clockTime(decidedAt, zone)}</time>
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
                onAnswer={(answer) =>
                  onAnswer(
                    review,
                    answer,
                    advancer(
                      item.key,
                      REVIEWS_COPY.announce(REVIEWS_COPY.announced.answered, reviewTitle(review)),
                    ),
                  )}
              />
            {:else}
              <EngineReviewPane
                review={item.review}
                {submitting}
                {submitGate}
                {viewer}
                onSubmit={(reviewId, submission) =>
                  onSubmit(
                    reviewId,
                    submission,
                    advancer(
                      item.key,
                      REVIEWS_COPY.announce(
                        engineDecisionWord(submission.decision),
                        reviewTitle(item.review),
                      ),
                    ),
                  )}
              />
            {/if}
          {/key}
        </div>
      {/snippet}
    </ListDetail>
  </div>
{/if}
