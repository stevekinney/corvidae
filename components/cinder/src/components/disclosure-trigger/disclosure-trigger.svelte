<script lang="ts" module>
  export type { DisclosureTriggerProps } from './disclosure-trigger.types.ts';
</script>

<script lang="ts">
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import { classNames } from '../../utilities/class-names.ts';
  import type { DisclosureTriggerProps } from './disclosure-trigger.types.ts';

  let { open, controls, children, class: className, ...rest }: DisclosureTriggerProps = $props();
</script>

<button
  {...rest}
  type="button"
  class={classNames('cinder-disclosure-trigger', className)}
  aria-expanded={open}
  aria-controls={controls}
>
  <ChevronRight class="cinder-disclosure-trigger__chevron" aria-hidden="true" />
  <span class="cinder-disclosure-trigger__label">{@render children()}</span>
</button>
