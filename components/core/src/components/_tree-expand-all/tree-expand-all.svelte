<script lang="ts" module>
  export type { TreeExpandAllProps } from './tree-expand-all.types.ts';
</script>

<script lang="ts">
  import type { TreeContext } from '../../_internal/tree-context.ts';
  import { getTreeContext } from '../../_internal/tree-context.ts';
  import { classNames } from '@lostgradient/foundation/utilities/class-names.ts';
  import type { TreeExpandAllProps } from './tree-expand-all.types.ts';

  let {
    label = 'Tree expansion',
    expandAllLabel = 'Expand all',
    expandOneLevelLabel = 'Expand one level',
    collapseAllLabel = 'Collapse all',
    safetyThreshold = 500,
    class: className,
  }: TreeExpandAllProps = $props();

  const context: TreeContext = getTreeContext();

  const expandDisabled = $derived(context.expandableBranchCount === 0);
  const collapseDisabled = $derived(!context.hasExpandedItems);
  const showSafetyValve = $derived(context.expandableBranchCount > safetyThreshold);

  function expandAll(): void {
    if (!expandDisabled) void context.expandAll();
  }

  function expandOneLevel(): void {
    if (!expandDisabled) context.expandOneLevel();
  }

  function collapseAll(): void {
    if (!collapseDisabled) context.collapseAll();
  }
</script>

<div class={classNames('cinder-tree-expand-all', className)}>
  <span class="cinder-tree-expand-all__label">{label}</span>
  {#if showSafetyValve}
    <button
      type="button"
      class="cinder-tree-expand-all__button"
      aria-label={`${expandOneLevelLabel}: ${label}`}
      disabled={expandDisabled}
      onclick={expandOneLevel}
    >
      {expandOneLevelLabel}
    </button>
  {/if}
  <button
    type="button"
    class="cinder-tree-expand-all__button"
    aria-label={`${expandAllLabel}: ${label}`}
    disabled={expandDisabled}
    onclick={expandAll}
  >
    {expandAllLabel}
  </button>
  <button
    type="button"
    class="cinder-tree-expand-all__button"
    aria-label={`${collapseAllLabel}: ${label}`}
    disabled={collapseDisabled}
    onclick={collapseAll}
  >
    {collapseAllLabel}
  </button>
</div>
