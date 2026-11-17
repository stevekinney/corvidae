<script lang="ts" module>
  export type { StaleRegionProps } from './stale-region.types.ts';
</script>

<script lang="ts">
  import {
    setStaleRegionContext,
    STALE_REGION_DEFAULT_REASON,
  } from '@lostgradient/foundation/_internal/stale-region-context.ts';
  import { classNames } from '@lostgradient/foundation/utilities/class-names.ts';
  import type { StaleRegionProps } from './stale-region.types.ts';

  const {
    stale = true,
    reason = STALE_REGION_DEFAULT_REASON,
    describedBy,
    class: customClassName,
    children,
    ...rest
  }: StaleRegionProps = $props();

  const generatedId = $props.id();
  const ownReasonId = `${generatedId}-reason`;
  const reasonId = $derived(stale ? (describedBy ?? ownReasonId) : undefined);

  // The context carries getters, so a control reads the current state inside its own `$derived`:
  // flipping `stale` turns every opted-in control inert, and back, without remounting it.
  setStaleRegionContext({
    get stale() {
      return stale;
    },
    get reasonId() {
      return reasonId;
    },
  });
</script>

<div
  {...rest}
  class={classNames('cinder-stale-region', customClassName)}
  data-cinder-stale={stale ? '' : undefined}
>
  {#if stale && describedBy === undefined}
    <span id={ownReasonId} class="cinder-sr-only">{reason}</span>
  {/if}
  {@render children()}
</div>
