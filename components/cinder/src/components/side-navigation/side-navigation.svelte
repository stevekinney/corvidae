<script lang="ts" module>
  export type { SideNavigationProps } from './side-navigation.types.ts';
</script>

<script lang="ts">
  import type { SideNavigationProps } from './side-navigation.types.ts';
  import { classNames } from '../../utilities/class-names.ts';
  import { devWarn } from '../../utilities/dev-warn.ts';

  type SideNavigationRuntimeProps = SideNavigationProps & {
    'aria-label'?: unknown;
    'aria-labelledby'?: unknown;
  };

  let {
    ariaLabel,
    class: className,
    brand,
    primaryAction,
    children,
    'aria-label': _ariaLabelAttribute,
    'aria-labelledby': _ariaLabelledbyAttribute,
    ...rest
  }: SideNavigationRuntimeProps = $props();

  const validatedLabel = $derived.by(() => {
    if (ariaLabel.trim() === '') {
      devWarn('[cinder/SideNavigation] ariaLabel is empty — pass a non-empty ariaLabel.');
      return undefined;
    }
    return ariaLabel;
  });
</script>

<nav class={classNames('cinder-side-navigation', className)} {...rest} aria-label={validatedLabel}>
  {#if brand}
    <div class="cinder-side-navigation__brand">
      {@render brand()}
    </div>
  {/if}
  {#if primaryAction}
    <div class="cinder-side-navigation__primary-action">
      {@render primaryAction()}
    </div>
  {/if}
  <ul class="cinder-side-navigation__list">
    {@render children()}
  </ul>
</nav>
