<script lang="ts" module>
  /**
   * @cinder
   * @category data-display
   * @status beta
   * @purpose Segmented bar with one segment per allowed attempt, filled for the attempts made, that reads as an image named "2 of 5 attempts".
   * @tag attempts
   * @tag progress
   * @tag segments
   * @useWhen Showing how many of a fixed number of attempts a goal, retry or reconnection has used, beside its count.
   * @useWhen Drawing a neutral attempts bar on a list row's second line, where the word beside it carries the outcome.
   * @avoidWhen Showing continuous progress toward a value — use progress or meter.
   * @avoidWhen Drawing a trend over time — use sparkbar.
   * @rationale Nearest alternative: Progress — AttemptsIndicator draws whole attempts as segments rather than a continuous fill.
   */
  export type {
    AttemptsIndicatorLayout,
    AttemptsIndicatorProps,
    AttemptsIndicatorTone,
  } from './attempts-indicator.types.ts';

  /** The most segments drawn; a larger `allowed` fills this many in proportion. */
  const MAXIMUM_SEGMENTS = 100;
</script>

<script lang="ts">
  import { classNames } from '../../utilities/class-names.ts';
  import type { AttemptsIndicatorProps } from './attempts-indicator.types.ts';

  let {
    made,
    allowed,
    tone = 'neutral',
    layout = 'inline',
    label,
    class: className,
    ...rest
  }: AttemptsIndicatorProps = $props();

  // Counts are whole attempts; anything else (NaN, a negative, a fraction) is read as the nearest
  // whole count at or above zero, so pathological data draws a valid bar instead of throwing.
  const allowedCount = $derived(Number.isFinite(allowed) ? Math.max(0, Math.floor(allowed)) : 0);
  const madeCount = $derived(
    Number.isFinite(made) ? Math.min(allowedCount, Math.max(0, Math.floor(made))) : 0,
  );
  const segmentCount = $derived(Math.min(allowedCount, MAXIMUM_SEGMENTS));
  const filledSegments = $derived(
    allowedCount > MAXIMUM_SEGMENTS
      ? Math.round((madeCount / allowedCount) * MAXIMUM_SEGMENTS)
      : madeCount,
  );
  const segments = $derived(
    Array.from({ length: segmentCount }, (_unused, index) => index < filledSegments),
  );
  const accessibleName = $derived(
    label?.trim() ? label.trim() : `${madeCount} of ${allowedCount} attempts`,
  );
</script>

<span
  {...rest}
  class={classNames('cinder-attempts-indicator', className)}
  data-cinder-tone={tone}
  data-cinder-layout={layout}
  role="img"
  aria-label={accessibleName}
>
  {#each segments as filled, index (index)}
    <span
      class="cinder-attempts-indicator__segment"
      data-cinder-filled={filled ? 'true' : undefined}
      aria-hidden="true"
    ></span>
  {/each}
</span>
