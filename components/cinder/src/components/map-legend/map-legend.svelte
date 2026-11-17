<script lang="ts" module>
  export type { MapLegendItem, MapLegendProps } from './map-legend.types.ts';
</script>

<script lang="ts">
  import { classNames } from '../../utilities/class-names.ts';
  import Link from '../link/link.svelte';
  import type { MapLegendProps } from './map-legend.types.ts';

  let { items, label, attribution, class: className, ...rest }: MapLegendProps = $props();
</script>

<section {...rest} class={classNames('cinder-map-legend', className)} aria-label={label}>
  <ul class="cinder-map-legend__items">
    {#each items as item, index (index)}
      <li class="cinder-map-legend__item">
        <span class="cinder-map-legend__swatch" data-state={item.state} aria-hidden="true"></span>
        <span class="cinder-map-legend__label">{item.label}</span>
      </li>
    {/each}
  </ul>
  <p class="cinder-map-legend__attribution">
    {#if attribution}
      {@render attribution()}
    {:else}
      {'© '}<Link href="https://www.openstreetmap.org/copyright">OpenStreetMap</Link
      >{' contributors, '}<Link href="https://opendatacommons.org/licenses/odbl/">ODbL</Link>
    {/if}
  </p>
</section>
