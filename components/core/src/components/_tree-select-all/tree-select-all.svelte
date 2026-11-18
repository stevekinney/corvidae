<script lang="ts" module>
  export type { TreeSelectAllProps } from './tree-select-all.types.ts';
</script>

<script lang="ts">
  import type { TreeContext } from '../../_internal/tree-context.ts';
  import { getTreeContext } from '../../_internal/tree-context.ts';
  import { classNames } from '@lostgradient/foundation/utilities/class-names.ts';
  import type { TreeSelectAllProps } from './tree-select-all.types.ts';

  let {
    parentId = null,
    includeDescendants = false,
    label = 'Tree selection',
    selectAllLabel = 'Select all',
    selectNoneLabel = 'Select none',
    class: className,
  }: TreeSelectAllProps = $props();

  const context: TreeContext = getTreeContext();

  const disabled = $derived(
    !context.multiselectable || !context.hasSelectableSelectionScope(parentId, includeDescendants),
  );

  function selectAll(): void {
    if (!disabled) context.selectSelectionScope(parentId, true, includeDescendants);
  }

  function selectNone(): void {
    if (!disabled) context.selectSelectionScope(parentId, false, includeDescendants);
  }
</script>

<div class={classNames('cinder-tree-select-all', className)}>
  <span class="cinder-tree-select-all__label">{label}</span>
  <button
    type="button"
    class="cinder-tree-select-all__button"
    aria-label={`${selectAllLabel}: ${label}`}
    {disabled}
    onclick={selectAll}
  >
    {selectAllLabel}
  </button>
  <button
    type="button"
    class="cinder-tree-select-all__button"
    aria-label={`${selectNoneLabel}: ${label}`}
    {disabled}
    onclick={selectNone}
  >
    {selectNoneLabel}
  </button>
</div>
