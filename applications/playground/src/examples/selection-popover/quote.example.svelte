<script lang="ts" module>
  export const title = 'Quote action with custom actions';
  export const description =
    'The actions snippet replaces the built-in comment flow. Select text to open a Quote action; activating it captures the selection and calls close.';
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import { Button, SelectionPopover, type SelectionPopoverPosition } from '@lostgradient/cinder';

  const popoverId = 'quote-selection-popover';
  let isOpen = $state(false);
  let position = $state<SelectionPopoverPosition | null>(null);
  let selectedText = $state('');
  let quotes = $state<string[]>([]);

  /** A bound reference to the text surface, used to scope selection detection to its subtree. */
  let surfaceElement = $state<HTMLElement | null>(null);

  function getSelectionAnchor(surface: HTMLElement): SelectionPopoverPosition | null {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

    const range = selection.getRangeAt(0);
    if (!surface.contains(range.commonAncestorContainer)) return null;

    const rect =
      Array.from(range.getClientRects()).find((clientRect) => {
        return clientRect.width > 0 && clientRect.height > 0;
      }) ?? range.getBoundingClientRect();

    if (rect.width === 0 && rect.height === 0) return null;

    return {
      x: rect.left + rect.width / 2,
      y: rect.top,
      height: rect.height,
    };
  }

  /**
   * `selectionchange` fires on document, not on elements. Selection tracking stays with the
   * caller: the popover only shows what it is told to show. While focus is inside the popover
   * (it moves to the Quote action when the popover opens) the selection may collapse, so the
   * handler leaves the popover alone.
   */
  onMount(() => {
    function handleSelectionChange(): void {
      if (!surfaceElement) return;

      const popoverElement = document.getElementById(popoverId);
      if (popoverElement?.contains(document.activeElement)) return;

      const anchor = getSelectionAnchor(surfaceElement);
      if (anchor) {
        selectedText = window.getSelection()?.toString().trim() ?? '';
        position = anchor;
        isOpen = true;
      } else {
        isOpen = false;
        position = null;
      }
    }

    document.addEventListener('selectionchange', handleSelectionChange);
    return () => document.removeEventListener('selectionchange', handleSelectionChange);
  });

  function handleClose(): void {
    isOpen = false;
    position = null;
  }

  function quoteSelection(): void {
    if (selectedText) quotes = [...quotes, selectedText];
  }
</script>

<article
  bind:this={surfaceElement}
  style="max-width: 36rem; line-height: 1.6; user-select: text; cursor: text;"
>
  <p style="margin: 0;">
    Select any part of this paragraph. Instead of the comment composer, the popover shows a
    <strong>Quote</strong> action supplied through the <code>actions</code> snippet. Focus moves to
    the action when the popover opens, <kbd>Escape</kbd> or a click outside dismisses it, and the
    <code>close</code> function passed to the snippet closes it from inside.
  </p>
</article>

<SelectionPopover
  id={popoverId}
  open={isOpen}
  {position}
  label="Quote selection"
  onClose={handleClose}
>
  {#snippet actions({ close })}
    <Button
      size="sm"
      variant="ghost"
      label="Quote"
      onclick={() => {
        quoteSelection();
        close();
      }}
    />
  {/snippet}
</SelectionPopover>

{#if quotes.length > 0}
  <section style="margin: 1rem 0 0;" aria-label="Quoted text">
    {#each quotes as quote, index (index)}
      <blockquote
        style="margin: 0 0 0.375rem; padding: 0.5rem 0.75rem; border-inline-start: 3px solid var(--cinder-accent-solid); background: var(--cinder-surface);"
      >
        {quote}
      </blockquote>
    {/each}
  </section>
{/if}
