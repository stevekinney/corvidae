<script lang="ts" module>
  /**
   * @cinder
   * @category feedback
   * @status stable
   * @purpose Decorative placeholder that reserves layout space while real content loads, as a single block or a group of lines or a card, with optional delayed appearance and a "Still loading" status.
   * @tag feedback
   * @tag loading
   * @useWhen Reserving the rough shape of incoming content during an initial fetch to avoid layout shift.
   * @useWhen Indicating progressive load of cards, rows, or media tiles where the final shape is known.
   * @avoidWhen Indicating indeterminate background work without a known target shape — use spinner.
   * @avoidWhen Communicating that a view has no data at all — use empty-state.
   * @related spinner, empty-state, progress
   */
  export type { SkeletonProps, SkeletonStatusMarker, SkeletonVariant } from './skeleton.types.ts';
</script>

<script lang="ts">
  import type { SkeletonProps } from './skeleton.types.ts';
  import Button from '../button/button.svelte';
  import VisuallyHidden from '../visually-hidden/visually-hidden.svelte';
  import { classNames } from '../../utilities/class-names.ts';

  let {
    width,
    height,
    radius,
    class: className,
    lines = 1,
    variant = 'row',
    rows = 3,
    statusMarker = 'bar',
    statusColumn = true,
    framed = true,
    dayBand = false,
    label,
    delay = 0,
    stillLoadingAfter,
    onCancel,
    stillLoadingLabel = 'Still loading. This is taking longer than usual.',
    cancelLabel = 'Cancel',
    children,
  }: SkeletonProps = $props();

  const MAXIMUM_LINES = 20;

  // The timers only ever turn these flags on. A prop change after they fire does not hide
  // the placeholder again: a skeleton that has appeared stays until its owner unmounts it.
  let delayElapsed = $state(false);
  let stillLoadingElapsed = $state(false);

  // A zero (or invalid) delay renders on the first pass, so server rendering and a skeleton
  // without timing props behave exactly as a plain block always has.
  const visible = $derived(!(delay > 0) || delayElapsed);
  // A non-numeric or non-finite threshold means "never", the same as omitting it.
  const stillLoadingThreshold = $derived(
    typeof stillLoadingAfter === 'number' && Number.isFinite(stillLoadingAfter)
      ? Math.max(0, stillLoadingAfter)
      : undefined,
  );
  const stillLoading = $derived(
    stillLoadingThreshold !== undefined && (stillLoadingThreshold === 0 || stillLoadingElapsed),
  );

  $effect(() => {
    const handles: ReturnType<typeof setTimeout>[] = [];
    if (delay > 0) {
      handles.push(
        setTimeout(() => {
          delayElapsed = true;
        }, delay),
      );
    }
    if (stillLoadingThreshold !== undefined && stillLoadingThreshold > 0) {
      handles.push(
        setTimeout(() => {
          stillLoadingElapsed = true;
        }, stillLoadingThreshold),
      );
    }
    return () => {
      for (const handle of handles) clearTimeout(handle);
    };
  });

  // Coerce + clamp at runtime: a consumer can pass 0, NaN, or a fraction despite `number`.
  const lineCount = $derived.by(() => {
    const whole = Math.trunc(Number(lines));
    return Number.isFinite(whole) ? Math.min(MAXIMUM_LINES, Math.max(1, whole)) : 1;
  });
  const shape = $derived(
    variant === 'card' ? 'card' : variant === 'list' ? 'list' : variant === 'form' ? 'form' : 'row',
  );
  const rowCount = $derived.by(() => {
    const whole = Math.trunc(Number(rows));
    return Number.isFinite(whole) ? Math.min(MAXIMUM_LINES, Math.max(1, whole)) : 3;
  });
  /** How many fields a form placeholder draws: `rows`, which defaults to 3 for a list, is 2 here unless it was set. */
  const formRows = $derived(rowCount);
  const grouped = $derived(
    lineCount > 1 ||
      shape !== 'row' ||
      stillLoadingThreshold !== undefined ||
      children !== undefined,
  );

  const style = $derived(
    [
      width !== undefined ? `width: ${width}` : null,
      height !== undefined ? `height: ${height}` : null,
      radius !== undefined ? `border-radius: ${radius}` : null,
    ]
      .filter((part): part is string => part !== null)
      .join('; '),
  );
