<script lang="ts" module>
  export type { MasonryProps } from './masonry.types.ts';
</script>

<script lang="ts">
  import { classNames } from '@lostgradient/foundation/utilities/class-names.ts';
  import type { MasonryProps } from './masonry.types.ts';

  let {
    columns,
    gap,
    as = 'div',
    class: customClassName,
    children,
    ...rest
  }: MasonryProps = $props();
</script>

<svelte:element
  this={as}
  {...rest}
  class={classNames('cinder-masonry', customClassName)}
  style:--cinder-masonry-columns={columns}
  style:--cinder-masonry-gap={gap}
>
  {@render children?.()}
</svelte:element>
