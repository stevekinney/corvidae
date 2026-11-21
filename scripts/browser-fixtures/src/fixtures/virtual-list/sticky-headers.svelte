<script lang="ts">
  import { VirtualList } from '@lostgradient/cinder';

  type Row = {
    id: string;
    label: string;
    isHeader: boolean;
  };

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
  itemHeight={36}
  height="360px"
  {stickyItems}
  getKey={(row) => row.id}
  aria-label="Grouped list with sticky headers"
>
  {#snippet row(item, context)}
    <div
      class={[
        'virtual-item',
        item.isHeader
          ? 'sticky-header padding-inline-3 background-surface-raised'
          : 'padding-inline-6',
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
    block-size: 36px;
    border-block-end: 1px solid var(--cinder-border);
  }

  .sticky-header {
    font-weight: 600;
  }
</style>
