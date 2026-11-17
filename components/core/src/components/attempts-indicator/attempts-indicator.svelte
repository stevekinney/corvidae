<script lang="ts" module>
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
