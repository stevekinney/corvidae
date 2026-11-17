<script lang="ts" module>
  export type { ContainerElement, ContainerMaxWidth, ContainerProps } from './container.types.ts';
</script>

<script lang="ts">
  import { classNames } from '@lostgradient/foundation/utilities/class-names.ts';

  import type { ContainerProps } from './container.types.ts';

  let {
    maxWidth,
    centered = true,
    padded = true,
    as = 'div',
    class: className,
    children,
    ...rest
  }: ContainerProps = $props();
</script>

<svelte:element
  this={as}
  {...rest}
  class={classNames('cinder-container', className)}
  data-cinder-max-width={maxWidth}
  data-cinder-centered={centered ? '' : undefined}
  data-cinder-padded={padded ? '' : undefined}
>
  {@render children()}
</svelte:element>
