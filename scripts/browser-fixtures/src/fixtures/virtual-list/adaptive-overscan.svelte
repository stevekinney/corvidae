<script lang="ts">
  import { VirtualList } from '@lostgradient/cinder';

  type Row = {
    id: number;
    label: string;
  };

  const rowHeight = 120;
  const rowCount = 5_000;
  const configuredOverscan = 5;

  const rows: Row[] = Array.from({ length: rowCount }, (_, index) => ({
    id: index,
    label: `Row ${index.toLocaleString('en-US')}`,
  }));

  let endReachedCount = $state(0);
  let endReachedVisibleEndIndex = $state(-1);

  // Read straight from the scroll container's own geometry, the same way a
  // reader's eyes would judge "how close to the end am I" — not from anything
  // internal to the component. `rowHeight` is fixed and known here, so this
  // needs nothing the component does not already expose.
  function visibleEndIndex(): number {
    const list = document.querySelector('#adaptive-overscan-example .cinder-virtual-list');
    if (!(list instanceof HTMLElement)) return -1;
    const raw = Math.floor((list.scrollTop + Math.max(0, list.clientHeight - 1)) / rowHeight);
    return Math.min(rowCount - 1, Math.max(0, raw));
  }

  function handleEndReached() {
    endReachedCount += 1;
    endReachedVisibleEndIndex = visibleEndIndex();
  }
</script>

<div id="adaptive-overscan-example" style="display: flex; flex-direction: column; gap: 0.75rem;">
  <p
    style="color: var(--cinder-text-muted); font-size: var(--cinder-text-sm);"
    data-testid="adaptive-overscan-status"
    data-end-reached-count={endReachedCount}
    data-end-reached-visible-end-index={endReachedVisibleEndIndex}
  >
    onEndReached fired {endReachedCount} time(s){endReachedCount > 0
      ? ` — last within ${rowCount - 1 - endReachedVisibleEndIndex} row(s) of the end`
      : ''}
  </p>

  <VirtualList
    items={rows}
    itemHeight={rowHeight}
    adaptiveOverscan
    overscan={configuredOverscan}
    height="400px"
    onEndReached={handleEndReached}
    getKey={(row) => row.id}
    aria-label="Adaptive overscan feed"
  >
    {#snippet row(item, context)}
      <div
        style="display: flex; align-items: center; gap: 0.75rem; block-size: 120px; padding-inline: 0.75rem; border-block-end: 1px solid var(--cinder-border);"
        data-index={context.index}
      >
        <span>{item.label}</span>
      </div>
    {/snippet}
  </VirtualList>
</div>
