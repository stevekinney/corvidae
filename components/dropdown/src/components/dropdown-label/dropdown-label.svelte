<script lang="ts" module>
  export type { DropdownLabelProps } from './dropdown-label.types.ts';
</script>

<script lang="ts">
  import type { DropdownLabelProps } from './dropdown-label.types.ts';
  import { classNames } from '@lostgradient/foundation/utilities/class-names.ts';

  let { class: customClassName, children, ...rest }: DropdownLabelProps = $props();
</script>

<!-- {...rest} is spread first so the intrinsic role="presentation" — DropdownLabel's
     sole correct role inside a role="menu" — cannot be overridden by a consumer. -->
<div {...rest} class={classNames('cinder-dropdown-label', customClassName)} role="presentation">
  {#if children}
    {@render children()}
  {/if}
</div>
