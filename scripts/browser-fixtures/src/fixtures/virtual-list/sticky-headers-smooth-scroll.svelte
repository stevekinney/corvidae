<script lang="ts">
  import { VirtualList } from '@lostgradient/cinder';

  type Row = {
    id: string;
    label: string;
    isHeader: boolean;
  };

  /**
   * COR-374: fixture-only route, not one of the component's public examples —
   * it exists purely to exercise `stickyItems` and `smoothScroll` together,
   * which no public example combines. A real browser is required at all: the
   * bug this covers only shows up once the component's own `scrollTo({
   * behavior: 'smooth' })` animation is actually running, which happy-dom
   * cannot reproduce (see the component's unit tests for the parts of the
   * fix that ARE reproducible there).
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
  height="360px"
  {stickyItems}
  smoothScroll
  getKey={(row) => row.id}
  aria-label="Grouped list with sticky headers and smooth scrolling"
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
