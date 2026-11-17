<script lang="ts" module>
  export type { DockedActionBarProps, DockedActionBarVariant } from './docked-action-bar.types.ts';
</script>

<script lang="ts">
  import { onMount } from 'svelte';

  import { trackKeyboardInset } from '@lostgradient/foundation/_internal/keyboard-inset.ts';
  import { trackDockedBar } from '@lostgradient/foundation/_internal/docked-bar-height.ts';
  import { classNames } from '@lostgradient/foundation/utilities/class-names.ts';
  import StaleRegion from '../stale-region/stale-region.svelte';
  import type { DockedActionBarProps } from './docked-action-bar.types.ts';

  let {
    label = 'Actions',
    variant = 'strip',
    off = false,
    reason,
    class: customClassName,
    children,
    actions,
    ...rest
  }: DockedActionBarProps = $props();

  const reasonId = $props.id();
  const reasonText = $derived(off ? reason?.trim() || undefined : undefined);

  let barElement: HTMLDivElement | undefined = $state();

  // Track the bar so a toast sits above it while it is docked, and publish the keyboard's height so
  // the bar rides above the keyboard (rows 04u, 04w).
  onMount(() => trackKeyboardInset());
  $effect(() => {
    if (!barElement) return;
    return trackDockedBar(barElement);
  });
</script>

<div
  {...rest}
  bind:this={barElement}
  class={classNames('cinder-docked-action-bar', customClassName)}
  role="group"
  aria-label={label}
  data-cinder-variant={variant === 'card' ? 'card' : 'strip'}
  data-cinder-off={off ? '' : undefined}
>
  <StaleRegion stale={off} describedBy={reasonText ? reasonId : undefined}>
    <div class="cinder-docked-action-bar__row">
      {#if children}
        <div class="cinder-docked-action-bar__content">{@render children()}</div>
      {/if}
      <div class="cinder-docked-action-bar__actions">{@render actions()}</div>
    </div>
  </StaleRegion>
  <!-- Always mounted so a live region exists before the reason arrives and is announced. -->
  <div role="status" class="cinder-docked-action-bar__status">
    {#if reasonText}
      <p id={reasonId} class="cinder-docked-action-bar__reason">{reasonText}</p>
    {/if}
  </div>
</div>
