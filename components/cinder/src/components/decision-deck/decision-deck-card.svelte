<script lang="ts" generics="TItem extends DecisionDeckItem">
  import type { Snippet } from 'svelte';

  import { swipeTransform } from './decision-deck-swipe.ts';
  import type { DecisionDeckItem } from './decision-deck.types.ts';

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
    onkeydown,
    onpointerdown,
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
    onkeydown?: (event: KeyboardEvent) => void;
    onpointerdown?: (event: PointerEvent) => void;
  } = $props();

  const interactive = $derived(depth === 0);
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  class="cinder-decision-card"
  role="group"
  aria-label={item.title}
  aria-describedby={interactive ? hintId : undefined}
  aria-hidden={interactive ? undefined : 'true'}
  aria-keyshortcuts={interactive ? 'ArrowRight ArrowLeft ArrowDown' : undefined}
  inert={!interactive}
  tabindex={interactive ? 0 : undefined}
  data-cinder-decision-card=""
  data-depth={depth}
  data-dragging={interactive && dragging ? '' : undefined}
  style:transform={interactive && offset !== 0 ? swipeTransform(offset) : undefined}
  onkeydown={interactive ? onkeydown : undefined}
  onpointerdown={interactive ? onpointerdown : undefined}
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
