<script lang="ts" module>
  export type { TableRowProps, TableRowSelectionProps } from './table-row.types.ts';
</script>

<script lang="ts">
  import type { TableRowProps } from './table-row.types.ts';
  import { untrack } from 'svelte';
  import type { Attachment } from 'svelte/attachments';

  import {
    setTableRowColumnsContext,
    tryGetTableContext,
    tryGetTableHeaderSelectionContext,
    tryGetTableSectionContext,
  } from '../table/table.context.ts';
  import { classNames } from '../../utilities/class-names.ts';
  import { devWarn } from '../../utilities/dev-warn.ts';

  let {
    class: className,
    children,
    current = false,
    selected,
    onSelectedChange,
    selectionLabel,
    selectionDisabled,
    ...rest
  }: TableRowProps = $props();

  const table = tryGetTableContext();
  const selectionEnabled = table?.selectionEnabled ?? false;

  // Each Cinder cell in this row claims the next column position as it is created, as wide as its
  // span. After mount the cells read their place from the DOM, and re-read it whenever the row's
  // cells change (a keyed column moved, a conditional cell added), which bumps `cellsVersion`.
  let claimedColumns = 0;
  let cellsVersion = $state(0);
  setTableRowColumnsContext({
    claimColumn: (span = 1) => {
      const position = claimedColumns;
      claimedColumns += Math.max(1, span);
      return position;
    },
    get version() {
      return cellsVersion;
    },
  });
  const watchCells: Attachment<HTMLTableRowElement> = (row) => {
    const observer = new MutationObserver(() => {
      cellsVersion += 1;
    });
    observer.observe(row, { childList: true });
    return () => observer.disconnect();
  };

  const section = tryGetTableSectionContext();
  const headerSelection = tryGetTableHeaderSelectionContext();

  // Validate body rows when selection is enabled. This is a one-time mount-time
  // guard, so the prop reads are untracked.
  if (selectionEnabled && section === 'body') {
    untrack(() => {
      const hasDisabled = selectionDisabled === true;
      if (!hasDisabled) {
        // All three must be present — reject partial trios.
        const hasSelected = selected !== undefined;
        const hasOnChange = onSelectedChange !== undefined;
        const hasLabel = selectionLabel !== undefined;
        if (!hasSelected || !hasOnChange || !hasLabel) {
          throw new Error(
            '[Cinder] TableRow: when Table.selectable is true, each body row must supply ' +
              'selected + onSelectedChange + selectionLabel together, or set selectionDisabled={true}. ' +
              `Missing: ${[!hasSelected && 'selected', !hasOnChange && 'onSelectedChange', !hasLabel && 'selectionLabel'].filter(Boolean).join(', ')}.`,
          );
        }
      }
    });
  }

  // Warn when a row is rendered directly under Table (no section context) with selection on.
  if (selectionEnabled && section === undefined) {
    devWarn(
      '[Cinder] TableRow: rendered outside TableHeader or TableBody while Table.selectable is true. ' +
        'The leading selection cell will not be rendered.',
    );
  }

  function handleSelectAllChange(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    headerSelection?.onSelectAll(input.checked);
  }

  function handleRowChange(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    onSelectedChange?.(input.checked);
  }

  const shouldRenderHeaderSelectionCell =
    selectionEnabled && section === 'header' && headerSelection !== undefined;

  if (shouldRenderHeaderSelectionCell) {
    headerSelection?.claimSelectionHeaderCell();
  }
</script>

<tr
  {...rest}
  class={classNames('cinder-table__row', className)}
  aria-current={current ? 'true' : rest['aria-current']}
  data-cinder-current={current ? '' : undefined}
  {@attach watchCells}
>
  {#if shouldRenderHeaderSelectionCell && headerSelection}
    <th scope="col" class="cinder-table__header-cell cinder-table__header-cell--selection">
      <input
        type="checkbox"
        class="cinder-table__selection-checkbox"
        checked={headerSelection.allSelected}
        aria-label={headerSelection.selectAllLabel}
        onchange={handleSelectAllChange}
        {@attach (node: HTMLInputElement) => {
          $effect(() => {
            node.indeterminate = headerSelection.someSelected && !headerSelection.allSelected;
          });
        }}
      />
    </th>
  {/if}
  {#if selectionEnabled && section === 'body'}
    {#if selectionDisabled}
      <td
        class="cinder-table__cell cinder-table__cell--selection cinder-table__cell--selection-disabled"
      >
        <input
          type="checkbox"
          class="cinder-table__selection-checkbox"
          disabled
          aria-label={selectionLabel ?? 'Selection not allowed for this row'}
        />
      </td>
    {:else}
      <td class="cinder-table__cell cinder-table__cell--selection">
        <input
          type="checkbox"
          class="cinder-table__selection-checkbox"
          checked={selected}
          aria-label={selectionLabel}
          onchange={handleRowChange}
        />
      </td>
    {/if}
  {/if}
  {@render children()}
</tr>
