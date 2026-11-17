<script lang="ts" module>
  export type { GridColumns, GridProps } from './grid.types.ts';
</script>

<script lang="ts">
  import { classNames } from '@lostgradient/foundation/utilities/class-names.ts';
  import type { GridProps } from './grid.types.ts';

  let {
    columns,
    gap,
    rowGap,
    columnGap,
    narrowCollapseEnabled = false,
    minItemWidth,
    as = 'div',
    class: customClassName,
    children,
    ...rest
  }: GridProps = $props();

  const resolvedMinItemWidth = $derived(
    typeof minItemWidth === 'string' && minItemWidth.length > 0 ? minItemWidth : undefined,
  );

  const resolvedColumns = $derived.by(() => {
    if (resolvedMinItemWidth) {
      return 'repeat(auto-fill, minmax(min(var(--cinder-grid-min-item-width), 100%), 1fr))';
    }

    if (typeof columns === 'number') {
      if (!Number.isInteger(columns) || columns < 1) return undefined;
      return `repeat(${columns}, minmax(0, 1fr))`;
    }
    if (typeof columns === 'string' && columns.length > 0) return columns;
    return undefined;
  });
</script>

<svelte:element
  this={as}
  {...rest}
  class={classNames('cinder-grid', customClassName)}
  data-cinder-collapse={narrowCollapseEnabled ? '' : undefined}
  style:--cinder-grid-columns={resolvedColumns}
  style:--cinder-grid-row-gap={rowGap ?? gap}
  style:--cinder-grid-column-gap={columnGap ?? gap}
  style:--cinder-grid-min-item-width={resolvedMinItemWidth}
>
  {@render children?.()}
</svelte:element>
