<script lang="ts">
  import { VirtualList } from '@lostgradient/cinder';

  type Row = {
    id: string;
    label: string;
    isHeader: boolean;
  };

  /**
   * COR-1523: fixture-only route, not one of the component's public examples. It
   * combines `stickyItems` with `windowScroll`, which no public example does: there
   * the PAGE scrolls, and a header pinning as it leaves the rendered window must not
   * let the page's native scroll anchoring pull it back a row.
   */
  const sectionSize = 25;

  const rows: Row[] = Array.from({ length: 500 }, (_, index) => {
    const isHeader = index % sectionSize === 0;
    return {
      id: `row-${index}`,
      label: isHeader ? `Section ${Math.floor(index / sectionSize)}` : `Item ${index}`,
      isHeader,
    };
  });

  const stickyItems = rows.flatMap((row, index) => (row.isHeader ? [index] : []));
</script>

<VirtualList
  items={rows}
  itemHeight={40}
  windowScroll
  {stickyItems}
  getKey={(row) => row.id}
  aria-label="Window-scrolled grouped list with sticky headers"
>
  {#snippet row(item, context)}
    <div
      style={item.isHeader
        ? 'display: flex; align-items: center; block-size: 40px; padding-inline: 0.75rem; background: var(--cinder-surface-raised); font-weight: 600; border-block-end: 1px solid var(--cinder-border);'
        : 'display: flex; align-items: center; block-size: 40px; padding-inline: 1.5rem; border-block-end: 1px solid var(--cinder-border);'}
      data-index={context.index}
    >
      <span>{item.label}</span>
    </div>
  {/snippet}
</VirtualList>
