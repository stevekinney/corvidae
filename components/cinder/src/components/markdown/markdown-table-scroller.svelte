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

<div class="cinder-markdown-table" data-overflowing={overflowing || undefined}>
  {#if overflowing}
    <p class="cinder-markdown-table-cue" id={cueId} dir="auto">
      <span aria-hidden="true">+{hiddenColumns} {hiddenColumns === 1 ? 'column' : 'columns'}</span>
      <span class="cinder-sr-only">Scroll to see all columns</span>
    </p>
  {/if}
  <div class="cinder-markdown-table-frame" data-fade-end={overflowing && !atEnd ? '' : undefined}>
    <!-- The scroller is a named, focusable region only while the table overflows, so the arrow
         keys can scroll it; a table that fits adds no landmark and no tab stop. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      class="cinder-markdown-table-scroller"
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
