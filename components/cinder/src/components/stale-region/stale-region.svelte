<script lang="ts" module>
  /**
   * @cinder
   * @category feedback
   * @status beta
   * @purpose Wrapper for a page whose data may be old that keeps that data at full contrast and turns off only the controls that change something, each described by why.
   * @tag stale
   * @tag offline
   * @tag inert
   * @useWhen The server is unreachable or a refresh failed and the page keeps showing what it loaded, with a banner above it.
   * @useWhen Turning off a page's writing controls (Edit, Save, Delete, a switch) while its reading controls (links, filters, tabs, Retry) stay live.
   * @avoidWhen Disabling one control for its own reason, such as a missing provider — set aria-disabled on that control and describe it.
   * @avoidWhen Showing the connection state itself — use banner with a connection preset.
   * @rationale Nearest alternative: Banner — Banner says the data is old and why; StaleRegion is what makes the controls under it inert.
   * @related banner, button, toggle, checkbox, select
   */
  export type { StaleRegionProps } from './stale-region.types.ts';
</script>

<script lang="ts">
  import {
    setStaleRegionContext,
    STALE_REGION_DEFAULT_REASON,
  } from '../../_internal/stale-region-context.ts';
  import { classNames } from '../../utilities/class-names.ts';
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
