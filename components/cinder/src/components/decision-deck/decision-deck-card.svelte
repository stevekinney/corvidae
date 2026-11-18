<script lang="ts" generics="TItem extends DecisionDeckItem">
  import type { Snippet } from 'svelte';

  import { swipeTransform } from './decision-deck-swipe.ts';
  import type { DecisionDeckItem, DecisionDeckOutcome } from './decision-deck.types.ts';

  /**
   * One card of a DecisionDeck. Only the top card (depth 0) takes part in the gesture and the
   * keyboard; the cards under it are decorative, inert and hidden from assistive technology.
   */
  let {
    item,
    depth,
    offset = 0,
    dragging = false,
    acceptStamp,
    rejectStamp,
    acceptOpacity = 0,
    rejectOpacity = 0,
    hintId,
    body,
    exit,
    onkeydown,
    onpointerdown,
    onexitend,
  }: {
    item: TItem;
    depth: number;
    offset?: number;
    dragging?: boolean;
    acceptStamp: string;
    rejectStamp: string;
    acceptOpacity?: number;
    rejectOpacity?: number;
    hintId: string;
    body?: Snippet<[TItem]> | undefined;
    /**
     * Set on the copy of a card that has just been decided. The copy is a decoration that plays the
     * exit animation and goes away: it is not a card of the deck, takes no input and is hidden from
     * assistive technology. `offset` is where the card was released.
     */
    exit?: { outcome: DecisionDeckOutcome; direction: 1 | -1 } | undefined;
    onkeydown?: (event: KeyboardEvent) => void;
    onpointerdown?: (event: PointerEvent) => void;
    onexitend?: () => void;
  } = $props();

  const exiting = $derived(exit !== undefined);
  const interactive = $derived(depth === 0 && !exiting);
  // The card leaves toward the side the decision lies on (inline-end for accept, inline-start for
  // reject, down for later), turning a little the way it was dragged.
  const exitX = $derived(exit === undefined || exit.outcome === 'later' ? 0 : exit.direction * 120);
  const exitY = $derived(exit?.outcome === 'later' ? 80 : 0);
  const exitTurn = $derived(exitX === 0 ? 0 : exitX > 0 ? 12 : -12);
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  class="cinder-decision-card"
  role={exiting ? 'presentation' : 'group'}
  aria-label={exiting ? undefined : item.title}
  aria-describedby={interactive ? hintId : undefined}
  aria-hidden={interactive ? undefined : 'true'}
  aria-keyshortcuts={interactive ? 'ArrowRight ArrowLeft ArrowDown' : undefined}
  inert={!interactive}
  tabindex={interactive ? 0 : undefined}
  data-cinder-decision-card={exiting ? undefined : ''}
  data-cinder-decision-exit={exit?.outcome}
  data-depth={exiting ? undefined : depth}
  data-dragging={interactive && dragging ? '' : undefined}
  style:transform={interactive && offset !== 0 ? swipeTransform(offset) : undefined}
  style:--_cinder-decision-exit-from={exiting ? `${offset}px` : undefined}
  style:--_cinder-decision-exit-from-turn={exiting ? `${offset / 20}deg` : undefined}
  style:--_cinder-decision-exit-x={exiting ? `${exitX}%` : undefined}
  style:--_cinder-decision-exit-y={exiting ? `${exitY}%` : undefined}
  style:--_cinder-decision-exit-turn={exiting ? `${exitTurn}deg` : undefined}
  onkeydown={interactive ? onkeydown : undefined}
  onpointerdown={interactive ? onpointerdown : undefined}
  onanimationend={exiting ? onexitend : undefined}
>
  {#if interactive}
    <span
      class="cinder-decision-card__stamp"
      data-stamp="accept"
      aria-hidden="true"
      style:opacity={acceptOpacity}>{acceptStamp}</span
    >
    <span
      class="cinder-decision-card__stamp"
      data-stamp="reject"
      aria-hidden="true"
      style:opacity={rejectOpacity}>{rejectStamp}</span
    >
  {/if}
  {#if body}
    {@render body(item)}
  {:else}
    {#if item.eyebrow}
      <p class="cinder-decision-card__eyebrow">{item.eyebrow}</p>
    {/if}
    <p class="cinder-decision-card__title">{item.title}</p>
    {#if item.description}
      <p class="cinder-decision-card__description">{item.description}</p>
    {/if}
  {/if}
</div>
