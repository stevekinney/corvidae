<script lang="ts" module>
  export type { TableHeaderCellProps } from './table-header-cell.types.ts';
</script>

<script lang="ts">
  import type { Attachment } from 'svelte/attachments';
  import { untrack } from 'svelte';

  import type { TableHeaderCellProps } from './table-header-cell.types.ts';

  import { getTableContext, tryGetTableRowColumnsContext } from '../table/table.context.ts';
  import { columnOf, spanOf } from '../table/table-column.ts';
  import { classNames } from '../../utilities/class-names.ts';

  let {
    column,
    sortable = false,
    scope = 'col',
    align = 'left',
    sizing,
    label,
    class: className,
    children,
    actions,
    ...rest
  }: TableHeaderCellProps = $props();

  const table = getTableContext();

  // The column's `sizing` reaches the body cells under this header through the table. It is
  // declared as the cell is created, before the body cells are, so the server's HTML carries it;
  // after mount the cell keeps it current at its DOM position.
  const owner = {};
  const rowColumns = tryGetTableRowColumnsContext();
  // Claimed once, as the cell is created; later moves are read from the DOM.
  let columnPosition = $state(untrack(() => rowColumns?.claimColumn(spanOf(rest.colspan)) ?? -1));
  untrack(() => {
    if (sizing !== undefined) table.setColumnSizing?.(columnPosition, sizing, owner);
    if (label !== undefined) table.setColumnLabel?.(columnPosition, label, owner);
  });
  $effect(() => {
    const position = columnPosition;
    const value = sizing;
    table.setColumnSizing?.(position, value, owner);
    return () => table.setColumnSizing?.(position, undefined, owner);
  });
  // The column's label reaches its body cells the same way, so a stacked cell prints it from the
  // server's HTML on (COR-2771).
  $effect(() => {
    const position = columnPosition;
    const value = label;
    table.setColumnLabel?.(position, value, owner);
    return () => table.setColumnLabel?.(position, undefined, owner);
  });
  // Re-read whenever the row's cells change, so a keyed column that moves takes its sizing along.
  const placeColumn: Attachment<HTMLTableCellElement> = (cell) => {
    void rowColumns?.version;
    columnPosition = columnOf(cell);
  };

  // A column is only actually sortable when both `sortable` is set and a `column`
  // identifier is supplied — the inner <button> renders under that same guard.
  // Without it we would advertise a sortable-but-unsorted column to assistive
  // technology (`aria-sort="none"`, `data-cinder-sortable`) with no operable
  // control behind it.
  const isSortable = $derived(sortable && !!column);

  // aria-sort lives on the <th> per WAI-ARIA. The accessible name and
  // keyboard activation live on the inner <button> when sortable.
  const ariaSort = $derived(
    isSortable && table.sort?.column === column
      ? table.sort?.direction
      : isSortable
        ? 'none'
        : undefined,
  );
  const nextSortDescription = $derived(
    ariaSort === 'ascending' ? 'Activate to sort descending' : 'Activate to sort ascending',
  );
  const sortButtonDescriptionAttributes = $derived({
    'aria-description': nextSortDescription,
  });

  function handleClick(): void {
    if (!sortable || !column) return;
    table.onSortChange(column);
  }
</script>

<!-- A `fit` table's parts carry their table roles in the server's HTML (COR-2771). -->
<th
  {...rest}
  {...table.fit === true ? { role: 'columnheader' } : {}}
  {scope}
  class={classNames('cinder-table__header-cell', className)}
  data-cinder-align={align}
  data-cinder-sortable={isSortable || undefined}
  data-cinder-sizing={sizing}
  data-cinder-label={label}
  aria-sort={ariaSort}
  {@attach placeColumn}
>
  <div class="cinder-table__header-content">
    {#if isSortable}
      <button
        {...sortButtonDescriptionAttributes}
        type="button"
        class="cinder-table__sort-button"
        onclick={handleClick}
      >
        {@render children()}
        <span
          class="cinder-table__sort-indicator"
          aria-hidden="true"
          data-cinder-direction={ariaSort}
        >
          <svg
            viewBox="0 0 16 16"
            width="12"
            height="12"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <!--
              CIN-127: the two chevrons' flat ends sit 6 viewBox units apart, not 4.
              Round caps at stroke-width 2 grow each polyline by 1 unit past its
              endpoints, so a 4-unit endpoint gap left only 2 units of visible ink
              gap — about 1.5px at the 12px render size, which read as one smudge
              rather than two marks. 6 units leaves 4 units of gap (~3px).
              Ink now spans y=0..16, flush with the viewBox but inside it.
            -->
            <polyline class="cinder-table__sort-chevron-up" points="4 5 8 1 12 5" />
            <polyline class="cinder-table__sort-chevron-down" points="4 11 8 15 12 11" />
          </svg>
        </span>
      </button>
    {:else}
      {@render children()}
    {/if}
    {#if actions}
      <div class="cinder-table__header-actions">{@render actions()}</div>
    {/if}
  </div>
</th>
