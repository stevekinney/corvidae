<script lang="ts" module>
  export type { FocusTrapProps } from './focus-trap.types.ts';
</script>

<script lang="ts">
  import { classNames } from '@lostgradient/foundation/utilities/class-names.ts';

  import type { FocusTrapProps } from './focus-trap.types.ts';
  import { createFocusTrap } from './focus-trap.utilities.svelte.ts';

  let {
    active = true,
    restoreFocus = true,
    initialFocus = null,
    fallbackFocus = null,
    restoreFallback = null,
    preferRestoreFallback = false,
    class: className,
    children,
    ...rest
  }: FocusTrapProps = $props();
</script>

<div
  {@attach createFocusTrap({
    active: () => active,
    restoreFocus,
    initialFocus: () => initialFocus,
    fallbackFocus: () => fallbackFocus,
    restoreFallback: () => restoreFallback,
    preferRestoreFallback: () => preferRestoreFallback,
  })}
  class={classNames(className)}
  {...rest}
>
  {@render children()}
</div>
