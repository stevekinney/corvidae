<script lang="ts" module>
  export type { GridListProps } from './grid-list.types.ts';
</script>

<script lang="ts">
  import { default as Grid, type GridProps } from '@lostgradient/grid/components/grid/index.ts';
  import type { GridListProps } from './grid-list.types.ts';
  import { classNames } from '@lostgradient/foundation/utilities/class-names.ts';

  let { minColumnWidth, class: className, children, ...rest }: GridListProps = $props();

  const minWidth = $derived(minColumnWidth && minColumnWidth.length > 0 ? minColumnWidth : '16rem');
  const gridRest = $derived(rest as Omit<GridProps, 'children'>);
</script>

<Grid
  {...gridRest}
  as="ul"
  minItemWidth={minWidth}
  role="list"
  class={classNames('cinder-grid-list', className)}
>
  {@render children()}
</Grid>
