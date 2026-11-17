<script lang="ts" module>
  export type { TableHeaderProps } from './table-header.types.ts';
</script>

<script lang="ts">
  import type { TableHeaderProps } from './table-header.types.ts';
  import { untrack } from 'svelte';

  import {
    setTableHeaderSelectionContext,
    setTableSectionContext,
    tryGetTableContext,
  } from '../table/table.context.ts';
  import { classNames } from '@lostgradient/foundation/utilities/class-names.ts';

  let {
    class: className,
    children,
    allSelected,
    someSelected,
    onSelectAll,
    selectAllLabel = 'Select all rows',
    ...rest
  }: TableHeaderProps = $props();

  const table = tryGetTableContext();
  const selectionEnabled = table?.selectionEnabled ?? false;

  // One-time mount-time guard; read the props untracked.
  if (
    selectionEnabled &&
    untrack(() => allSelected === undefined || someSelected === undefined || !onSelectAll)
  ) {
    throw new Error(
      '[Cinder] TableHeader: `allSelected`, `someSelected`, and `onSelectAll` are required when Table.selectable is true.',
    );
  }

  let hasSelectionHeaderCell = false;

  function claimSelectionHeaderCell(): void {
    if (hasSelectionHeaderCell) {
      throw new Error(
        '[Cinder] TableHeader: Table.selectable supports exactly one TableRow inside TableHeader.',
      );
    }
    hasSelectionHeaderCell = true;
  }

  setTableSectionContext('header');

  setTableHeaderSelectionContext({
    get allSelected() {
      return allSelected ?? false;
    },
    get someSelected() {
      return someSelected ?? false;
    },
    get onSelectAll() {
      return onSelectAll ?? (() => {});
    },
    get selectAllLabel() {
      return selectAllLabel;
    },
    claimSelectionHeaderCell,
  });
</script>

<thead {...rest} class={classNames('cinder-table__header', className)}>
  {@render children()}
</thead>
