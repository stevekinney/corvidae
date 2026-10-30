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
  export type { SkeletonProps, SkeletonVariant } from './skeleton.types.ts';
</script>

<script lang="ts">
  import type { SkeletonProps } from './skeleton.types.ts';
  import Button from '../button/button.svelte';
  import { classNames } from '../../utilities/class-names.ts';

  let {
    width,
    height,
    radius,
    class: className,
    lines = 1,
    variant = 'row',
    delay = 0,
    stillLoadingAfter,
    onCancel,
    stillLoadingLabel = 'Still loading…',
    cancelLabel = 'Cancel',
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
  const shape = $derived(variant === 'card' ? 'card' : 'row');
  const grouped = $derived(
    lineCount > 1 || shape === 'card' || stillLoadingThreshold !== undefined,
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

{#if visible}
  {#if grouped}
    <div class={classNames('cinder-skeleton-group', className)} data-cinder-variant={shape}>
      <div class="cinder-skeleton-lines" aria-hidden="true">
        {#if shape === 'card'}
          <div class="cinder-skeleton cinder-skeleton-heading"></div>
        {/if}
        {#each { length: lineCount } as _, index (index)}
          <div
            class="cinder-skeleton"
            data-cinder-last={index === lineCount - 1 && lineCount > 1 && width === undefined
              ? ''
              : undefined}
            {style}
          ></div>
        {/each}
      </div>
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
    </div>
  {:else}
    <div class={classNames('cinder-skeleton', className)} aria-hidden="true" {style}></div>
  {/if}
{/if}
