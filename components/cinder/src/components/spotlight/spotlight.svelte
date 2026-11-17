<script lang="ts" module>
  export type { SpotlightProps } from './spotlight.types.ts';
</script>

<script lang="ts">
  import { classNames } from '../../utilities/class-names.ts';
  import StatusDot from '../status-dot/status-dot.svelte';
  import type { SpotlightProps } from './spotlight.types.ts';

  let {
    value,
    status,
    statusLabel,
    caveat,
    action,
    class: className,
    ...rest
  }: SpotlightProps = $props();
</script>

<!-- The action follows the value in the reading order and shares the block that draws the caveat,
     so a Spotlight with neither renders exactly what it always did. -->
<div
  {...rest}
  class={classNames(
    'cinder-spotlight',
    action !== undefined && 'cinder-spotlight--action',
    className,
  )}
>
  {#if status}
    <StatusDot
      class="cinder-spotlight__status"
      {...status ? { status } : {}}
      {...statusLabel ? { label: statusLabel } : {}}
    />
  {/if}
  <p class="cinder-spotlight__value">{value}</p>
  {#if caveat && action}
    <div class="cinder-spotlight__action">{@render action()}</div>
    <p class="cinder-spotlight__caveat">{@render caveat()}</p>
  {:else if caveat}
    <p class="cinder-spotlight__caveat">{@render caveat()}</p>
  {:else if action}
    <div class="cinder-spotlight__action">{@render action()}</div>
  {/if}
</div>
