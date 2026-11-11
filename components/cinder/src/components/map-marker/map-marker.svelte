<script lang="ts" module>
  /**
   * @cinder
   * @category data-display
   * @status beta
   * @purpose Anchored map pin button with live, idle, selected and cluster states, a visible label so state is never colour alone, and a target of at least 44px.
   * @tag map
   * @tag marker
   * @tag pin
   * @useWhen Placing a place or a group of places on a map you render yourself, with the map library of your choice.
   * @useWhen Showing which pin is selected with a raised pill and a ring.
   * @avoidWhen Showing a status next to text outside a map — use status-dot.
   * @avoidWhen Explaining the marker states — use map-legend.
   * @rationale Nearest alternative: Badge — MapMarker is a focusable pin with a tail that anchors it to a point, not a passive label.
   */
  export type { MapMarkerProps, MapMarkerState } from './map-marker.types.ts';
</script>

<script lang="ts">
  import { classNames } from '../../utilities/class-names.ts';
  import type { MapMarkerProps } from './map-marker.types.ts';

  let { state = 'idle', label, icon, name, class: className, ...rest }: MapMarkerProps = $props();

  const stateWords = { live: 'live', idle: '', selected: 'selected', cluster: 'cluster' } as const;
</script>

<button
  {...rest}
  type="button"
  class={classNames('cinder-map-marker', className)}
  data-state={state}
  aria-label={name}
  aria-pressed={state === 'selected' ? true : undefined}
>
  <span class="cinder-map-marker__body">
    {#if state === 'live'}<span class="cinder-map-marker__dot" aria-hidden="true"></span>{/if}
    {#if icon}<span class="cinder-map-marker__icon" aria-hidden="true">{@render icon()}</span>{/if}
    <span class="cinder-map-marker__label">{label}</span>
    {#if !name && stateWords[state]}<span class="cinder-sr-only">{` ${stateWords[state]}`}</span
      >{/if}
  </span>
  {#if state !== 'cluster'}<span class="cinder-map-marker__anchor" aria-hidden="true"></span>{/if}
</button>
