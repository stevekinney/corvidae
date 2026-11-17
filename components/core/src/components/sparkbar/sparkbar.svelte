<script lang="ts" module>
  /**
   * @cinder
   * @category data-display
   * @status stable
   * @purpose Compact labeled meter with a thin fill bar for inline cost, token, or quota breakdowns, or, given points, a thin trend line with an end dot.
   * @tag sparkbar
   * @tag meter
   * @tag cost
   * @tag sparkline
   * @tag trend
   * @useWhen Comparing several bounded values in dense rows, such as per-step spend, token usage, or budget consumption.
   * @useWhen Showing the shape of one metric over a recent window inside a metric card, with its latest value marked and the window named at each end.
   * @avoidWhen Showing task completion or loading progress. | progress
   * @avoidWhen Rendering a full cartesian chart with axes, scales, or multiple series. | line-chart
   * @related meter, progress, bar-chart
   */
  export type {
    SparkbarBarProps,
    SparkbarLineProps,
    SparkbarProps,
    SparkbarSize,
    SparkbarVariant,
  } from './sparkbar.types.ts';
</script>

<script lang="ts">
  import { chartPaletteColor, resolveChartTheme } from '../../_internal/chart/chart-utilities.ts';
  import { classNames } from '../../utilities/class-names.ts';

  import type { SparkbarProps } from './sparkbar.types.ts';

  let {
    value,
    max = 1,
    label,
    trailing,
    points,
    startLabel,
    endLabel,
    size = 'md',
    variant = 'accent',
    theme,
    ariaLabel,
    ariaValueText,
    class: customClassName,
    ...rest
  }: SparkbarProps = $props();

  // `points` selects the line arm; its absence is the bar arm.
  const isLine = $derived(points !== undefined);
  const effectiveMax = $derived(Number.isFinite(max) && max > 0 ? max : 1);
  const clampedValue = $derived(
    value !== undefined && Number.isFinite(value) ? Math.max(0, Math.min(effectiveMax, value)) : 0,
  );
  const percent = $derived(Math.round((clampedValue / effectiveMax) * 100));
  const normalizedAriaLabel = $derived(ariaLabel?.trim() || undefined);
  const normalizedTrailing = $derived(trailing?.trim() || undefined);
  const normalizedAriaValueText = $derived(ariaValueText?.trim() || undefined);
  const accessibleName = $derived(normalizedAriaLabel ?? `${label}, ${percent}%`);
  const accessibleValueText = $derived(normalizedAriaValueText ?? normalizedTrailing);
  const resolvedTheme = $derived(resolveChartTheme(theme));

  // The line is drawn on a 100 by 100 grid that is stretched to the plot, so its x is a percentage
  // of the width and its y a percentage of the height. The scale runs from the series' lowest to
  // its highest value, kept 12% in from the top and the baseline so the stroke and the end dot are
  // never clipped. A flat series sits on the middle.
  const linePointTop = 12;
  const linePointBottom = 88;
  const linePoints = $derived.by(() => {
    const usable = (points ?? []).filter((point) => Number.isFinite(point));
    if (usable.length < 2) return [];
    const lowest = Math.min(...usable);
    const highest = Math.max(...usable);
    const span = highest - lowest;
    return usable.map((point, index) => ({
      x: (index / (usable.length - 1)) * 100,
      y:
        span === 0
          ? (linePointTop + linePointBottom) / 2
          : linePointBottom - ((point - lowest) / span) * (linePointBottom - linePointTop),
    }));
  });
  const lineEnd = $derived(linePoints.at(-1));
  const lineStartLabel = $derived(startLabel?.trim() || undefined);
  const lineEndLabel = $derived(endLabel?.trim() || undefined);
</script>

{#if isLine}
  <!-- An image, not a meter: a trend has no bounded value, so its name is the whole sentence. -->
  <div
    {...rest}
    class={classNames('cinder-sparkbar', customClassName)}
    role="img"
    aria-label={normalizedAriaLabel ?? label}
    data-cinder-kind="line"
    data-cinder-size={size}
    style:--_cinder-chart-foreground={resolvedTheme.foreground}
    style:--_cinder-chart-muted={resolvedTheme.muted}
    style:--_cinder-chart-background={resolvedTheme.background}
    style:--_cinder-chart-accent={chartPaletteColor(0, resolvedTheme.palette)}
    style:--_cinder-sparkbar-line-color={theme?.palette?.[0]}
  >
    <div class="cinder-sparkbar__plot" aria-hidden="true">
      <svg class="cinder-sparkbar__line" viewBox="0 0 100 100" preserveAspectRatio="none">
        {#if linePoints.length > 0}
          <polyline
            class="cinder-sparkbar__path"
            points={linePoints.map((point) => `${point.x},${point.y}`).join(' ')}
            fill="none"
          />
        {/if}
      </svg>
      {#if lineEnd !== undefined}
        <span class="cinder-sparkbar__endpoint" style:inset-block-start="{lineEnd.y}%"></span>
      {/if}
    </div>
    {#if lineStartLabel !== undefined || lineEndLabel !== undefined}
      <div class="cinder-sparkbar__axis" aria-hidden="true">
        <span class="cinder-sparkbar__axis-start">{lineStartLabel}</span>
        <span class="cinder-sparkbar__axis-end">{lineEndLabel}</span>
      </div>
    {/if}
  </div>
{:else}
  <div
    {...rest}
    class={classNames('cinder-sparkbar', customClassName)}
    role="meter"
    aria-label={accessibleName}
    aria-valuemin={0}
    aria-valuemax={effectiveMax}
    aria-valuenow={clampedValue}
    aria-valuetext={accessibleValueText}
    data-cinder-size={size}
    data-cinder-variant={variant}
    style:--_cinder-chart-foreground={resolvedTheme.foreground}
    style:--_cinder-chart-muted={resolvedTheme.muted}
    style:--_cinder-chart-background={resolvedTheme.background}
    style:--_cinder-chart-accent={chartPaletteColor(0, resolvedTheme.palette)}
    style:--_cinder-sparkbar-track-background={theme?.background ?? 'var(--cinder-surface-inset)'}
  >
    <div class="cinder-sparkbar__row">
      <span class="cinder-sparkbar__label">{label}</span>
      {#if normalizedTrailing}
        <span class="cinder-sparkbar__trailing">{normalizedTrailing}</span>
      {/if}
    </div>
    <div class="cinder-sparkbar__track" aria-hidden="true">
      <div
        class="cinder-sparkbar__fill"
        style:--_cinder-sparkbar-progress={clampedValue / effectiveMax}
      ></div>
    </div>
  </div>
{/if}
