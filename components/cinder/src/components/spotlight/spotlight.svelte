<script lang="ts" module>
  /**
   * @cinder
   * @category data-display
   * @status beta
   * @purpose The one focal value of a screen, set at display size in neutral text, with an optional liveness dot and a caveat line for staleness directly under it.
   * @tag focal
   * @tag value
   * @tag display
   * @useWhen Giving a screen one value to read first, such as a deadline or the number of items that need you.
   * @useWhen Showing that a value may be stale with a caveat directly under it.
   * @avoidWhen Showing several metrics side by side — use statistic-group.
   * @avoidWhen Showing a metric with a label and a change indicator — use statistic.
   * @rationale Nearest alternative: Statistic — Spotlight is a single neutral focal value with no label, tile or change indicator.
   */
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
