<script lang="ts" module>
  export const title = 'Virtualizing against the window';
  export const description =
    "windowScroll windows the list against the page's own scroll position instead of an internal scrolling container. height is ignored, the component renders no scrolling box of its own, and the list takes its full virtual size in normal document flow — starting below whatever content sits above it on the page.";
</script>

<script lang="ts">
  import { VirtualList } from '@lostgradient/cinder';

  type EventRow = {
    id: string;
    label: string;
  };

  const events: EventRow[] = Array.from({ length: 5_000 }, (_, index) => ({
    id: `event-${index}`,
    label: `Event ${index.toLocaleString('en-US')}`,
  }));
</script>

<div style="display: flex; flex-direction: column; gap: 0.75rem;">
  <p style="color: var(--cinder-text-muted); font-size: var(--cinder-text-sm);">
    This paragraph, and everything above the list, is ordinary page content. The list below has no
    height and no overflow of its own — it windows against the PAGE's scroll position, starting
    below whatever content sits above it.
  </p>

  <VirtualList
    items={events}
    itemHeight={36}
    windowScroll
    overscan={4}
    getKey={(event) => event.id}
    aria-label="Workflow events"
  >
    {#snippet row(event, context)}
      <div
        style="display: flex; align-items: center; gap: 0.75rem; block-size: 36px; padding-inline: 0.75rem; border-block-end: 1px solid var(--cinder-border);"
        data-index={context.index}
      >
        <span>{event.label}</span>
      </div>
    {/snippet}
  </VirtualList>
</div>
