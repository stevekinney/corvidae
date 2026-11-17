<script lang="ts" module>
  /**
   * @cinder
   * @category action
   * @status beta
   * @purpose Stack of decision cards for working through a review queue on a phone: drag a card to accept or reject it, or press the equal round buttons, with Undo, progress and an all-caught-up state.
   * @tag review
   * @tag queue
   * @tag swipe
   * @tag decision
   * @useWhen Working through a queue of items one at a time on a phone, where each item gets an accept, reject or later decision.
   * @useWhen Offering a swipe as a shortcut for decisions that also have buttons and keys, with a visible Undo after each one.
   * @avoidWhen Reviewing one pending tool call with its full detail and an audit trail. | approval-card
   * @avoidWhen Deciding many items at once from a table, where rows need sorting and bulk actions. | data-table
   * @rationale Nearest alternative: ApprovalCard — ApprovalCard resolves one request with its full detail; DecisionDeck moves through a whole queue of short cards.
   * @keyboardShortcut ArrowRight | Accepts the focused top card.
   * @keyboardShortcut ArrowLeft | Rejects the focused top card.
   * @keyboardShortcut ArrowDown | Sets the focused top card aside for later.
   * @a11yNote Every swipe decision is also a labelled button and an arrow key, and each decision is announced and can be undone.
   */
  export type {
    DecisionDeckDecision,
    DecisionDeckItem,
    DecisionDeckOutcome,
    DecisionDeckProps,
  } from './decision-deck.types.ts';
</script>

