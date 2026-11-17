<script lang="ts" module>
  export type { SpinnerProps, SpinnerSize, SpinnerVariant } from './spinner.types.ts';
</script>

<script lang="ts">
  import { classNames } from '@lostgradient/foundation/utilities/class-names.ts';
  import type { SpinnerProps } from './spinner.types.ts';

  const {
    size = 'md',
    variant = 'default',
    label = 'Loading',
    class: className,
    ...rest
  }: SpinnerProps = $props();
</script>

<span
  {...rest}
  class={classNames('cinder-spinner', className)}
  role="status"
  aria-label={label}
  data-cinder-size={size}
  data-cinder-variant={variant}
>
  {#if variant === 'arc'}
    <svg class="cinder-spinner__arc" viewBox="0 0 24 24" aria-hidden="true">
      <circle class="cinder-spinner__arc-track" cx="12" cy="12" r="9"></circle>
      <circle class="cinder-spinner__arc-indicator" cx="12" cy="12" r="9"></circle>
    </svg>
  {/if}
  <span class="cinder-spinner__sr-only">{label}</span>
</span>
