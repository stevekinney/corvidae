<script lang="ts">
  import { VirtualList } from '@lostgradient/cinder';

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
      <div class="virtual-column gap-1" data-index={context.index}>
        <strong>{column.label}</strong>
        <span class="text-muted">الفهرس {context.index}</span>
      </div>
    {/snippet}
  </VirtualList>
</div>

<style>
  .virtual-column {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    inline-size: 160px;
    block-size: 12rem;
    border-inline-end: 1px solid var(--cinder-border);
    font-size: var(--cinder-text-sm);
  }
</style>
