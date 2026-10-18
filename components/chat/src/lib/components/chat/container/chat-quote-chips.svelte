<script lang="ts" module>
  import type { ChatQuote } from './use-chat-quotes.svelte.ts';

  export type ChatQuoteChipsProps = {
    /** The quotes to show, in the order they were added. */
    quotes: readonly ChatQuote[];
    /** Whether the quote limit is reached, which shows `limitNoteId`'s explanation. */
    full: boolean;
    /** The id of the explanation shown at the limit, for other controls to reference. */
    limitNoteId: string;
    /** Called when a chip's Remove button is activated. */
    onremove: (id: string) => void;
    /** Called when the last chip is removed, so focus can move on. */
    onemptied: () => void;
  };
</script>

<script lang="ts">
  import { tick } from 'svelte';
  import { Button, Quote, X } from '@lostgradient/cinder';
  import { MAX_QUOTES, previewQuoteText } from '../utilities/quote-composition.ts';

  let { quotes, full, limitNoteId, onremove, onemptied }: ChatQuoteChipsProps = $props();

  let listElement = $state<HTMLUListElement | null>(null);

  async function handleRemove(id: string, index: number): Promise<void> {
    onremove(id);
    await tick();
    // The chip that held focus is gone: hand focus to the one that took its
    // place, or to the composer once none is left.
    const remaining = listElement?.querySelectorAll<HTMLElement>('[data-quote-remove]');
    if (remaining && remaining.length > 0) {
      remaining[Math.min(index, remaining.length - 1)]?.focus();
      return;
    }
    onemptied();
  }
</script>

<div class="chat-quote-chips">
  <ul bind:this={listElement} class="chat-quote-chip-list" aria-label="Quoted excerpts">
    {#each quotes as quote, index (quote.id)}
      {@const preview = previewQuoteText(quote.text)}
      <li class="chat-quote-chip" data-quote-chip title={quote.text}>
        <Quote class="cinder-icon-xs chat-quote-chip-icon" />
        <span class="chat-quote-chip-text">{preview}</span>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          iconOnly
          label={`Remove quote: ${preview}`}
          data-quote-remove
          onclick={() => void handleRemove(quote.id, index)}
        >
          <X class="cinder-icon-xs" />
        </Button>
      </li>
    {/each}
  </ul>
  {#if full}
    <p id={limitNoteId} class="chat-quote-limit-note">
      Quote limit reached ({MAX_QUOTES}). Remove a quote to add another.
    </p>
  {/if}
</div>

<style>
  .chat-quote-chips {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-1);
    padding-block-end: var(--cinder-space-2);
  }

  .chat-quote-chip-list {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .chat-quote-chip {
    display: inline-flex;
    align-items: center;
    gap: var(--cinder-space-1);
    min-inline-size: 0;
    max-inline-size: 100%;
    padding-block: var(--cinder-space-0-5);
    padding-inline: var(--cinder-space-2) var(--cinder-space-0-5);
    border: 1px solid var(--cinder-border);
    border-radius: var(--cinder-radius-full);
    background: var(--cinder-surface-raised);
    color: var(--cinder-text-default);
    font-size: var(--cinder-text-sm);
  }

  :global(.chat-quote-chip-icon) {
    flex-shrink: 0;
    color: var(--cinder-text-muted);
  }

  .chat-quote-chip-text {
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chat-quote-limit-note {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }
</style>
