<script lang="ts">
  import { VirtualList } from '@lostgradient/cinder';

  type Column = {
    id: string;
    label: string;
    isHeader: boolean;
  };

  /**
   * Fixture-only route (COR-376), not one of the component's public examples: it
   * exists purely to isolate the pinned-header clipping regression from
   * `horizontal-sticky-headers`, whose groupSize (10) is denser than the
   * rendered window (viewport + overscan on each side spans roughly 16
   * columns) — a second, equally tall header is therefore always ALSO in flow
   * nearby, which stretches the window's auto cross-size to the right height
   * by coincidence and masks the bug regardless of whether the fix is present.
   * A wider group spacing (40, well past that span) guarantees the pinned
   * header is the ONLY tall row anywhere near the rendered window.
   */
  const groupSize = 40;

  const columns: Column[] = Array.from({ length: 300 }, (_, index) => {
    const isHeader = index % groupSize === 0;
    return {
      id: `column-${index}`,
      label: isHeader ? `Group ${Math.floor(index / groupSize)}` : `Column ${index}`,
      isHeader,
    };
  });

  const stickyItems = columns.flatMap((column, index) => (column.isHeader ? [index] : []));
</script>

<VirtualList
  items={columns}
  itemHeight={120}
  height="480px"
  horizontal
  {stickyItems}
  getKey={(column) => column.id}
  aria-label="Sparsely grouped columns with a sticky header taller than its neighbours"
>
  {#snippet row(item, context)}
    <div
      class={[
        'virtual-item padding-inline-3',
        item.isHeader ? 'sticky-header background-surface-raised' : 'virtual-row',
      ]}
      data-index={context.index}
    >
      <span>{item.label}</span>
    </div>
  {/snippet}
</VirtualList>

<style>
  .virtual-item {
    display: flex;
    align-items: center;
    justify-content: center;
    inline-size: 120px;
    border-inline-end: 1px solid var(--cinder-border);
  }

  .sticky-header {
    block-size: 96px;
    font-weight: 600;
  }

  .virtual-row {
    block-size: 64px;
  }
</style>