</script>

{#snippet stillLoadingStatus()}
  {#if stillLoadingThreshold !== undefined}
    <div class="cinder-skeleton-status" role="status">
      {#if stillLoading}
        <span class="cinder-skeleton-status-label">{stillLoadingLabel}</span>
        {#if onCancel}
          <Button variant="ghost" size="sm" label={cancelLabel} onclick={() => onCancel()} />
        {/if}
      {/if}
    </div>
  {/if}
{/snippet}

{#if shape === 'list'}
  <!-- The region is in the DOM from the first pass so its name is announced when the rows
       appear at the end of `delay`, not inserted together with its text. -->
  <div
    class={classNames('cinder-skeleton-group', className)}
    data-cinder-variant="list"
    aria-busy={visible ? 'true' : undefined}
  >
    {#if label}
      <VisuallyHidden role="status">{visible ? label : ''}</VisuallyHidden>
    {/if}
    {#if visible}
      <div
        class="cinder-skeleton-list"
        data-cinder-framed={framed ? undefined : 'false'}
        aria-hidden="true"
      >
        {#if dayBand}
          <div class="cinder-skeleton-day-band">
            <div class="cinder-skeleton cinder-skeleton-day-bar"></div>
          </div>
        {/if}
        {#each { length: rowCount } as _, index (index)}
          <div
            class="cinder-skeleton-row"
            data-cinder-status-column={statusColumn ? undefined : 'none'}
          >
            <div class="cinder-skeleton-row-status">
              <div
                class="cinder-skeleton cinder-skeleton-status-bar"
                data-cinder-marker={statusMarker === 'dot' ? 'dot' : undefined}
              ></div>
            </div>
            <div class="cinder-skeleton-row-text">
              <div class="cinder-skeleton cinder-skeleton-title-bar"></div>
              <div class="cinder-skeleton cinder-skeleton-meta-bar"></div>
            </div>
            <div class="cinder-skeleton-row-time">
              <div class="cinder-skeleton cinder-skeleton-time-bar"></div>
            </div>
          </div>
        {/each}
      </div>
      {@render stillLoadingStatus()}
    {/if}
  </div>
{:else if visible}
  {#if grouped}
    <div
      class={classNames('cinder-skeleton-group', className)}
      data-cinder-variant={children ? 'custom' : shape}
      aria-busy={children ? 'true' : undefined}
    >
      {#if label}
        <VisuallyHidden role="status">{label}</VisuallyHidden>
      {/if}
      {#if children}
        {@render children()}
      {:else}
        <div class="cinder-skeleton-lines" aria-hidden="true">
          {#if shape === 'card'}
            <div class="cinder-skeleton cinder-skeleton-heading"></div>
          {/if}
          {#if shape === 'form'}
            {#each { length: formRows } as _, index (index)}
              <div class="cinder-skeleton cinder-skeleton-field-label"></div>
              <div class="cinder-skeleton cinder-skeleton-field-control"></div>
            {/each}
          {/if}
          {#each { length: shape === 'form' ? 0 : lineCount } as _, index (index)}
            <div
              class="cinder-skeleton"
              data-cinder-last={index === lineCount - 1 && lineCount > 1 && width === undefined
                ? ''
                : undefined}
              {style}
            ></div>
          {/each}
        </div>
      {/if}
      {@render stillLoadingStatus()}
    </div>
  {:else}
    <div class={classNames('cinder-skeleton', className)} aria-hidden="true" {style}></div>
  {/if}
{/if}
