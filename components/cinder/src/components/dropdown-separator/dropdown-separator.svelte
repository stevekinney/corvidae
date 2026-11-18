<script lang="ts" module>
  export type { DropdownSeparatorProps } from './dropdown-separator.types.ts';
</script>

<script lang="ts">
  import type { DropdownSeparatorProps } from './dropdown-separator.types.ts';
  import { classNames } from '../../utilities/class-names.ts';

  let { class: customClassName, ...rest }: DropdownSeparatorProps = $props();
</script>

<!--
  `{...rest}` is spread first so the component's own role="separator" — its sole
  semantic purpose — wins against any role a caller passes through their spread.
-->
<div
  {...rest}
  class={classNames('cinder-dropdown-separator', customClassName)}
  role="separator"
></div>