<script lang="ts" generics="TItem extends DecisionDeckItem = DecisionDeckItem">
  import Check from '@lucide/svelte/icons/check';
  import Clock from '@lucide/svelte/icons/clock';
  import X from '@lucide/svelte/icons/x';
  import { flushSync } from 'svelte';

  import { classNames } from '../../utilities/class-names.ts';
  import Button from '../button/button.svelte';
  import DecisionDeckCard from './decision-deck-card.svelte';
  import {
    isVerticalGesture,
    resolveSwipeOutcome,
    resolveSwipeThreshold,
    SWIPE_SLOP,
    swipeStampOpacity,
  } from './decision-deck-swipe.ts';
  import type {
    DecisionDeckDecision,
    DecisionDeckItem,
    DecisionDeckOutcome,
    DecisionDeckProps,
  } from './decision-deck.types.ts';

  /** How many cards are drawn: the top card and the two under it. */
  const VISIBLE_CARDS = 3;

  /** A drag does not start on these, so a link or control inside a card keeps working. */
  const NO_SWIPE_SELECTOR =
    'a[href], button, input, select, textarea, summary, [contenteditable], [data-decision-no-swipe]';

  /** The control that held focus when a decision was made, so Undo can put focus back. */
  type FocusOrigin = DecisionDeckOutcome | 'card' | null;

  type HistoryEntry = { decision: DecisionDeckDecision<TItem>; origin: FocusOrigin };

  type DragState = {
    pointerId: number;
    startX: number;
    startY: number;
    active: boolean;
    element: HTMLElement | null;
  };

  function defaultProgressText(position: number, total: number): string {
    return `${position} of ${total}`;
  }

  function pastTense(outcome: DecisionDeckOutcome): string {
    if (outcome === 'accept') return 'Accepted';
    if (outcome === 'reject') return 'Rejected';
    return 'Saved for later';
  }

  function defaultDescribeDecision(decision: DecisionDeckDecision<TItem>): string {
    return `${pastTense(decision.outcome)}: ${decision.item.title}`;
  }

  let {
    items,
    label,
    threshold,
    acceptLabel = 'Accept',
    rejectLabel = 'Reject',
    laterLabel = 'Later',
    undoLabel = 'Undo',
    emptyTitle = 'All caught up',
    emptyDescription,
    keyboardHint = 'Press the right arrow key to accept, the left arrow key to reject, or the down arrow key to decide later.',
    progressText = defaultProgressText,
    describeDecision,
    onDecision,
    onUndo,
    card,
    class: className,
    ...rest
  }: DecisionDeckProps<TItem> = $props();

  const uid = $props.id();
  const hintId = `${uid}-hint`;
  const progressId = `${uid}-progress`;

  // Decisions in the order they were made. Raw state: items may be class instances, and the deck
  // only ever replaces the array.
  let history = $state.raw<HistoryEntry[]>([]);
  let offset = $state(0);
  let dragging = $state(false);
  let announcement = $state('');
  let rootElement = $state<HTMLElement | null>(null);

  // Held outside reactive state: the gesture is read by the window listeners, never by the markup.
  let drag: DragState | null = null;

  const resolvedThreshold = $derived(resolveSwipeThreshold(threshold));
  const describe = $derived(describeDecision ?? defaultDescribeDecision);
  const pending = $derived(
    items.filter((item) => !history.some((entry) => entry.decision.item.id === item.id)),
  );
  const visibleCards = $derived(pending.slice(0, VISIBLE_CARDS));
  const total = $derived(items.length);
  const decidedCount = $derived(total - pending.length);
  const position = $derived(Math.min(decidedCount + 1, total));
  const progressLabel = $derived(progressText(position, total));
  const latest = $derived(history.at(-1));
  const laterCount = $derived(history.filter((entry) => entry.decision.outcome === 'later').length);
  const emptyDescriptionText = $derived(
    emptyDescription ??
      (laterCount > 0 ? `${laterCount} left for later.` : 'Nothing is waiting for a decision.'),
  );
  const acceptOpacity = $derived(swipeStampOpacity(offset, resolvedThreshold, 'accept'));
  const rejectOpacity = $derived(swipeStampOpacity(offset, resolvedThreshold, 'reject'));

  function focusTarget(target: Exclude<FocusOrigin, null>): void {
    const selector =
      target === 'card'
        ? '[data-cinder-decision-card][data-depth="0"]'
        : `[data-decision-action="${target}"]`;
    rootElement?.querySelector<HTMLElement>(selector)?.focus();
  }

  function topCardHasFocus(): boolean {
    const topCard = rootElement?.querySelector('[data-cinder-decision-card][data-depth="0"]');
    return topCard !== null && topCard !== undefined && topCard === document.activeElement;
  }

  // After the deck has re-rendered, keeps focus on a control that still exists: the buttons stay
  // where they are, the next card takes focus from the card that left, and the empty state takes
  // it when the last card is gone.
  function settleFocus(origin: FocusOrigin): void {
    if (origin === null) return;
    if (pending.length === 0) {
      rootElement?.querySelector<HTMLElement>('.cinder-decision-deck__empty')?.focus();
      return;
    }
    if (origin === 'card') focusTarget('card');
  }

  function decide(outcome: DecisionDeckOutcome, origin: FocusOrigin): void {
    const item = pending[0];
    if (item === undefined) return;
    const decision: DecisionDeckDecision<TItem> = { item, outcome };
    history = [...history, { decision, origin }];
    offset = 0;
    dragging = false;
    drag = null;
    announcement = describe(decision);
    flushSync();
    settleFocus(origin);
    onDecision?.(decision);
  }

  function undo(): void {
    const entry = history.at(-1);
    if (entry === undefined) return;
    history = history.slice(0, -1);
    offset = 0;
    dragging = false;
    drag = null;
    announcement = `${undoLabel}: ${entry.decision.item.title}`;
    flushSync();
    focusTarget(entry.origin ?? 'card');
    onUndo?.(entry.decision);
  }

  function outcomeForKey(key: string): DecisionDeckOutcome | null {
    if (key === 'ArrowRight') return 'accept';
    if (key === 'ArrowLeft') return 'reject';
    if (key === 'ArrowDown') return 'later';
    return null;
  }

  function onCardKeydown(event: KeyboardEvent): void {
    if (event.target !== event.currentTarget) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const outcome = outcomeForKey(event.key);
    if (outcome === null) return;
    event.preventDefault();
    decide(outcome, 'card');
  }

  function onCardPointerDown(event: PointerEvent): void {
    if (drag !== null) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest(NO_SWIPE_SELECTOR) !== null) {
      return;
    }
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      element: event.currentTarget instanceof HTMLElement ? event.currentTarget : null,
    };
  }

  function onWindowPointerMove(event: PointerEvent): void {
    const current = drag;
    if (current === null || event.pointerId !== current.pointerId) return;
    const deltaX = event.clientX - current.startX;
    const deltaY = event.clientY - current.startY;
    if (!current.active) {
      if (Math.hypot(deltaX, deltaY) < SWIPE_SLOP) return;
      if (isVerticalGesture(deltaX, deltaY)) {
        // A scroll, not a swipe: leave the gesture to the page.
        drag = null;
        return;
      }
      current.active = true;
      dragging = true;
      try {
        current.element?.setPointerCapture(event.pointerId);
      } catch {
        // The pointer is already gone, or the environment has no pointer capture.
      }
    }
    offset = deltaX;
  }

  function onWindowPointerUp(event: PointerEvent): void {
    const current = drag;
    if (current === null || event.pointerId !== current.pointerId) return;
    drag = null;
    if (!current.active) return;
    dragging = false;
    const outcome = resolveSwipeOutcome(offset, resolvedThreshold);
    if (outcome === null) {
      // A short release: the card springs back and nothing is decided.
      offset = 0;
      return;
    }
    decide(outcome, topCardHasFocus() ? 'card' : null);
  }

  function onWindowPointerCancel(event: PointerEvent): void {
    const current = drag;
    if (current === null || event.pointerId !== current.pointerId) return;
    drag = null;
    if (!current.active) return;
    dragging = false;
    offset = 0;
  }
