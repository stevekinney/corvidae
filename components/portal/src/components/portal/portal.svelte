<script lang="ts" module>
  export type { PortalProps } from './portal.types.ts';
</script>

<script lang="ts">
  import { classNames } from '@lostgradient/foundation/utilities/class-names.ts';

  import type { PortalProps } from './portal.types.ts';
  import { createPortalAttachment, resolvePortalTarget } from './portal.utilities.svelte.ts';

  let {
    target = null,
    disabled = false,
    class: className,
    inheritAttributes = true,
    children,
    ...rest
  }: PortalProps = $props();

  let hasHydrated = $state(false);

  $effect(() => {
    hasHydrated = true;
  });

  const resolvedTarget = $derived(!disabled ? resolvePortalTarget(target) : null);

  const shouldRenderChildren = $derived(disabled || (hasHydrated && resolvedTarget !== null));

  const portalAttachment = createPortalAttachment({
    target: () => target,
    disabled: () => disabled,
    inheritAttributes: () => inheritAttributes,
    explicitAttributes: () => ({
      dir: rest.dir,
      lang: rest.lang,
      dataTheme: rest['data-theme'],
      theme: rest['data-cinder-theme'],
    }),
  });
</script>

<div {@attach portalAttachment} class={classNames(className)} {...rest}>
  {#if shouldRenderChildren}
    {@render children()}
  {/if}
</div>
