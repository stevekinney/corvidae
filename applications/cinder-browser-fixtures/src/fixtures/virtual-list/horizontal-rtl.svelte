<script lang="ts">
  import { VirtualList } from '@repo/cinder';

  type Column = {
    id: string;
    label: string;
  };

  const columnWidth = 160;

  const columns: Column[] = Array.from({ length: 3_000 }, (_, index) => ({
    id: `column-${index}`,
    label: `عمود رقم ${index.toLocaleString('ar-EG')}`,
  }));
</script>

<div dir="rtl">
  <VirtualList
    items={columns}
    itemHeight={columnWidth}
    horizontal
    height="480px"
    overscan={4}
    getKey={(column) => column.id}
    aria-label="أعمدة قابلة للتمرير أفقيًا"
  >
    {#snippet row(column, context)}
      <div
        style={`display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.25rem; inline-size: ${columnWidth}px; block-size: 12rem; border-inline-end: 1px solid var(--cinder-border); font-size: var(--cinder-text-sm);`}
        data-index={context.index}
      >
        <strong>{column.label}</strong>
        <span style="color: var(--cinder-text-muted);">الفهرس {context.index}</span>
      </div>
    {/snippet}
  </VirtualList>
</div>
