<script lang="ts">
  /**
   * One memory in the list: its text, how long ago it was learned, and what kind of memory it is.
   * The whole row opens the memory's details, and its time and kind are part of that opener, so a
   * screen reader hears them with the text. Forget and Correct sit beside it and appear when the
   * row is hovered or holds focus (always, on a screen that cannot hover), so neither is behind a
   * second click. The kind carries a sentence in plain words, for a person who did not choose it:
   * a tooltip anchored to the opener, so a keyboard user who focuses the row sees it, and the
   * opener's `aria-describedby` for a screen reader.
   */
  import { Badge, Button, RelativeTime, SelectableRow, Tooltip } from '@lostgradient/cinder';

  import { MEMORY_COPY } from '../../app/copy.ts';
  import type { Memory } from '../../lib/memory-client.ts';
  import { excerpt, formatMemoryTime, highlightSegments, kindOf } from './memory-presentation.ts';

  type Props = {
    memory: Memory;
    /** What the list was searched for, to mark in the text; empty when it is not a search. */
    query: string;
    /** The search's relevance for this memory, or `null` when the list is not a search. */
    score: number | null;
    selected: boolean;
    /** True while a forget is being saved: it is asked once, so the action waits for it. */
    forgetPending: boolean;
    onOpen: (id: string) => void;
    onForget: (id: string) => void;
    onCorrect: (memory: Memory) => void;
  };

  let { memory, query, score, selected, forgetPending, onOpen, onForget, onCorrect }: Props =
    $props();

  const kind = $derived(kindOf(memory));
  const segments = $derived(highlightSegments(memory.content, query));
  const name = $derived(excerpt(memory.content));
  const when = $derived(formatMemoryTime(memory.createdAt));
  /** The row's full text, which says what its actions are for when two excerpts are alike. */
  const textId = $props.id();
  let row = $state<HTMLElement | null>(null);
  /** The row's opener, which the row component renders: the kind's tooltip is anchored to it. */
  let opener = $state<HTMLElement | null>(null);

  $effect(() => {
    opener = row?.querySelector<HTMLElement>('.cinder-selectable-row__primary') ?? null;
  });
</script>

<li class="weft-memory__row" data-memory={memory.id} data-selected={selected} bind:this={row}>
  <SelectableRow
    density="condensed"
    {selected}
    selectedState="current"
    onclick={() => onOpen(memory.id)}
  >
    {#snippet title()}
      <span class="weft-memory__content" id={textId}
        >{#each segments as segment, index (index)}{#if segment.match}<mark
              class="weft-memory__match">{segment.text}</mark
            >{:else}{segment.text}{/if}{/each}</span
      >
    {/snippet}
    {#snippet meta()}
      <span class="weft-memory__facts">
        {#if score !== null}
          <span>{MEMORY_COPY.relevance}: {score.toFixed(2)}</span>
        {/if}
        <RelativeTime class="weft-memory__time" date={memory.createdAt} title={when} />
        <span class="weft-memory__kind">
          <Badge variant="neutral" size="sm">{kind.label}</Badge>
        </span>
      </span>
    {/snippet}
    {#snippet trailingActions()}
      <span class="weft-memory__actions">
        <Button
          variant="ghost"
          size="sm"
          aria-label={MEMORY_COPY.rowAction.correct(name, when)}
          aria-describedby={textId}
          onclick={() => onCorrect(memory)}>{MEMORY_COPY.correct.action}</Button
        >
        <Button
          variant="ghost"
          size="sm"
          disabled={forgetPending}
          aria-label={MEMORY_COPY.rowAction.forget(name, when)}
          aria-describedby={textId}
          onclick={() => onForget(memory.id)}>{MEMORY_COPY.forget.action}</Button
        >
      </span>
    {/snippet}
  </SelectableRow>
  <Tooltip text={kind.description} triggerRef={opener} />
</li>

<style>
  .weft-memory__row {
    display: block;
    list-style: none;
  }

  .weft-memory__content {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .weft-memory__match {
    background: var(--cinder-status-warning-background);
    color: var(--cinder-status-warning-text);
    border-radius: var(--cinder-radius-sm);
  }

  /* The text and its facts share a line on a wide screen, and stack on a narrow one. */
  .weft-memory__row :global(.cinder-selectable-row__body) {
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--cinder-space-1) var(--cinder-space-3);
  }

  .weft-memory__row :global(.cinder-selectable-row__title) {
    flex: 1 1 14rem;
  }

  .weft-memory__row :global(.cinder-selectable-row__meta) {
    flex: 0 0 auto;
    font-size: var(--cinder-text-sm);
  }

  .weft-memory__facts {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--cinder-space-1) var(--cinder-space-3);
    white-space: nowrap;
  }

  .weft-memory__kind {
    display: inline-flex;
  }

  @media (min-width: 40.0625rem) {
    .weft-memory__kind {
      min-inline-size: 5.5rem;
    }
  }

  .weft-memory__actions {
    display: inline-flex;
    gap: var(--cinder-space-1);
    opacity: 0;
  }

  .weft-memory__row:hover .weft-memory__actions,
  .weft-memory__row:focus-within .weft-memory__actions,
  .weft-memory__row[data-selected='true'] .weft-memory__actions {
    opacity: 1;
  }

  /* Where nothing can hover, and where the actions sit under the text, they are always there. */
  @media (hover: none), (max-width: 40rem) {
    .weft-memory__actions {
      opacity: 1;
    }
  }

  /* The actions sit beside the text on a wide screen and under it on a narrow one. */
  @media (max-width: 40rem) {
    .weft-memory__row :global(.cinder-selectable-row--has-trailing-actions) {
      grid-template-columns: minmax(0, 1fr);
      row-gap: 0;
    }

    .weft-memory__row :global(.cinder-selectable-row__primary) {
      padding-block-end: 0;
    }

    .weft-memory__row :global(.cinder-selectable-row__trailing-actions) {
      justify-content: flex-end;
      padding-block-end: var(--cinder-space-2);
    }
  }
</style>