</script>

{#snippet rejectIcon()}<X size={28} strokeWidth={2.25} />{/snippet}
{#snippet laterIcon()}<Clock size={22} strokeWidth={2.25} />{/snippet}
{#snippet acceptIcon()}<Check size={28} strokeWidth={2.25} />{/snippet}

<svelte:window
  onpointermove={onWindowPointerMove}
  onpointerup={onWindowPointerUp}
  onpointercancel={onWindowPointerCancel}
/>

<section
  {...rest}
  bind:this={rootElement}
  class={classNames('cinder-decision-deck', className)}
  aria-label={label}
>
  {#if total > 0}
    <div class="cinder-decision-deck__progress">
      <p id={progressId} class="cinder-decision-deck__progress-text">{progressLabel}</p>
      <div
        class="cinder-decision-deck__progress-track"
        role="progressbar"
        aria-labelledby={progressId}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={decidedCount}
      >
        <span
          class="cinder-decision-deck__progress-fill"
          style:inline-size={`${(decidedCount / total) * 100}%`}
        ></span>
      </div>
    </div>
  {/if}

  {#if pending.length > 0}
    <div class="cinder-decision-deck__stack">
      {#each visibleCards as entry, depth (entry.id)}
        <DecisionDeckCard
          item={entry}
          {depth}
          {offset}
          {dragging}
          acceptStamp={acceptLabel}
          rejectStamp={rejectLabel}
          {acceptOpacity}
          {rejectOpacity}
          {hintId}
          body={card}
          onkeydown={onCardKeydown}
          onpointerdown={onCardPointerDown}
        />
      {/each}
    </div>

    <div class="cinder-decision-deck__actions">
      <div class="cinder-decision-deck__action-cell">
        <Button
          iconOnly
          variant="secondary"
          size="lg"
          class="cinder-decision-deck__action"
          data-decision-action="reject"
          label={rejectLabel}
          leadingIcon={rejectIcon}
          onclick={() => decide('reject', 'reject')}
        />
        <span class="cinder-decision-deck__action-caption" aria-hidden="true">{rejectLabel}</span>
      </div>
      <div class="cinder-decision-deck__action-cell">
        <Button
          iconOnly
          variant="secondary"
          size="lg"
          class="cinder-decision-deck__action"
          data-decision-action="later"
          label={laterLabel}
          leadingIcon={laterIcon}
          onclick={() => decide('later', 'later')}
        />
        <span class="cinder-decision-deck__action-caption" aria-hidden="true">{laterLabel}</span>
      </div>
      <div class="cinder-decision-deck__action-cell">
        <Button
          iconOnly
          variant="secondary"
          size="lg"
          class="cinder-decision-deck__action"
          data-decision-action="accept"
          label={acceptLabel}
          leadingIcon={acceptIcon}
          onclick={() => decide('accept', 'accept')}
        />
        <span class="cinder-decision-deck__action-caption" aria-hidden="true">{acceptLabel}</span>
      </div>
    </div>
  {:else}
    <div class="cinder-decision-deck__empty" tabindex="-1">
      <p class="cinder-decision-deck__empty-title">{emptyTitle}</p>
      <p class="cinder-decision-deck__empty-description">{emptyDescriptionText}</p>
    </div>
  {/if}

  {#if latest !== undefined}
    <div class="cinder-decision-deck__undo">
      <p class="cinder-decision-deck__undo-text">{describe(latest.decision)}</p>
      <Button
        variant="ghost-accent"
        size="sm"
        data-decision-action="undo"
        label={undoLabel}
        onclick={undo}
      />
    </div>
  {/if}

  <p id={hintId} class="cinder-decision-deck__sr-only">{keyboardHint}</p>
  <p class="cinder-decision-deck__sr-only" role="status" aria-live="polite" aria-atomic="true">
    {announcement}
  </p>
</section>
