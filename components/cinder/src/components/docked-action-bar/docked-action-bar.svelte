<script lang="ts" module>
  /**
   * @cinder
   * @category layout
   * @status beta
   * @purpose Bar that docks a page's main actions to the bottom of its scrolling area, above the safe area and the on-screen keyboard, while the page scrolls behind it.
   * @tag docked
   * @tag actions
   * @tag sticky
   * @useWhen Actions must never scroll away: a live run's Send a message and Cancel run, or a review's Deny and Approve on a phone.
   * @useWhen The actions can go off together for one stated reason, such as a dropped connection.
   * @avoidWhen The actions belong to a form inside a dialog or drawer — use the modal or drawer footer.
   * @avoidWhen A banner states a page-level condition — use banner so it sits above the content instead.
   * @rationale Nearest alternative: Drawer footer — a footer belongs to an overlay; the docked bar belongs to the page and scrolls with its container.
   * @related stale-region, toast-region, button
   */
  export type { DockedActionBarProps, DockedActionBarVariant } from './docked-action-bar.types.ts';
</script>

<script lang="ts">
  import { onMount } from 'svelte';

  import { trackKeyboardInset } from '../../_internal/keyboard-inset.ts';
  import { trackDockedBarHeight } from '../../_internal/docked-bar-height.ts';
  import { classNames } from '../../utilities/class-names.ts';
  import StaleRegion from '../stale-region/stale-region.svelte';
  import type { DockedActionBarProps } from './docked-action-bar.types.ts';

  let {
    label = 'Actions',
    variant = 'strip',
    off = false,
    reason,
    equalActions = false,
    class: customClassName,
    children,
    actions,
    ...rest
  }: DockedActionBarProps = $props();

  const reasonId = $props.id();
  const reasonText = $derived(off ? reason?.trim() || undefined : undefined);

  let barElement: HTMLDivElement | undefined = $state();

  // Publish the bar's height so a toast sits above it, and the keyboard's height so the bar rides
  // above the keyboard (rows 04u, 04w).
  onMount(() => trackKeyboardInset());
  $effect(() => {
    if (!barElement) return;
    return trackDockedBarHeight(barElement);
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
  data-cinder-equal-actions={equalActions ? '' : undefined}
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
