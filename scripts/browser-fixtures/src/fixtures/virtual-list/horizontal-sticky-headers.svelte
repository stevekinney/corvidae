<script lang="ts">
  import { VirtualList } from '@corvidae/cinder';

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
      style={item.isHeader
        ? 'display: flex; align-items: center; justify-content: center; inline-size: 120px; block-size: 96px; padding-inline: 0.75rem; background: var(--cinder-surface-raised); font-weight: 600; border-inline-end: 1px solid var(--cinder-border);'
        : 'display: flex; align-items: center; justify-content: center; inline-size: 120px; block-size: 64px; padding-inline: 0.75rem; border-inline-end: 1px solid var(--cinder-border);'}
      data-index={context.index}
    >
      <span>{item.label}</span>
    </div>
  {/snippet}
</VirtualList>
