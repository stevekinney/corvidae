<script lang="ts" module>
  export type {
    AspectRatioElement,
    AspectRatioOverflow,
    AspectRatioProps,
  } from './aspect-ratio.types.ts';
</script>

<script lang="ts">
  import type { AspectRatioProps } from './aspect-ratio.types.ts';
  import { classNames } from '../../utilities/class-names.ts';

  let {
    ratio = '16/9',
    overflow = 'hidden',
    as = 'div',
    class: className,
    children,
    ...rest
  }: AspectRatioProps = $props();

  const ratioValue = $derived(
    typeof ratio === 'string'
      ? ratio
      : Number.isFinite(ratio) && ratio > 0
        ? String(ratio)
        : undefined,
  );
</script>

<svelte:element
  this={as}
  {...rest}
  class={classNames('cinder-aspect-ratio', className)}
  data-cinder-overflow={overflow}
  style:aspect-ratio={ratioValue}
>
  {@render children()}
</svelte:element>
