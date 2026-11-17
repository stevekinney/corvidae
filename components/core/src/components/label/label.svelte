<script lang="ts" module>
  export type { LabelProps } from './label.types.ts';
</script>

<script lang="ts">
  import type { LabelProps } from './label.types.ts';
  import { classNames } from '../../utilities/class-names.ts';

  let {
    for: forId,
    required = false,
    disabled = false,
    class: className,
    children,
    ...rest
  }: LabelProps = $props();
</script>

<label
  for={forId}
  class={classNames('cinder-label', className)}
  data-disabled={disabled || undefined}
  {...rest}
>
  {@render children()}
  {#if required}
    <!-- An empty red dot after the label (_field-label.css). aria-hidden so
         the accessible name stays clean: the field's own
         `required`/`aria-required` attribute is the single AT signal. -->
    <span class="cinder-_required-marker" aria-hidden="true"></span>
  {/if}
</label>
