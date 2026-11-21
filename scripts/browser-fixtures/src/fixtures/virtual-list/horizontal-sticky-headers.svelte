<script lang="ts">
  import { VirtualList } from '@lostgradient/cinder';

  type Column = {
    id: string;
    label: string;
    isHeader: boolean;
  };

  const groupSize = 10;

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
  height="720px"
  horizontal
  {stickyItems}
  getKey={(column) => column.id}
  aria-label="Grouped columns with sticky headers"
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
