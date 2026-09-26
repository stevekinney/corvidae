<script lang="ts">
  import { VirtualList } from '@lostgradient/cinder';

  type Row = {
    id: number;
    label: string;
  };

  /**
   * Fixture-only route (COR-376), not one of the component's public examples: it
   * exists purely to make the adaptive-overscan velocity-to-row conversion's
   * measured-vs-estimate divergence observable from a browser test.
   *
   * `itemHeight` below (5) is 18x smaller than what every row actually measures
   * (90): the conversion is supposed to divide by the MEASURED size once
   * `dynamicSize` has one, not the estimate, and driving fast scroll through a
   * range already primed with real measurements is what makes that distinction
   * observable — dividing a given pixel distance by 5 instead of 90 asks for
   * roughly 18x as many rows, which at a moderate scroll speed is the
   * difference between staying well under the adaptive ceiling and saturating
   * it.
   */
  const measuredRowHeight = 90;
  const rowCount = 400;

  const rows: Row[] = Array.from({ length: rowCount }, (_, index) => ({
    id: index,
    label: `Row ${index}`,
  }));
</script>

<div id="adaptive-overscan-dynamic-size-example">
  <VirtualList
    items={rows}
    itemHeight={5}
    dynamicSize
    adaptiveOverscan
    overscan={3}
    height="300px"
    getKey={(row) => row.id}
    aria-label="Adaptive overscan feed with measured rows"
  >
    {#snippet row(item, context)}
      <div style={`block-size: ${measuredRowHeight}px;`} data-index={context.index}>
        {item.label}
      </div>
    {/snippet}
  </VirtualList>
</div>
