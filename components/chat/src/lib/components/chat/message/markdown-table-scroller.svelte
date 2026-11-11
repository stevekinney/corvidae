<script lang="ts" module>
  export type MarkdownTableScrollerProps = {
    /** The sanitized `<table>` markup the Markdown renderer produced for one table node. */
    html: string;
  };

  /**
   * How many columns of the table's first row lie at least partly outside the scroller's visible
   * span, on either side, so a cue can say how much more there is to see.
   */
  export function countHiddenColumns(scroller: HTMLElement): number {
    const visible = scroller.getBoundingClientRect();
    const firstRow = scroller.querySelector('tr');
    if (firstRow === null) return 0;
    let hidden = 0;
    for (const cell of firstRow.children) {
      const box = cell.getBoundingClientRect();
      if (box.left < visible.left - 1 || box.right > visible.right + 1) hidden += 1;
    }
    return hidden;
  }
</script>

<script lang="ts">
  import type { Attachment } from 'svelte/attachments';

  let { html }: MarkdownTableScrollerProps = $props();

  const cueId = $props.id();

  // Whether the table is wider than its scroller, and whether the scroller is at its inline end.
  // Both are measured, never assumed: a table that fits gets no cue, no region and no tab stop.
  let overflowing = $state(false);
  let atEnd = $state(true);
  let hiddenColumns = $state(0);

  function measure(scroller: HTMLElement): void {
    const isOverflowing = scroller.scrollWidth - scroller.clientWidth > 1;
    overflowing = isOverflowing;
    atEnd =
      !isOverflowing ||
      Math.abs(scroller.scrollLeft) + scroller.clientWidth >= scroller.scrollWidth - 1;
    hiddenColumns = isOverflowing ? Math.max(1, countHiddenColumns(scroller)) : 0;
  }

  /**
   * Measures the scroller whenever it or its table resizes, or it scrolls. Reading `html` makes the
   * attachment run again for new markup, so the new table is the one observed.
   */
  const trackOverflow: Attachment<HTMLElement> = (scroller) => {
    if (html === '' || typeof ResizeObserver === 'undefined') return undefined;
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure(scroller);
      });
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(scroller);
    const table = scroller.querySelector('table');
    if (table !== null) observer.observe(table);
    scroller.addEventListener('scroll', schedule, { passive: true });
    schedule();
    return () => {
      observer.disconnect();
      scroller.removeEventListener('scroll', schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  };
</script>

<div class="message-markdown-table" data-overflowing={overflowing || undefined}>
  {#if overflowing}
    <p class="message-markdown-table-cue" id={cueId} dir="auto">
      <span aria-hidden="true">+{hiddenColumns} {hiddenColumns === 1 ? 'column' : 'columns'}</span>
      <span class="cinder-sr-only">Scroll to see all columns</span>
    </p>
  {/if}
  <div class="message-markdown-table-frame" data-fade-end={overflowing && !atEnd ? '' : undefined}>
    <!-- The scroller is a named, focusable region only while the table overflows, so the arrow
         keys can scroll it; a table that fits adds no landmark and no tab stop. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      class="message-markdown-table-scroller"
      role={overflowing ? 'region' : undefined}
      aria-label={overflowing ? 'Scrollable table' : undefined}
      aria-describedby={overflowing ? cueId : undefined}
      tabindex={overflowing ? 0 : undefined}
      {@attach trackOverflow}
    >
      {#key html}
        {@html html}
      {/key}
    </div>
  </div>
</div>

<style>
  .message-markdown-table {
    display: grid;
    gap: var(--cinder-space-1);
    min-inline-size: 0;
  }

  /* The cue sits outside the cells, at the inline end above the table, so it never covers text. */
  .message-markdown-table-cue {
    justify-self: end;
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--_cinder-chat-text-xs, var(--cinder-text-xs));
    text-align: start;
  }

  /* One hairline container: the table's own outer cell borders are hidden so they do not double it. */
  .message-markdown-table-frame {
    position: relative;
    min-inline-size: 0;
    border: 1px solid var(--cinder-border-muted);
    border-radius: var(--cinder-radius-md);
    overflow: hidden;
  }

  /* A fade at the inline end says the table continues; it clears once the end is in view. */
  .message-markdown-table-frame[data-fade-end]::after {
    content: '';
    position: absolute;
    inset-block: 0;
    inset-inline-end: 0;
    inline-size: var(--cinder-space-8);
    background: linear-gradient(to right, transparent, var(--cinder-surface));
    pointer-events: none;
  }

  .message-markdown-table-frame[data-fade-end]:dir(rtl)::after {
    background: linear-gradient(to left, transparent, var(--cinder-surface));
  }

  .message-markdown-table-scroller {
    overflow-x: auto;
    overscroll-behavior-inline: contain;
  }

  /* The frame clips with `overflow: hidden`, so the ring is painted inset, on the frame's edge. */
  .message-markdown-table-scroller:focus-visible {
    outline: var(--cinder-ring-width) solid transparent;
    box-shadow: inset 0 0 0 var(--cinder-ring-width) var(--cinder-ring-color);
  }

  @media (forced-colors: active) {
    .message-markdown-table-scroller:focus-visible {
      outline: var(--cinder-ring-width) solid ButtonText;
      outline-offset: calc(var(--cinder-ring-width) * -1);
    }
  }

  .message-markdown-table-scroller :global(table) {
    margin: 0;
    border-style: hidden;
  }

  .message-markdown-table-scroller :global(:is(th, td)) {
    white-space: nowrap;
  }

  /* The header row reads as one band across every column. */
  .message-markdown-table-scroller :global(thead th) {
    background: var(--cinder-surface-inset);
    border-block-end-color: var(--cinder-border-strong);
  }

  @media (forced-colors: active) {
    .message-markdown-table-frame[data-fade-end]::after {
      display: none;
    }
  }
</style>
